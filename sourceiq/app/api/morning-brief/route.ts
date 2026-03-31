// app/api/morning-brief/route.ts — GET /api/morning-brief → MorningBrief
// Also triggered by Vercel cron at 07:00 UTC daily (vercel.json).
import { NextResponse } from 'next/server';
import { initializeApp, riskStore, tariffStore, inventoryStore, foundryClient } from '../../../src/lib/startup';
import { ALERT_EMAIL_TO, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } from '../../../src/lib/env';
import { estimateAltUnitCost } from '../../../src/lib/costIndex';
import { effectiveCost } from '../../../src/tools/costCalculator';
import { cache, TTL, SWR } from '../../../src/lib/cache';
import type { CacheTag } from '../../../src/lib/cache';
import type { MorningBrief, MorningBriefItem, AgentDecision, BriefDelta } from '../../../src/types/index';
import nodemailer from 'nodemailer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_KEY = 'morning-brief';
const PREV_CACHE_KEY = 'morning-brief:prev';
const BRIEF_TTL = { ttlMs: TTL.SHORT, swrMs: SWR.SHORT, tags: ['brief', 'risk'] as CacheTag[] };

export async function GET(request: Request): Promise<NextResponse> {
  try {
    await initializeApp();

    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.has('bust');
    if (!forceRefresh && (cache.hasFresh(CACHE_KEY) || cache.hasStale(CACHE_KEY))) {
      return NextResponse.json(cache.get<MorningBrief>(CACHE_KEY)!);
    }

    const [allItems, allRates] = await Promise.all([
      inventoryStore.getAll(),
      tariffStore.getAllRates(),
    ]);

    // Derive monitored countries dynamically from inventory — no hardcoding needed.
    // Group items by source country in one pass so we avoid N getByCountry() calls.
    const itemsByCountry = new Map<string, typeof allItems>();
    for (const item of allItems) {
      const bucket = itemsByCountry.get(item.currentSourceCountry) ?? [];
      bucket.push(item);
      itemsByCountry.set(item.currentSourceCountry, bucket);
    }
    const monitoredCountries = Array.from(itemsByCountry.keys());

    // Fetch SRI + alerts for all sourcing countries in parallel
    const countryData = await Promise.all(
      monitoredCountries.map(async country => {
        const [sri, alerts] = await Promise.all([
          riskStore.getSriForCountry(country),
          riskStore.getConflictAlerts(country),
        ]);
        return { country, sri, alerts, items: itemsByCountry.get(country) ?? [] };
      }),
    );

    const criticalAlerts: MorningBriefItem[] = [];
    const savingsOpportunities: MorningBriefItem[] = [];
    const affectedSkuSet = new Set<string>();

    // Pre-fetch tariff comparisons for all distinct HS codes in one pass
    // to avoid O(n²) per-item queries inside the loop below.
    const distinctHsCodes = new Set(allItems.map(i => i.hsCode));
    const altRatesMap = new Map<string, Awaited<ReturnType<typeof tariffStore.compareCountries>>>();
    await Promise.all(
      Array.from(distinctHsCodes).map(async hs => {
        altRatesMap.set(hs, await tariffStore.compareCountries(hs));
      }),
    );

    for (const { country, sri, alerts, items } of countryData) {
      if (!sri) continue;

      // Risk escalation alerts — ONE per country (not per SKU), with manufacturing-cost-aware best alt
      if (sri.tier === 'critical' || sri.tier === 'high') {
        const skuList = items.map(i => i.sku);
        for (const i of items) affectedSkuSet.add(i.sku);

        // Find best alternative across all HS codes for this country
        let bestAltCountry: string | undefined;
        let bestAltRate = Infinity;
        for (const item of items) {
          const altRates = altRatesMap.get(item.hsCode) ?? [];
          for (const r of altRates) {
            if (r.country === country) continue;
            const altUnit = estimateAltUnitCost(item.unitCostUSD, country, r.country, item.category);
            const altLanded = effectiveCost(altUnit, r.rate);
            if (altLanded < bestAltRate) {
              bestAltRate = altLanded;
              bestAltCountry = r.country;
            }
          }
        }

        // Deduplicate alerts — pick the most specific, skip generic GDELT noise
        const uniqueAlerts = alerts.filter((a, i, arr) =>
          arr.findIndex(b => b.message === a.message) === i,
        );
        const cleanHeadline = uniqueAlerts.length > 0
          ? uniqueAlerts[0]!.message.split('|')[0]!.trim()   // strip " | Economy and Business" suffix
          : `${country} risk level: ${sri.tier.toUpperCase()} (SRI ${sri.score})`;

        criticalAlerts.push({
          sku: skuList.join(', '),
          affectedCountry: country,
          alertType: 'risk-escalation',
          severity: sri.tier === 'critical' ? 'critical' : 'high',
          headline: `${cleanHeadline} — ${items.length} SKUs affected`,
          recommendedAction: bestAltCountry
            ? `Evaluate moving ${items.length} SKU${items.length > 1 ? 's' : ''} to ${bestAltCountry}`
            : 'Review alternative sourcing options',
          potentialSavingsUSD: undefined,
        });
      }

      // Tariff-based savings opportunities (manufacturing-cost-aware)
      for (const item of items) {
        const currentRate = allRates.find(
          (r: { country: string; hsCode: string; rate: number }) => r.country === country && r.hsCode === item.hsCode,
        )?.rate ?? 0;

        const currentCost = effectiveCost(item.unitCostUSD, currentRate);

        // Find truly cheapest alternative by realistic landed cost
        const altRates = altRatesMap.get(item.hsCode) ?? [];
        const bestAlt = altRates
          .filter(r => r.country !== country)
          .map(r => {
            const altUnitCost = estimateAltUnitCost(item.unitCostUSD, country, r.country, item.category);
            const altLanded = effectiveCost(altUnitCost, r.rate);
            return { ...r, altLanded };
          })
          .sort((a, b) => a.altLanded - b.altLanded)[0];

        if (!bestAlt || bestAlt.altLanded >= currentCost) continue;

        const savings = Math.round((currentCost - bestAlt.altLanded) * item.annualVolume);
        if (savings <= 0) continue;

        affectedSkuSet.add(item.sku);
        savingsOpportunities.push({
          sku: item.sku,
          affectedCountry: country,
          alertType: 'tariff-change',
          severity: savings > 50_000 ? 'high' : savings > 10_000 ? 'medium' : 'low',
          headline: `${country} landed $${currentCost.toFixed(2)} vs ${bestAlt.country} $${bestAlt.altLanded.toFixed(2)}`,
          recommendedAction: `Switch ${item.sku} to ${bestAlt.country} — save $${savings.toLocaleString()}/yr`,
          potentialSavingsUSD: savings,
        });
      }
    }

    // Sort: critical alerts by severity, savings by amount DESC
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    criticalAlerts.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));
    savingsOpportunities.sort((a, b) => (b.potentialSavingsUSD ?? 0) - (a.potentialSavingsUSD ?? 0));

    const totalSavings = savingsOpportunities.reduce((s, o) => s + (o.potentialSavingsUSD ?? 0), 0);

    // AI-generated executive summary — concise, actionable, grounded in real data
    // Structured fallback used when Foundry is unavailable — always shows something useful
    const topSaving = savingsOpportunities[0];
    const fallbackSummary = criticalAlerts.length > 0
      ? `${criticalAlerts.length} risk alert${criticalAlerts.length > 1 ? 's' : ''} today: ${criticalAlerts.map(a => `${a.affectedCountry} (${a.severity})`).join(', ')} — ${affectedSkuSet.size} SKUs flagged. ` +
        `$${totalSavings.toLocaleString()}/yr savings identified across ${savingsOpportunities.length} opportunities.` +
        (topSaving ? ` Top: ${topSaving.sku} from ${topSaving.affectedCountry} saves $${(topSaving.potentialSavingsUSD ?? 0).toLocaleString()}/yr.` : '')
      : 'No critical alerts today. Supply chain looks stable.';

    let aiSummary: string = fallbackSummary;
    try {
      // Summarize risk levels by country (not raw headlines) — include ALL alerts
      const riskDetails = criticalAlerts.map(
        a => `${a.affectedCountry}: ${a.severity} risk — ${a.recommendedAction}`
      ).join('. ');
      const topSavingsText = savingsOpportunities.slice(0, 3).map(
        o => `${o.sku} (${o.affectedCountry}): save $${(o.potentialSavingsUSD ?? 0).toLocaleString()}/yr`
      ).join('; ');

      // Pattern matches world-brief: system = short behavior, user = data context
      const systemMsg = `You are a supply chain risk analyst writing a morning standup brief for retail buyers. Be concise, specific, and actionable. Name countries, SKU IDs, and dollar amounts. Write in plain prose — no bullet points, no sentence labels, no markdown.`;

      const userMsg = [
        `[MORNING SOURCING DATA — ${new Date().toDateString()}]`,
        `Risk alerts: ${criticalAlerts.length} countries flagged (${criticalAlerts.map(a => a.affectedCountry).join(', ')}) — ${affectedSkuSet.size} SKUs impacted total.`,
        riskDetails ? `Details: ${riskDetails}.` : '',
        `Savings: $${totalSavings.toLocaleString()}/yr across ${savingsOpportunities.length} SKU switching opportunities.`,
        topSavingsText ? `Top 3: ${topSavingsText}.` : '',
        `[END DATA]`,
        ``,
        `Write a 2-3 sentence executive brief covering: (1) which countries are at risk and how many SKUs, (2) top dollar savings opportunity, (3) one recommended action.`,
      ].filter(Boolean).join('\n');

      const generated = await foundryClient.chat(
        [{ role: 'user', content: userMsg }],
        systemMsg,
      );
      if (generated && generated.trim().length > 20) aiSummary = generated.trim();
    } catch (err) {
      console.warn('[morning-brief] AI summary skipped, using fallback:', err);
    }

    // ── Decision Queue — rank actionable decisions by urgency score ────────────
    // urgencyScore = sriScore * (1 + savingsUSD / max(1, totalPortfolioValue))
    // This surfaces decisions where both risk AND financial impact are high.
    const totalPortfolioValue = Math.max(1, totalSavings);
    const decisions: AgentDecision[] = [];

    // Risk-driven decisions — one per critical/high country
    for (const alert of criticalAlerts) {
      const cData = countryData.find(c => c.country === alert.affectedCountry);
      const sri = cData?.sri;
      if (!sri) continue;
      const sriScore = sri.score;
      // Estimate risk-avoidance value: sum of annual spend for affected SKUs
      const affectedItems = cData?.items ?? [];
      const riskAvoidanceUSD = affectedItems.reduce((sum, item) => {
        const rate = allRates.find(r => r.country === item.currentSourceCountry && r.hsCode === item.hsCode)?.rate ?? 0;
        return sum + effectiveCost(item.unitCostUSD, rate) * item.annualVolume;
      }, 0);
      const urgencyScore = Math.min(100, Math.round(
        sriScore * (1 + riskAvoidanceUSD / totalPortfolioValue),
      ));
      const skuCount = affectedItems.length;
      decisions.push({
        id: `risk-${alert.affectedCountry}`,
        type: 'risk',
        country: alert.affectedCountry,
        urgencyScore,
        headline: `${alert.affectedCountry} — ${skuCount} SKU${skuCount !== 1 ? 's' : ''} at ${alert.severity} risk`,
        rationale: `SRI ${sriScore}/100 (${sri.tier}): ${alert.headline.split('—')[0]!.trim()}`,
        prebuiltQuery: `Compare alternative sourcing countries vs ${alert.affectedCountry} for my ${skuCount} affected SKU${skuCount !== 1 ? 's' : ''} — show tariff rates, risk scores, and best switch recommendations`,
        estimatedImpactUSD: Math.round(riskAvoidanceUSD),
        sriScore,
        severity: alert.severity === 'critical' ? 'critical' : 'high',
      });
    }

    // Savings-driven decisions — top opportunities by savings amount
    for (const opp of savingsOpportunities.slice(0, 6)) {
      const sriEntry = countryData.find(c => c.country === opp.affectedCountry)?.sri;
      const sriScore = sriEntry?.score ?? 30;
      const savings = opp.potentialSavingsUSD ?? 0;
      const urgencyScore = Math.min(100, Math.round(
        (savings / Math.max(1, totalPortfolioValue)) * 100 + sriScore * 0.3,
      ));
      const altCountry = opp.recommendedAction.match(/to ([A-Za-z ]+) —/)?.[1]?.trim() ?? 'an alternative country';
      decisions.push({
        id: `savings-${opp.sku}-${opp.affectedCountry}`,
        type: 'savings',
        country: opp.affectedCountry,
        sku: opp.sku,
        urgencyScore,
        headline: `${opp.sku} → ${altCountry} saves $${savings.toLocaleString()}/yr`,
        rationale: `Current sourcing from ${opp.affectedCountry}: ${opp.headline}`,
        prebuiltQuery: `Compare tariff rates and switching costs for ${opp.sku} from ${opp.affectedCountry} — show all alternative countries ranked by landed cost and annual savings`,
        estimatedImpactUSD: savings,
        sriScore,
        severity: savings > 50_000 ? 'high' : 'medium',
      });
    }

    // Sort: urgencyScore DESC, then critical before high before medium
    const sevOrd: Record<string, number> = { critical: 0, high: 1, medium: 2 };
    decisions.sort((a, b) =>
      b.urgencyScore - a.urgencyScore || (sevOrd[a.severity] ?? 2) - (sevOrd[b.severity] ?? 2),
    );

    // ── Delta computation — diff against previous brief ────────────────────
    const prevBrief = cache.get<MorningBrief>(PREV_CACHE_KEY);
    let delta: BriefDelta;
    if (!prevBrief) {
      delta = { hasDelta: false, newAlerts: [], resolved: [], escalated: [], deEscalated: [], newOpportunities: [] };
    } else {
      const prevHighRisk = new Set(prevBrief.criticalAlerts.map(a => a.affectedCountry));
      const currHighRisk = new Set(criticalAlerts.map(a => a.affectedCountry));
      const prevOppKeys  = new Set(prevBrief.savingsOpportunities.map(o => `${o.sku}:${o.affectedCountry}`));

      // Countries newly at risk (not in prev high-risk set)
      const newAlerts = [...currHighRisk].filter(c => !prevHighRisk.has(c));
      // Countries that resolved (were high-risk, now not)
      const resolved  = [...prevHighRisk].filter(c => !currHighRisk.has(c));
      // New savings opportunities not present in previous brief
      const newOpportunities = savingsOpportunities
        .filter(o => !prevOppKeys.has(`${o.sku}:${o.affectedCountry}`))
        .map(o => o.sku);

      // Tier changes — compare SRI tiers for countries that appear in both briefs
      const escalated: BriefDelta['escalated'] = [];
      const deEscalated: BriefDelta['deEscalated'] = [];
      const tierOrder = ['safe', 'elevated', 'high', 'critical'];
      for (const cd of countryData) {
        if (!cd.sri) continue;
        const currTier = cd.sri.tier;
        // Find this country's tier in the previous brief's alerts/data
        const prevAlert = prevBrief.criticalAlerts.find(a => a.affectedCountry === cd.country);
        const prevSriTier = prevAlert
          ? (prevAlert.severity === 'critical' ? 'critical' : 'high')
          : 'safe'; // was not in previous alert list → treat as safe/elevated
        if (currTier === prevSriTier) continue;
        const currIdx = tierOrder.indexOf(currTier);
        const prevIdx = tierOrder.indexOf(prevSriTier);
        if (currIdx > prevIdx) {
          escalated.push({ country: cd.country, from: prevSriTier, to: currTier });
        } else {
          deEscalated.push({ country: cd.country, from: prevSriTier, to: currTier });
        }
      }

      delta = {
        hasDelta: true,
        previousGeneratedAt: prevBrief.generatedAt,
        newAlerts,
        resolved,
        escalated,
        deEscalated,
        newOpportunities,
      };
    }

    const brief: MorningBrief = {
      generatedAt: new Date().toISOString(),
      criticalAlerts: criticalAlerts.slice(0, 10),
      savingsOpportunities: savingsOpportunities.slice(0, 10),
      totalAffectedSkus: affectedSkuSet.size,
      totalPotentialSavingsUSD: totalSavings,
      aiSummary,
      decisions: decisions.slice(0, 7),   // cap at 7 — enough to demo without overwhelming
      delta,
    };

    cache.set(CACHE_KEY, brief, BRIEF_TTL);
    // Store current brief as previous for next run's delta computation
    // Use a longer TTL (24h) so the delta survives across SWR windows
    cache.set(PREV_CACHE_KEY, brief, { ttlMs: 24 * 60 * 60 * 1000, tags: ['brief'] as CacheTag[] });

    // Send email if SMTP config is present — fire-and-forget, never blocks the response
    if (ALERT_EMAIL_TO && SMTP_HOST && SMTP_USER && SMTP_PASS) {
      sendBriefEmail(brief).catch(err =>
        console.warn('[morning-brief] Email send failed:', err),
      );
    }

    return NextResponse.json(brief);
  } catch (err) {
    console.error('[/api/morning-brief]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}

async function sendBriefEmail(brief: MorningBrief): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST!,
    port: parseInt(SMTP_PORT ?? '587', 10),
    secure: (SMTP_PORT ?? '587') === '465',
    auth: { user: SMTP_USER!, pass: SMTP_PASS! },
  });

  const criticalLines = brief.criticalAlerts.slice(0, 5).map(a =>
    `<tr><td style="padding:4px 8px;color:#ef4444;font-weight:600">${a.severity.toUpperCase()}</td>` +
    `<td style="padding:4px 8px">${a.sku} (${a.affectedCountry})</td>` +
    `<td style="padding:4px 8px">${a.headline}</td>` +
    `<td style="padding:4px 8px">${a.recommendedAction}</td></tr>`,
  ).join('');

  const savingsLines = brief.savingsOpportunities.slice(0, 5).map(o =>
    `<tr><td style="padding:4px 8px">${o.sku} (${o.affectedCountry})</td>` +
    `<td style="padding:4px 8px">${o.headline}</td>` +
    `<td style="padding:4px 8px;color:#22c55e;font-weight:600">$${(o.potentialSavingsUSD ?? 0).toLocaleString()}/yr</td>` +
    `<td style="padding:4px 8px">${o.recommendedAction}</td></tr>`,
  ).join('');

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;margin:0">
  <h1 style="color:#38bdf8;font-size:20px;margin:0 0 4px">SourceIQ Morning Brief</h1>
  <p style="color:#64748b;font-size:12px;margin:0 0 20px">Generated ${new Date(brief.generatedAt).toLocaleString()} · ${brief.totalAffectedSkus} SKUs affected · $${brief.totalPotentialSavingsUSD.toLocaleString()} potential savings</p>
  ${brief.aiSummary ? `
  <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;margin-bottom:20px">
    <div style="font-size:10px;color:#60a5fa;font-weight:600;text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px">AI Summary</div>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#cbd5e1">${brief.aiSummary}</p>
  </div>` : ''}
  ${criticalLines ? `
  <h2 style="color:#f87171;font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Risk Alerts (${brief.criticalAlerts.length})</h2>
  <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;margin-bottom:20px;font-size:12px">
    <thead><tr style="background:#334155;color:#94a3b8;text-transform:uppercase;font-size:10px">
      <th style="padding:6px 8px;text-align:left">Severity</th><th style="padding:6px 8px;text-align:left">SKU</th>
      <th style="padding:6px 8px;text-align:left">Alert</th><th style="padding:6px 8px;text-align:left">Action</th>
    </tr></thead>
    <tbody>${criticalLines}</tbody>
  </table>` : ''}
  ${savingsLines ? `
  <h2 style="color:#4ade80;font-size:14px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 8px">Savings Opportunities (${brief.savingsOpportunities.length})</h2>
  <table style="width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;font-size:12px">
    <thead><tr style="background:#334155;color:#94a3b8;text-transform:uppercase;font-size:10px">
      <th style="padding:6px 8px;text-align:left">SKU</th><th style="padding:6px 8px;text-align:left">Opportunity</th>
      <th style="padding:6px 8px;text-align:left">Savings/yr</th><th style="padding:6px 8px;text-align:left">Action</th>
    </tr></thead>
    <tbody>${savingsLines}</tbody>
  </table>` : ''}
  <p style="color:#475569;font-size:11px;margin-top:24px">Sent by SourceIQ · Foundry Local phi-4-mini · All inference on-device</p>
</body>
</html>`;

  await transporter.sendMail({
    from: `"SourceIQ" <${SMTP_USER}>`,
    to: ALERT_EMAIL_TO!,
    subject: `SourceIQ Morning Brief · ${brief.criticalAlerts.length} alerts · $${brief.totalPotentialSavingsUSD.toLocaleString()} savings`,
    html,
  });

  console.info(`[morning-brief] Email sent to ${ALERT_EMAIL_TO}`);
}
