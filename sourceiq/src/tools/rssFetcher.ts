// src/tools/rssFetcher.ts — RSS feed parser for supply-chain intelligence
// BATCH APPROACH: All feeds fetched ONCE per hour, cached in-memory.
// Per-country calls read from the cache — avoids re-fetching × N countries.

import { XMLParser } from 'fast-xml-parser';
import type { ConflictSignal } from '../types/index';
import { CircuitBreaker } from '../services/circuitBreaker';

const RSS_FEEDS = [
  // General world news
  { name: 'BBC World',           url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'BBC Middle East',     url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
  { name: 'BBC Asia',            url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
  { name: 'BBC Business',        url: 'https://feeds.bbci.co.uk/news/business/rss.xml' },
  { name: 'Al Jazeera',          url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'The Guardian World',  url: 'https://www.theguardian.com/world/rss' },
  { name: 'The Guardian Business', url: 'https://www.theguardian.com/business/rss' },
  { name: 'NPR World',           url: 'https://feeds.npr.org/1004/rss.xml' },
  { name: 'ABC International',   url: 'https://abcnews.go.com/abcnews/internationalheadlines' },
  // Supply-chain & shipping
  { name: 'Supply Chain Dive',   url: 'https://www.supplychaindive.com/feeds/news/' },
  { name: 'gCaptain',             url: 'https://gcaptain.com/feed/' },
  { name: 'Hellenic Shipping',   url: 'https://www.hellenicshippingnews.com/feed/' },
  { name: 'FreightWaves',        url: 'https://www.freightwaves.com/news/feed' },
  // Commodities & mining
  { name: 'Mining.com',          url: 'https://www.mining.com/feed/' },
  // Military / naval (affects shipping routes)
  { name: 'USNI News',           url: 'https://news.usni.org/feed' },
  // Asia trade & manufacturing
  { name: 'Straits Times Asia',  url: 'https://www.straitstimes.com/news/asia/rss.xml' },
];

interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
}

interface RssFeed {
  rss?: { channel?: { item?: RssItem[] } };
  feed?: { entry?: { title?: string; link?: { '#text'?: string }; updated?: string }[] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '#', htmlEntities: true, processEntities: true, entityExpansionLimit: 10000 } as any);

import { getCountryConfig } from '../lib/countryConfig';

// Demonym/alias mapping
const COUNTRY_DEMONYMS: Record<string, string[]> = {
  Iran:       ['Iran', 'Iranian', 'Tehran', 'IRGC'],
  China:      ['China', 'Chinese', 'Beijing', 'PRC', 'CCP'],
  Russia:     ['Russia', 'Russian', 'Moscow', 'Kremlin'],
  Ukraine:    ['Ukraine', 'Ukrainian', 'Kyiv', 'Zelensky'],
  Yemen:      ['Yemen', 'Yemeni', 'Houthi', 'Sanaa'],
  Israel:     ['Israel', 'Israeli', 'Tel Aviv', 'IDF', 'Gaza'],
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

// Supply-chain relevance scoring — higher = more impactful on procurement/logistics
const SC_SCORES: { terms: string[]; score: number }[] = [
  // Critical shipping routes
  { terms: ['strait of hormuz', 'red sea', 'suez canal', 'panama canal', 'strait of malacca', 'bab-el-mandeb', 'taiwan strait'], score: 120 },
  // Port disruptions
  { terms: ['port strike', 'port closure', 'port congestion', 'port blockade', 'dockworker', 'longshoreman', 'container ship', 'shipping lane', 'maritime blockade'], score: 100 },
  // Trade policy
  { terms: ['sanctions', 'export ban', 'import ban', 'trade war', 'embargo', 'tariff hike', 'supply chain disruption', 'trade restriction'], score: 90 },
  // Military affecting trade
  { terms: ['houthi', 'missile attack', 'naval blockade', 'warship seized', 'military exercise taiwan', 'blockade'], score: 85 },
  // Manufacturing / logistics
  { terms: ['factory shutdown', 'production halt', 'supply disruption', 'shortage', 'freight rate', 'container shortage', 'logistics crisis'], score: 75 },
  // Key commodities
  { terms: ['oil price', 'lng', 'natural gas', 'lithium', 'cobalt', 'rare earth', 'semiconductor shortage', 'chip shortage', 'cotton supply', 'grain export'], score: 70 },
  // Natural disasters affecting production
  { terms: ['earthquake', 'typhoon', 'flooding factory', 'port closed storm'], score: 65 },
  // Business noise — demote
  { terms: ['earnings report', 'quarterly results', 'stock price', 'ipo', 'merger', 'acquisition', 'dividend'], score: -60 },
];

/** Score a news item for supply-chain relevance (higher = more impactful). */
function scoreSupplyChain(title: string, description: string): number {
  const text = `${title} ${description}`.toLowerCase();
  let total = 0;
  for (const { terms, score } of SC_SCORES) {
    if (terms.some(t => text.includes(t))) total += score;
  }
  return total;
}

/** Recency bonus — prefer articles published in the last 24-48h over older ones. */
function recencyBonus(pubDate: string | undefined): number {
  if (!pubDate) return 0;
  try {
    const ageMs = Date.now() - new Date(pubDate).getTime();
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours <= 6)  return 80;   // breaking news — strong boost
    if (ageHours <= 24) return 50;   // today's news — boost
    if (ageHours <= 48) return 15;   // yesterday — slight boost
    if (ageHours > 96)  return -40;  // 4+ days old — demote
    return 0;
  } catch {
    return 0;
  }
}

function mentionsCountry(text: string, country: string): boolean {
  const lower = text.toLowerCase();
  const terms = COUNTRY_DEMONYMS[country] ?? [country];
  return terms.some(t => lower.includes(t.toLowerCase()));
}

async function fetchFeed(feedUrl: string): Promise<RssItem[]> {
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`RSS ${res.status}: ${res.statusText}`);
  const xml = await res.text();
  try {
    const parsed = parser.parse(xml) as RssFeed;
    // Handle both RSS and Atom feed formats
    const rssItems = parsed.rss?.channel?.item ?? [];
    const atomItems = (parsed.feed?.entry ?? []).map(e => ({
      title: typeof e.title === 'string' ? e.title : (e.title as unknown as Record<string, string>)?.['#text'] ?? '',
      link: e.link?.['#text'] ?? (e.link as unknown as string) ?? '',
      pubDate: e.updated,
    } as RssItem));
    return rssItems.length > 0 ? rssItems : atomItems;
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    // Entity/parse errors are feed-level — don't count against circuit breaker
    console.warn(`[RSS] XML parse failed for ${feedUrl}: ${msg}`);
    return [];
  }
}

