// src/agents/geoRiskAgent.ts — answers geopolitical risk questions
// RULE 1: depends on IRiskStore + IFoundryClient interfaces only.
// RULE 1: NEVER imports InMemoryRiskStore.

import type { IRiskStore, IFoundryClient } from '../adapters/interfaces';
import type { AgentResponse } from '../types/index';
import { COMPREHENSIVE_SANCTIONS } from '../mcp/sanctionsMcpServer';
import { executeTools, MCP_TOOLS } from '../lib/mcpToolRegistry';
import { getPrompt } from '../prompts/promptLoader';

export class GeoRiskAgent {
  constructor(
    private readonly riskStore: IRiskStore,
    private readonly foundry: IFoundryClient,
  ) {}

  async query(userMessage: string): Promise<AgentResponse> {
    const heatmapData = await this.riskStore.getHeatmapData();

    // Extract mentioned country from message for targeted alert filtering
    const mentionedCountry = heatmapData.find(c =>
      userMessage.toLowerCase().includes(c.country.toLowerCase()),
    )?.country;

    const rawAlerts = await this.riskStore.getConflictAlerts(mentionedCountry);

    // ── Alert deduplication ──────────────────────────────────────────────────
    // Stage 1: filter out question-format headlines.
    //   BBC/Reuters occasionally publish explanatory articles whose titles are questions
    //   (e.g. "Who is fighting in Myanmar's multi-front civil war?"). These are not
    //   news events — they're evergreen explainers that fire every poll cycle and
    //   produce confusing output when quoted verbatim by the LLM.
    const QUESTION_WORDS = /^(who|what|why|how|when|where|which|whose|whom)\b/i;
    const nonQuestionAlerts = rawAlerts.filter(a => {
      const msg = a.message.trim();
      return !msg.endsWith('?') && !QUESTION_WORDS.test(msg);
    });

    // Stage 2: near-duplicate dedup using token-overlap (>60% shared meaningful tokens = duplicate).
    //   The old 80-char exact-match key misses semantically identical headlines from
    //   different RSS feeds (e.g. BBC World / BBC Middle East / Al Jazeera running the
    //   same story with minor wording variations).
    const STOP_WORDS = new Set(['a','an','the','is','in','of','to','and','or','for','as','at','from','by','on','with','that','this','it','be','are','was','were','been','has','have','had','will','would','could','should','may','might','can','its','their','our','his','her','they','we','you','i','s','vs','un']);
    function meaningfulTokens(msg: string): Set<string> {
      return new Set(
        msg.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
          .filter(w => w.length > 2 && !STOP_WORDS.has(w)),
      );
    }
    function tokenOverlap(a: Set<string>, b: Set<string>): number {
      const shared = Array.from(a).filter(w => b.has(w)).length;
      return shared / Math.max(Math.min(a.size, b.size), 1);
    }

    const seenTokenSets: Set<string>[] = [];
    const alerts = nonQuestionAlerts.filter(a => {
      const tokens = meaningfulTokens(a.message);
      for (const seen of seenTokenSets) {
        if (tokenOverlap(tokens, seen) > 0.60) return false;
      }
      seenTokenSets.push(tokens);
      return true;
    });

    // For context: show the queried country first, then top risky countries (exclude queried to avoid duplicate)
    const sorted = [...heatmapData].sort((a, b) => b.score - a.score);
    const contextData = mentionedCountry
      ? [
          heatmapData.find(c => c.country === mentionedCountry)!,
          ...sorted.filter(c => c.country !== mentionedCountry).slice(0, 7),
        ].filter(Boolean)
      : sorted.slice(0, 12);

    // Build rich context for the queried country
    const queriedSri = mentionedCountry
      ? heatmapData.find(c => c.country === mentionedCountry)
      : null;

    const queriedDetail = queriedSri
      ? [
          `\n--- ${queriedSri.country} deep-dive ---`,
          `SRI: ${queriedSri.score}/100 (${queriedSri.tier}) | trend: ${queriedSri.trend}`,
          `Signal breakdown: newsRisk=${queriedSri.signals.newsRisk} | tariffRisk=${queriedSri.signals.tariffRisk} | tradeDisruption=${queriedSri.signals.tradeDisruption} | baselineRisk=${queriedSri.signals.baselineRisk}`,
          queriedSri.floorApplied ? `Floor rule: ${queriedSri.floorApplied}` : '',
          queriedSri.activeAlerts.length
            ? `Live alerts (${queriedSri.activeAlerts.length}):\n` +
              queriedSri.activeAlerts.map(a => `  [${a.severity.toUpperCase()}] ${a.message}`).join('\n')
            : queriedSri.floorApplied
              ? `No cached news alerts yet — floor rule active: ${queriedSri.floorApplied}. Explain this floor rule's real-world cause in your response.`
              : 'No live news alerts — risk driven by structural/baseline factors.',
        ].filter(Boolean).join('\n')
      : '';

    const context = contextData.length
      ? `Current SRI scores (live data — baseline source: ${contextData[0]?.baselineSource ?? 'unknown'}):\n` +
        contextData.map(c => `${c.country}: ${c.score}/100 (${c.tier}) — ${c.trend}`).join('\n')
      : 'Risk data loading — first poll cycle in progress. Using structural risk knowledge only.';

    const alertContext = alerts.length
      ? `\nRecent news signals:\n` + alerts.slice(0, 5).map(a => `[${a.severity.toUpperCase()}] ${a.country}: ${a.message}`).join('\n')
      : '';

    // ── MCP tool calls — sanctions check + live GDELT news ──────────────────
    // Run in parallel with the rest of the pipeline. Results are included in
    // the data block so the LLM can cite them, and toolsUsed drives the chip.
    let mcpToolsUsed: string[] = [];
    let mcpDataBlock = '';
    if (mentionedCountry) {
      const mcpToolNames = ['get_sanctions_check', 'search_gdelt_news'];
      const mcpResults = await executeTools(mcpToolNames, { country: mentionedCountry });
      mcpToolsUsed = mcpResults.map(r => {
        const def = MCP_TOOLS.find(t => t.name === r.tool);
        return def?.description ?? r.tool;
      });
      if (mcpResults.length > 0) {
        mcpDataBlock = '\n[MCP TOOL RESULTS]\n' + mcpResults
          .map(r => `[${r.tool.replace(/_/g, ' ').toUpperCase()}]\n${r.result}`)
          .join('\n\n') + '\n[END MCP TOOL RESULTS]';
      }
    }

    // Embed the data directly in the user message — phi-4-mini grounds better on user turn than system prompt
    const groundedMessage = [
      `[DATA BLOCK — USE ONLY THESE SCORES]`,
      context,
      queriedDetail,
      alertContext,
      mcpDataBlock,
      `[END DATA BLOCK]`,
      ``,
      `User question: ${userMessage}`,
      `Answer using ONLY the SRI scores and data in the DATA BLOCK above.`,
    ].filter(Boolean).join('\n');

    let answer: string;
    try {
      // Budget: 5 headlines × ~80 tokens each + sanctions note + recommended action = ~800
      answer = await this.foundry.chat(
        [{ role: 'user', content: groundedMessage }],
        getPrompt('geoRisk.analyst', { sanctionedList: Object.keys(COMPREHENSIVE_SANCTIONS).join(', ') }),
        800,
      );
    } catch {
      const safestAlternative = [...heatmapData]
        .filter(country => country.country !== mentionedCountry)
        .sort((a, b) => a.score - b.score)[0];

      const liveAlertSummary = (queriedSri?.activeAlerts ?? alerts)
        .filter(a => a.severity === 'critical' || a.severity === 'high')
        .slice(0, 2)
        .map(a => `${a.severity.toUpperCase()}: ${a.message}`);

      const signalSummary = queriedSri
        ? `Signal breakdown: news ${queriedSri.signals.newsRisk}, tariff ${queriedSri.signals.tariffRisk}, disruption ${queriedSri.signals.tradeDisruption}, baseline ${queriedSri.signals.baselineRisk}.`
        : 'Signal breakdown unavailable.';

      const riskLine = queriedSri
        ? `${queriedSri.country} currently scores ${queriedSri.score}/100 (${queriedSri.tier}) with a ${queriedSri.trend} trend.`
        : 'Country-specific SRI unavailable right now.';

      const floorLine = queriedSri?.floorApplied
        ? `Primary floor rule: ${queriedSri.floorApplied}.`
        : null;

      const actionLine = safestAlternative
        ? `Buyer action: avoid new exposure while the local model is offline and review lower-risk alternatives such as ${safestAlternative.country} (${safestAlternative.score}/100).`
        : 'Buyer action: avoid new exposure until this country is re-reviewed with live model analysis.';

      answer = [
        '**AI summarization offline** — returning a deterministic risk brief.',
        riskLine,
        signalSummary,
        floorLine,
        liveAlertSummary.length ? `Key alerts: ${liveAlertSummary.join(' | ')}` : 'Key alerts: no high-severity live alerts cached right now.',
        actionLine,
      ].filter(Boolean).join('\n\n');
    }

    // Merge RSS alerts with SRI active alerts (e.g. floor-rule countries may have no live RSS
    // stories but still carry active alerts from the risk-scoring pipeline).
    const sriAlerts = queriedSri?.activeAlerts ?? [];
    const rssMessages = new Set(alerts.map(a => a.message));
    const mergedAlerts = [
      ...alerts,
      ...sriAlerts.filter(a => !rssMessages.has(a.message)),
    ];

    return {
      answer,
      riskAlerts: mergedAlerts.filter(a => a.severity === 'high' || a.severity === 'critical').slice(0, 5),
      heatmapData,
      source: 'local',
      toolsUsed: mcpToolsUsed.length > 0 ? mcpToolsUsed : undefined,
    };
  }
}
