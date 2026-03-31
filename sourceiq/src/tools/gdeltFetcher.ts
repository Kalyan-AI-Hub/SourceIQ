// src/tools/gdeltFetcher.ts — GDELT API wrapper (free, no API key required)
// PREVENTION: Always append &format=json&mode=ArtList&maxrecords=100 to avoid HTML response
// See dev_mistakes.md [Pre-load] — GDELT API returns HTML/empty on malformed query
//
// BATCH APPROACH: One GDELT call per poll cycle for ALL countries (avoids 429 rate-limiting).
// Articles are fetched with broad conflict/trade keywords, then matched to countries by name.

import type { ConflictSignal } from '../types/index';
import { CircuitBreaker } from '../services/circuitBreaker';

interface GdeltArticle {
  title: string;
  seendate: string;        // "20260316T120000Z"
  socialimage?: string;
  url: string;
  domain: string;
  language: string;
  sourcecountry: string;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

// 3 failures → open; 60s reset (fast recovery from transient outages)
const GDELT_BREAKER = new CircuitBreaker<GdeltArticle[]>('gdelt', 3, 60_000);

import { getCountryConfig } from '../lib/countryConfig';

// Demonym mapping — same as rssFetcher for consistent matching
const COUNTRY_DEMONYMS: Record<string, string[]> = {
  Iran:       ['Iran', 'Iranian', 'Tehran', 'IRGC'],
  China:      ['China', 'Chinese', 'Beijing', 'PRC', 'CCP'],
  Russia:     ['Russia', 'Russian', 'Moscow', 'Kremlin'],
  Ukraine:    ['Ukraine', 'Ukrainian', 'Kyiv', 'Zelensky'],
  Yemen:      ['Yemen', 'Yemeni', 'Houthi', 'Sanaa'],
  Myanmar:    ['Myanmar', 'Burma', 'Burmese', 'junta'],
  Taiwan:     ['Taiwan', 'Taiwanese', 'Taipei', 'TSMC'],
  Turkey:     ['Turkey', 'Turkish', 'Ankara', 'Erdogan'],
  Bangladesh: ['Bangladesh', 'Bangladeshi', 'Dhaka'],
  Mexico:     ['Mexico', 'Mexican', 'cartel', 'narco'],
  Iraq:       ['Iraq', 'Iraqi', 'Baghdad', 'Mosul'],
  Libya:      ['Libya', 'Libyan', 'Tripoli'],
  Sudan:      ['Sudan', 'Sudanese', 'Khartoum', 'Darfur'],
  Somalia:    ['Somalia', 'Somali', 'Mogadishu', 'al-Shabaab'],
};

function articleMentionsCountry(title: string, country: string): boolean {
  const lower = title.toLowerCase();
  const terms = COUNTRY_DEMONYMS[country] ?? [country];
  return terms.some(t => lower.includes(t.toLowerCase()));
}

function parseGdeltDate(seendate: string): string {
  try {
    return new Date(
      seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4:$5:$6Z'),
    ).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** Fetch the raw article list from GDELT once — shared across all countries. */
async function fetchGdeltArticles(endpoint: string): Promise<GdeltArticle[]> {
  return GDELT_BREAKER.execute(async () => {
    // Broad conflict+trade query — no country filter so one call covers all 20 countries.
    // GDELT RULE: OR'd terms MUST be wrapped in parentheses, no quoted phrases in OR chains.
    const terms = encodeURIComponent(
      '(war OR conflict OR missile OR airstrike OR bombing OR invasion OR sanctions OR embargo OR blockade OR tariff OR disruption OR coup OR ceasefire OR unrest OR uprising)',
    );
    const url = `${endpoint}?query=${terms}&mode=ArtList&maxrecords=100&format=json&timespan=24h&sort=HybridRel`;

    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`GDELT ${res.status}: ${res.statusText}`);

    const text = await res.text();
    if (text.trim().startsWith('<') || text.trim().startsWith('Q')) {
      throw new Error(`GDELT returned non-JSON: ${text.slice(0, 60)}`);
    }

    const json = JSON.parse(text) as GdeltResponse;
    return json.articles ?? [];
  });
}

// Module-level cache: one GDELT fetch covers the entire poll cycle.
// cycleTs is set BEFORE the fetch so concurrent per-country calls don't retry on failure.
let cycleArticles: GdeltArticle[] | null = null;
let cycleTs = 0;
// Keep articles for 20 min — longer than any poll interval to ensure cache is always warm.
// GDELT articles are from the last 24h so 20-min-old data is perfectly fine.
const CYCLE_TTL_MS = 20 * 60 * 1000;

/** Returns cached articles if fresh, otherwise fetches a new batch.
 *  On failure: returns [] and caches the failure so no other country retries this cycle. */
async function getArticlesForCycle(endpoint: string): Promise<GdeltArticle[]> {
  const now = Date.now();
  if (cycleTs > 0 && now - cycleTs < CYCLE_TTL_MS) {
    return cycleArticles ?? []; // return empty array if last fetch failed
  }

  // Stamp BEFORE fetch — prevents concurrent per-country calls from all retrying
  cycleTs = now;
  cycleArticles = null;

  console.log('[GDELT] Fetching batch articles (one call for all countries)...');
  try {
    const articles = await fetchGdeltArticles(endpoint);
    cycleArticles = articles;
    console.log(`[GDELT] Batch fetch complete — ${articles.length} article(s)`);
    return articles;
  } catch (err) {
    // Allow retry after 5 minutes instead of locking out for the full cycle TTL.
    // Concurrent per-country calls still get [] this round (cycleTs is already stamped).
    cycleTs = Date.now() - CYCLE_TTL_MS + 5 * 60 * 1000;
    console.warn(`[GDELT] Batch fetch failed — RSS-only for this cycle: ${(err as Error).message}`);
    return [];
  }
}

/** Direct targeted GDELT search for a specific country — bypasses batch cache.
 *  Used by the MCP search_gdelt_news tool for on-demand queries.
 *  Returns raw article list with URL, title, date, domain. */
export async function searchGdeltDirect(
  country: string,
  endpoint: string,
  maxRecords = 10,
): Promise<{ title: string; url: string; domain: string; date: string }[]> {
  // Targeted query: country name + broad risk/trade keyword set
  // GDELT RULE: OR terms must be wrapped in ()
  const terms = encodeURIComponent(
    `"${country}" (war OR conflict OR missile OR sanctions OR embargo OR tariff OR disruption OR protest OR coup OR ceasefire OR unrest)`,
  );
  const url = `${endpoint}?query=${terms}&mode=ArtList&maxrecords=${maxRecords}&format=json&timespan=24h&sort=HybridRel`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GDELT ${res.status}`);
    const text = await res.text();
    if (text.trim().startsWith('<') || text.trim().startsWith('Q')) {
      throw new Error(`GDELT non-JSON: ${text.slice(0, 60)}`);
    }
    const json = JSON.parse(text) as GdeltResponse;
    return (json.articles ?? []).map(a => ({
      title:  a.title,
      url:    a.url,
      domain: a.domain,
      date:   parseGdeltDate(a.seendate),
    }));
  } catch {
    return [];
  }
}

/** Match the shared article batch to a specific country by name/demonym. */
export async function fetchGdeltSignals(
  country: string,
  endpoint: string,
): Promise<ConflictSignal[]> {
  const articles = await getArticlesForCycle(endpoint);
  return articles
    .filter(a => articleMentionsCountry(a.title, country))
    .map(a => ({
      country,
      countryCode: getCountryConfig().getIso2(country) ?? 'XX',
      source: 'gdelt' as const,
      severity: 'medium' as const,   // classifier refines this
      headline: a.title,
      url: a.url,
      confidence: 0.5,
      classifierPath: 'keyword' as const,
      timestamp: parseGdeltDate(a.seendate),
    }));
}
