// src/services/riskPoller.ts — background 5-min polling loop
// Does NOT block user queries. Runs in background via setInterval.
// Updates IRiskStore with fresh SRI scores after each cycle.
// RULE 1: depends on IRiskStore interface only — never on InMemoryRiskStore directly.

import type { IRiskStore, ITariffStore } from '../adapters/interfaces';
import { cache } from '../lib/cache';
import type { ConflictSignal } from '../types/index';
import { fetchGdeltSignals } from '../tools/gdeltFetcher';
import { fetchRssSignals } from '../tools/rssFetcher';
import { TravelAdvisoryService } from './travelAdvisory';
import { ConflictClassifier } from './conflictClassifier';
import { calculateSri } from './riskScorer';
import { detectConvergence } from './convergenceDetector';
import { fetchWorldBankBaselines } from '../tools/worldBankBaselines';
import { getOilTradeDisruptionAdj } from '../tools/commodityFetcher';
import type { IFoundryClient } from '../adapters/interfaces';
import { getCountryConfig } from '../lib/countryConfig';

// Static fallback — used only if World Bank API is unreachable
// eslint-disable-next-line @typescript-eslint/no-require-imports
let fallbackBaselines: Record<string, number> = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  fallbackBaselines = require('../../data/conflict-baseline.json') as Record<string, number>;
} catch { /* file not found — defaults to 0 */ }

// Live baselines loaded on first poll, refreshed every 24h via WorldBank cache
let liveBaselines: Record<string, number> = fallbackBaselines;

export class RiskPoller {
  private intervalId?: ReturnType<typeof setInterval>;
  private trendHistory: Map<string, number[]> = new Map();
  private readonly travelAdvisory: TravelAdvisoryService;
  private readonly classifier: ConflictClassifier;
  private tariffRateCache: Map<string, number> = new Map();
  private lastBaselineFetch = 0;
  private readonly BASELINE_TTL_MS = 24 * 60 * 60 * 1000; // refresh WB baselines once per day

  constructor(
    private readonly store: IRiskStore,
    private readonly gdeltEndpoint: string,
    stateDeptUrl: string,
    private readonly pollIntervalMs: number,
    foundry?: IFoundryClient,
    private readonly tariffStore?: ITariffStore,
  ) {
    this.travelAdvisory = new TravelAdvisoryService(stateDeptUrl);
    this.classifier = new ConflictClassifier(foundry);
  }

