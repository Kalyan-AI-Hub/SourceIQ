// src/services/travelAdvisory.ts — US State Dept travel advisory fetcher
// Free, no API key. Returns advisory level per country.
// Levels: 1=Normal, 2=Increased Caution, 3=Reconsider Travel, 4=Do Not Travel

import type { RiskAlert } from '../types/index';
import { CircuitBreaker } from './circuitBreaker';

interface AdvisoryRecord {
  name: string;
  advisoryText: string;
  advisoryLevel: number;       // 1-4
  country: string;
  countryCode: string;         // ISO alpha-2
  lastUpdated: string;
}

// RSS feed URL — the JSON endpoint now returns CAPTCHAs (March 2026).
// The RSS feed at travel.state.gov/_res/rss/TAsTWs.xml has titles like:
//   "Country - Level N: Description"
const RSS_URL = 'https://travel.state.gov/_res/rss/TAsTWs.xml';

// Map advisory level → RiskAlert severity
function levelToSeverity(level: number): RiskAlert['severity'] {
  if (level >= 4) return 'critical';
  if (level === 3) return 'high';
  if (level === 2) return 'medium';
  return 'low';
}

/** Parse "Country - Level N: Description" from RSS title */
function parseRssTitle(title: string): { country: string; level: number; text: string } | null {
  const m = title.match(/^(.+?)\s*-\s*Level\s+(\d):\s*(.+)$/i);
  if (!m) return null;
  return { country: m[1].trim(), level: parseInt(m[2], 10), text: m[3].trim() };
}

export class TravelAdvisoryService {
  private readonly breaker = new CircuitBreaker<AdvisoryRecord[]>(
    'state-dept-travel-advisory',
    3,
    600_000, // 10-min back-off
  );

  constructor(
    private readonly _advisoryUrl: string,  // kept for backward compat; RSS_URL used instead
  ) {}

  async fetchAdvisories(): Promise<AdvisoryRecord[]> {
    return this.breaker.execute(async () => {
      const res = await fetch(RSS_URL, {
        headers: { 'Accept': 'application/xml' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`State Dept RSS ${res.status}: ${res.statusText}`);

      const xml = await res.text();
      const records: AdvisoryRecord[] = [];

      // Lightweight regex XML parse — avoids pulling in an XML parser dep
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match: RegExpExecArray | null;
      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const title = block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
        const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() ?? '';
        const parsed = parseRssTitle(title);
        if (!parsed) continue;
        records.push({
          name: parsed.country,
          advisoryText: parsed.text,
          advisoryLevel: parsed.level,
          country: parsed.country,
          countryCode: '',  // RSS doesn't include ISO codes — match by name
          lastUpdated: pubDate,
        });
      }

      if (records.length === 0) {
        throw new Error('No advisory records parsed from RSS — feed format may have changed');
      }

      return records;
    });
  }

  async getRiskAlertsForCountry(country: string): Promise<RiskAlert[]> {
    const advisories = await this.fetchAdvisories();
    const lower = country.toLowerCase();
    const match = advisories.find(
      a => a.country.toLowerCase() === lower ||
           a.countryCode.toLowerCase() === lower ||
           // RSS uses "Burma (Myanmar)" — match either part
           a.country.toLowerCase().includes(lower) ||
           lower.includes(a.country.toLowerCase()),
    );
    if (!match || match.advisoryLevel < 2) return [];

    return [{
      severity: levelToSeverity(match.advisoryLevel),
      country: match.country,
      message: `Level ${match.advisoryLevel} travel advisory: ${match.advisoryText}`,
      source: 'State Dept',
      timestamp: match.lastUpdated,
    }];
  }

  async getDoNotTravelCountries(): Promise<string[]> {
    const advisories = await this.fetchAdvisories();
    return advisories
      .filter(a => a.advisoryLevel >= 4)
      .map(a => a.country);
  }
}