// Circuit breaker — 3 failures → open; 60s reset
const RSS_BREAKER = new CircuitBreaker<RssItem[]>('rss-feeds', 3, 60_000);

// Module-level cache: fetch all feeds once per hour (matches world-brief TTL)
let cachedItems: RssItem[] | null = null;
let cacheTs = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — matches world-brief server cache

/** Fetch all RSS feeds and cache the combined article list for one hour. */
async function getAllRssItems(): Promise<RssItem[]> {
  if (cachedItems && Date.now() - cacheTs < CACHE_TTL_MS) {
    return cachedItems;
  }

  console.log('[RSS] Fetching all feeds (batch)...');
  const results = await RSS_BREAKER.execute(async () => {
    const feedResults = await Promise.allSettled(RSS_FEEDS.map(f => fetchFeed(f.url)));
    const items: RssItem[] = [];
    feedResults.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        items.push(...result.value);
      } else {
        console.warn(`[RSS] ${RSS_FEEDS[i]!.name} failed:`, result.reason);
      }
    });
    return items;
  });

  cachedItems = results;
  cacheTs = Date.now();
  console.log(`[RSS] Batch fetch complete — ${results.length} items across all feeds`);
  return results;
}

/** Return the top N supply-chain-impacting headlines across all feeds. */
export async function getTopSupplyChainHeadlines(
  maxItems = 6,
): Promise<{ headline: string; source: string; url?: string; score: number }[]> {
  const items = await getAllRssItems();

  const scored = items
    .map(item => {
      const headline = item.title ?? '';
      const desc = item.description ?? '';
      if (!headline) return null;
      const score = scoreSupplyChain(headline, desc) + recencyBonus(item.pubDate);
      if (score <= 0) return null; // Skip irrelevant items
      // Identify feed source by matching URL patterns
      const url = item.link;
      const source = inferSource(url ?? '');
      return { headline, source, url: url ?? undefined, score };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  // Deduplicate by similar headline prefix (first 60 chars)
  const seen = new Set<string>();
  const deduped: typeof scored = [];
  for (const item of scored) {
    const key = item.headline.slice(0, 60).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  return deduped.slice(0, maxItems);
}

function inferSource(url: string): string {
  if (url.includes('bbc')) return 'BBC';
  if (url.includes('aljazeera')) return 'Al Jazeera';
  if (url.includes('guardian')) return 'The Guardian';
  if (url.includes('npr')) return 'NPR';
  if (url.includes('abcnews')) return 'ABC News';
  if (url.includes('supplychaindive')) return 'Supply Chain Dive';
  if (url.includes('gcaptain')) return 'gCaptain';
  if (url.includes('hellenicshippingnews')) return 'Hellenic Shipping';
  if (url.includes('freightwaves')) return 'FreightWaves';
  if (url.includes('mining.com')) return 'Mining.com';
  if (url.includes('usni')) return 'USNI News';
  if (url.includes('straitstimes')) return 'Straits Times';
  return 'News';
}

/** Filter the shared article cache for a specific country by name/demonym. */
export async function fetchRssSignals(country: string): Promise<ConflictSignal[]> {
  const items = await getAllRssItems();
  const signals: ConflictSignal[] = [];

  for (const item of items) {
    const title = item.title ?? '';
    const desc  = item.description ?? '';
    if (!mentionsCountry(title, country) && !mentionsCountry(desc, country)) continue;
    const headline = title || desc.slice(0, 120);
    if (!headline) continue;
    signals.push({
      country,
      countryCode: getCountryConfig().getIso2(country) ?? 'XX',
      source: 'rss' as const,
      severity: 'medium' as const,
      headline,
      url: item.link,
      confidence: 0.5,
      classifierPath: 'keyword' as const,
      timestamp: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString(),
    });
  }

  return signals;
}
