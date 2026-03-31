// src/agents/newsAggregatorAgent.ts — live news aggregation + sourcing impact analysis
// Reads active alerts from IRiskStore and produces a structured news brief.
// Answers: "what's happening?", "summarize conflict news", "what broke today?"
// RULE 1: depends on IRiskStore + IFoundryClient interfaces only.

import type { IRiskStore, IFoundryClient } from '../adapters/interfaces';
import type { AgentResponse, RiskAlert } from '../types/index';
import { getCountryConfig } from '../lib/countryConfig';
import { getPrompt } from '../prompts/promptLoader';

function groupByCountry(alerts: RiskAlert[]): Map<string, RiskAlert[]> {
  const map = new Map<string, RiskAlert[]>();
  for (const a of alerts) {
    const list = map.get(a.country) ?? [];
    list.push(a);
    map.set(a.country, list);
  }
  return map;
}

export class NewsAggregatorAgent {
  constructor(
    private readonly riskStore: IRiskStore,
    private readonly foundry: IFoundryClient,
  ) {}

  async query(userMessage: string): Promise<AgentResponse> {
    // Pull all active high/critical alerts across all countries
    const allAlerts = await this.riskStore.getConflictAlerts(); // no filter = all countries
    const heatmapData = await this.riskStore.getHeatmapData();
    const sriMap = new Map(heatmapData.map(s => [s.country, s]));

    // Deduplicate by normalized message — GDELT and RSS often carry the same story
    const seenMsgs = new Set<string>();
    const deduped = allAlerts.filter(a => {
      const key = a.message.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
      if (seenMsgs.has(key)) return false;
      seenMsgs.add(key);
      return true;
    });

    // Filter to high/critical only — low/medium are noise for a news brief
    const significant = deduped.filter(a => a.severity === 'high' || a.severity === 'critical');

    if (significant.length === 0) {
      return {
        answer: 'No high or critical alerts active right now. Risk poller may still be completing its first cycle — check back in a few minutes.',
        riskAlerts: [],
        source: 'local',
      };
    }

    const byCountry = groupByCountry(significant);

    // Build structured alert context — sorted by SRI score desc
    const sortedCountries = Array.from(byCountry.keys()).sort((a, b) => {
      const scoreA = sriMap.get(a)?.score ?? 0;
      const scoreB = sriMap.get(b)?.score ?? 0;
      return scoreB - scoreA;
    });

    const alertLines: string[] = [];
    for (const country of sortedCountries) {
      const alerts = byCountry.get(country)!;
      const sri = sriMap.get(country);
      const sanctions = getCountryConfig().isSanctioned(country);
      alertLines.push(
        `\n${country} — SRI ${sri?.score ?? '?'}/100 (${sri?.tier ?? '?'})${sanctions ? ' [US SANCTIONS — direct sourcing prohibited]' : ''}:`,
      );
      for (const a of alerts) {
        alertLines.push(`  [${a.severity.toUpperCase()}] "${a.message}"`);
      }
      if (sri?.floorApplied) {
        alertLines.push(`  Floor rule: ${sri.floorApplied}`);
      }
    }

    const groundedMessage = [
      `[LIVE NEWS ALERTS — ${new Date().toDateString()}]`,
      `${significant.length} high/critical alerts across ${byCountry.size} countries:`,
      ...alertLines,
      `[END ALERTS]`,
      ``,
      `User question: ${userMessage}`,
      ``,
      `Analyze the alerts above. Quote specific headlines. Explain regional sourcing impact. End with buyer action items.`,
    ].join('\n');

    let answer: string;
    try {
      answer = await this.foundry.chat(
        [{ role: 'user', content: groundedMessage }],
        getPrompt('newsAggregator.analyst'),
      );
    } catch {
      // Foundry Local offline — return raw structured alerts without AI summarization
      answer = [
        `**AI summarization offline** — showing live alerts directly:\n`,
        ...alertLines,
        `\n---\n*AI model is temporarily busy — retry in 30s for AI-written impact analysis and buyer action items.*`,
      ].join('\n');
    }

    return {
      answer,
      riskAlerts: significant.slice(0, 10),
      source: 'local',
    };
  }
}