  start(): void {
    console.log(`[RiskPoller] Starting — polling every ${this.pollIntervalMs / 1000}s`);
    // Run immediately on start, then on interval
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('[RiskPoller] Stopped');
    }
  }

  private async poll(): Promise<void> {
    console.log(`[RiskPoller] Poll cycle started at ${new Date().toISOString()}`);

    // Refresh World Bank baselines once per day (cached internally by worldBankBaselines.ts)
    if (Date.now() - this.lastBaselineFetch > this.BASELINE_TTL_MS) {
      try {
        liveBaselines = await fetchWorldBankBaselines();
        this.lastBaselineFetch = Date.now();
        console.log('[RiskPoller] World Bank baselines refreshed');
      } catch (err) {
        console.warn('[RiskPoller] World Bank baseline fetch failed — using fallback:', err);
        liveBaselines = fallbackBaselines;
      }
    }

    // Preload live tariff rates once per cycle (avg across HS codes per country)
    if (this.tariffStore) {
      try {
        const allRates = await this.tariffStore.getAllRates();
        const countryTotals = new Map<string, { sum: number; count: number }>();
        for (const r of allRates) {
          const entry = countryTotals.get(r.country) ?? { sum: 0, count: 0 };
          entry.sum += r.rate;
          entry.count += 1;
          countryTotals.set(r.country, entry);
        }
        this.tariffRateCache.clear();
        countryTotals.forEach(({ sum, count }, c) => {
          this.tariffRateCache.set(c, sum / count);
        });
      } catch (err) {
        console.warn('[RiskPoller] Tariff rate preload failed:', err);
      }
    }

    // Fetch do-not-travel list once per cycle
    let doNotTravelCountries: string[] = [];
    try {
      doNotTravelCountries = await this.travelAdvisory.getDoNotTravelCountries();
    } catch (err) {
      console.warn('[RiskPoller] Travel advisory fetch failed:', err);
    }

    const monitored = getCountryConfig().getAllCountryNames();

    // Process countries sequentially — prevents concurrent LLM calls from crashing Foundry Local
    for (const country of monitored) {
      await this.pollCountry(country, doNotTravelCountries);
    }

    console.log(`[RiskPoller] Poll cycle complete — ${monitored.length} countries updated`);

    // Invalidate all risk-derived cached outputs so next request gets fresh data.
    // Brief + query caches are tagged 'risk' — this clears world-brief, morning-brief, and
    // any cached orchestrator query responses that depend on risk scores.
    cache.invalidateByTag('risk');
    cache.invalidateByTag('brief');
    console.log('[RiskPoller] Cache invalidated: risk + brief tags cleared');

    // Detect multi-domain signal convergence across all updated countries
    try {
      const allSri = await this.store.getHeatmapData();
      // Non-high-risk countries are treated as sourcing countries for convergence detection
      const sourcingCountries = new Set(
        getCountryConfig().getAll().filter(r => !r.isHighRisk).map(r => r.name),
      );
      const cards = detectConvergence(allSri, sourcingCountries);
      await this.store.setConvergenceCards(cards);
      if (cards.length > 0) {
        console.log(`[RiskPoller] ${cards.length} convergence card(s) detected`);
      }
    } catch (err) {
      console.warn('[RiskPoller] Convergence detection failed:', err);
    }
  }

  private async pollCountry(country: string, doNotTravelCountries: string[]): Promise<void> {
    try {
      const [gdeltRaw, rssRaw] = await Promise.allSettled([
        fetchGdeltSignals(country, this.gdeltEndpoint),
        fetchRssSignals(country),
      ]);

      const gdeltOk = gdeltRaw.status === 'fulfilled';
      const rssOk   = rssRaw.status  === 'fulfilled';

      if (!gdeltOk) console.warn(`[RiskPoller] GDELT failed for ${country}:`, (gdeltRaw as PromiseRejectedResult).reason);
      if (!rssOk)   console.warn(`[RiskPoller] RSS failed for ${country}:`,   (rssRaw  as PromiseRejectedResult).reason);

      const combined: ConflictSignal[] = [
        ...(gdeltOk ? gdeltRaw.value : []),
        ...(rssOk   ? rssRaw.value   : []),
      ];

      // Deduplicate by normalized headline — GDELT and RSS often carry the same story
      const seenHeadlines = new Set<string>();
      const rawSignals = combined.filter(s => {
        const key = s.headline.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
        if (seenHeadlines.has(key)) return false;
        seenHeadlines.add(key);
        return true;
      });

      // Run through classifier
      const classified = await this.classifier.classifyBatch(rawSignals);

      // Get trend history
      const history = this.trendHistory.get(country) ?? [];

      // Calculate SRI — baseline from World Bank (live) with fallback to static JSON
      const wbScore = liveBaselines[country];
      // Live oil price adjustment: WTI > $80 adds to tradeDisruption for oil-importing countries
      const oilAdj = await getOilTradeDisruptionAdj(country);
      const sri = calculateSri({
        country,
        signals: classified,
        baselineRisk:       wbScore ?? fallbackBaselines[country] ?? 10,
        baselineSource:     wbScore !== undefined ? 'worldbank' : 'fallback',
        tariffRate:         this.tariffRateCache.get(country) ?? 0,
        doNotTravel:        doNotTravelCountries.includes(country),
        previousScores:     history,
        oilPriceAdj:        oilAdj,
      });

      // Preserve previous high/critical alerts when this poll returned no signals.
      // Prevents a transient GDELT outage or circuit-breaker trip from silently
      // clearing valid war/conflict alerts that were captured in the last cycle.
      if (classified.length === 0) {
        const prev = await this.store.getSriForCountry(country);
        if (prev?.activeAlerts.length) {
          const ALERT_TTL_MS = 24 * 60 * 60 * 1000; // keep alerts for 24 h
          const cutoff = Date.now() - ALERT_TTL_MS;
          const preserved = prev.activeAlerts.filter(
            a => new Date(a.timestamp).getTime() > cutoff,
          );
          if (preserved.length > 0) {
            sri.activeAlerts = preserved;
            console.log(`[RiskPoller] ${country}: 0 new signals — preserving ${preserved.length} alert(s) from last cycle`);
          }
        }
      } else {
        console.log(`[RiskPoller] ${country}: ${classified.length} signals → ${sri.activeAlerts.length} alert(s) [high/critical]`);
      }

      // Update trend history (keep last 24 scores)
      this.trendHistory.set(country, [...history.slice(-23), sri.score]);

      await this.store.updateSri(sri);
    } catch (err) {
      console.warn(`[RiskPoller] Failed to poll ${country}:`, err);
    }
  }
}
