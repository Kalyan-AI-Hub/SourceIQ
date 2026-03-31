// src/agents/inventoryAgent.ts — answers SKU/inventory questions via semantic search
// RULE 1: depends on IInventoryStore + IFoundryClient interfaces only.
// RULE 1: NEVER imports LanceDbInventoryStore.

import type { IInventoryStore, IFoundryClient, ITariffStore } from '../adapters/interfaces';
import type { AgentResponse, InventoryItem } from '../types/index';
import type { InventoryRetriever } from '../rag/retriever';
import { getCountryConfig } from '../lib/countryConfig';
import { effectiveCost } from '../tools/costCalculator';
import { estimateAltUnitCost } from '../lib/costIndex';
import { getPrompt } from '../prompts/promptLoader';

// Detect queries that ask about savings / cheaper alternatives (cross-country comparison)
const SAVINGS_PATTERNS = [
  /sav(e|ing|ings)\b/i, /opportunit(y|ies)/i, /optimi[zs](e|ation)/i,
  /reduce\s+cost/i, /cost\s+(reduc|cut|sav)/i, /where.*spend(ing)?.*less/i,
  /cheaper\s+(source|country|alternative|option)/i, /alternative\s+(source|supplier|country)/i,
  /switch\s+(to|from)/i, /re-?source/i, /better\s+deal/i,
];

// Detect queries that require price sorting across ALL inventory items
const PRICE_SORT_PATTERNS = [
  /cheap(est|er)?/i, /low(est)?\s+(cost|price|unit)/i, /most\s+affordable/i,
  /expensive(st)?/i, /high(est)?\s+(cost|price|unit)/i, /most\s+costly/i,
  /sort\s+by\s+(price|cost)/i, /by\s+(unit\s+)?cost/i, /lowest\s+unit/i,
  /best\s+value/i, /price\s+comparison/i, /cost\s+comparison/i,
];


// Maps query synonyms → DB category values (Electronics | Apparel | Home | Toys | Food).
// New inventory items automatically become discoverable by adding the right category in the CSV.
const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: InventoryItem['category'] }> = [
  { pattern: /spice|spices|seasoning|herb|food|grocery|nut|pistachio|saffron|agricultural/i, category: 'Food' },
  { pattern: /electronic|tech|device|gadget|laptop|phone|tablet|tv/i,                        category: 'Electronics' },
  { pattern: /apparel|clothing|garment|wear|textile|fabric|shirt|jacket/i,                   category: 'Apparel' },
  { pattern: /home|furniture|decor|rug|carpet/i,                                              category: 'Home' },
  { pattern: /toy|game|puzzle/i,                                                              category: 'Toys' },
];

const DIRECT_SKU_PATTERNS = /\b(where|source|sourcing|from|country|cost|price|unit|volume|quantity|hs\s*code|category|tell me about|what is|which)\b/i;

export class InventoryAgent {
  constructor(
    private readonly store: IInventoryStore,
    private readonly foundry: IFoundryClient,
    private readonly tariffs?: ITariffStore,
    private readonly retriever?: InventoryRetriever,
  ) {}

  private buildSanctionsWarning(country: string): string | null {
    const config = getCountryConfig();
    if (!config.isSanctioned(country)) return null;
    return `⛔ COMPLIANCE ALERT: ${country} is subject to US OFAC comprehensive sanctions. ${config.getSanctionsDetail(country) ?? 'Direct sourcing is prohibited.'}`;
  }

  private formatInventoryFacts(item: InventoryItem): string[] {
    return [
      `${item.sku} — ${item.name}`,
      `Current source: ${item.currentSourceCountry}`,
      `Category: ${item.category}`,
      `Unit cost: $${item.unitCostUSD.toFixed(2)}`,
      `Annual volume: ${item.annualVolume.toLocaleString()} units`,
      `On-hand quantity: ${item.quantity.toLocaleString()} units`,
      `HS code: ${item.hsCode}`,
    ];
  }

  private buildDirectSkuResponse(item: InventoryItem): AgentResponse {
    const warning = this.buildSanctionsWarning(item.currentSourceCountry);
    const lines = this.formatInventoryFacts(item);
    return {
      answer: [warning, ...lines].filter(Boolean).join('\n'),
      source: 'local',
    };
  }

  // ── SKU-specific tariff analysis: compare one item across all alternative countries ──
  private async buildSkuAnalysis(sku: string): Promise<{ context: string; items: InventoryItem[] }> {
    const all = await this.store.getAll();
    const item = all.find(i => i.sku.toLowerCase() === sku.toLowerCase());
    if (!item) {
      return { context: `SKU ${sku} not found in inventory.`, items: [] };
    }
    if (!this.tariffs) {
      return { context: `Tariff data unavailable for ${sku} analysis.`, items: [item] };
    }

    const currentRate = await this.tariffs.getRate(item.currentSourceCountry, item.hsCode);
    const currentLanded = effectiveCost(item.unitCostUSD, currentRate?.rate ?? 0);
    const altRates = await this.tariffs.compareCountries(item.hsCode);

    const allAlts = altRates
      .filter(r => r.country !== item.currentSourceCountry)
      .map(r => {
        const altUnitCost = estimateAltUnitCost(item.unitCostUSD, item.currentSourceCountry, r.country, item.category);
        const altLanded = effectiveCost(altUnitCost, r.rate);
        const annualSaving = Math.round((currentLanded - altLanded) * item.annualVolume);
        return { country: r.country, tariff: r.rate, altUnitCost: Math.round(altUnitCost * 100) / 100, altLanded: Math.round(altLanded * 100) / 100, annualSaving };
      })
      .sort((a, b) => a.altLanded - b.altLanded);

    // Keep prompt small for phi-4-mini: top 5 savers + 1 costlier (for context)
    const savers = allAlts.filter(a => a.annualSaving > 0).slice(0, 5);
    const costlier = allAlts.filter(a => a.annualSaving <= 0).slice(0, 1);
    const alternatives = [...savers, ...costlier];

    const lines = [
      `${item.sku}: ${item.name}`,
      `Current: ${item.currentSourceCountry} | $${item.unitCostUSD}/unit | ${currentRate?.rate ?? 0}% tariff | $${currentLanded.toFixed(2)} landed | ${item.annualVolume.toLocaleString()}/yr`,
      `Top alternatives:`,
      ...alternatives.map((a, i) => {
        const tag = a.annualSaving > 0 ? `SAVE $${a.annualSaving.toLocaleString()}/yr` : `+$${Math.abs(a.annualSaving).toLocaleString()}/yr`;
        return `${i + 1}. ${a.country} | $${a.altUnitCost}→$${a.altLanded} landed | ${a.tariff}% | ${tag}`;
      }),
    ];

    return { context: lines.join('\n'), items: [item] };
  }

  // ── Global savings analysis: for each item, find cheapest alternative country ──
  private async buildSavingsAnalysis(): Promise<{ context: string; items: InventoryItem[] }> {
    const all = await this.store.getAll();
    if (!this.tariffs) {
      return { context: 'Tariff data unavailable for savings analysis.', items: all.slice(0, 5) };
    }

    const allRates = await this.tariffs.getAllRates();

    // Pre-fetch tariff comparisons for all distinct HS codes
    const distinctHsCodes = new Set(all.map(i => i.hsCode));
    const altRatesMap = new Map<string, Awaited<ReturnType<typeof this.tariffs.compareCountries>>>();
    await Promise.all(
      Array.from(distinctHsCodes).map(async hs => {
        altRatesMap.set(hs, await this.tariffs!.compareCountries(hs));
      }),
    );

    // For each item, find the cheapest alternative COUNTRY (not a different product)
    interface Opportunity {
      item: InventoryItem;
      currentLanded: number;
      bestAltCountry: string;
      bestAltLanded: number;
      unitSaving: number;
      annualSaving: number;
    }
    const opportunities: Opportunity[] = [];

    for (const item of all) {
      const currentRate = allRates.find(
        r => r.country === item.currentSourceCountry && r.hsCode === item.hsCode,
      )?.rate ?? 0;
      const currentLanded = effectiveCost(item.unitCostUSD, currentRate);

      // Find cheapest alternative country using manufacturing cost index
      const altRates = altRatesMap.get(item.hsCode) ?? [];
      const bestAlt = altRates
        .filter(r => r.country !== item.currentSourceCountry)
        .map(r => {
          const altUnitCost = estimateAltUnitCost(item.unitCostUSD, item.currentSourceCountry, r.country, item.category);
          const altLanded = effectiveCost(altUnitCost, r.rate);
          return { country: r.country, altLanded };
        })
        .sort((a, b) => a.altLanded - b.altLanded)[0];

      if (!bestAlt || bestAlt.altLanded >= currentLanded) continue;

      const unitSaving = Math.round((currentLanded - bestAlt.altLanded) * 100) / 100;
      const annualSaving = Math.round(unitSaving * item.annualVolume);
      if (annualSaving <= 0) continue;

      opportunities.push({
        item,
        currentLanded: Math.round(currentLanded * 100) / 100,
        bestAltCountry: bestAlt.country,
        bestAltLanded: Math.round(bestAlt.altLanded * 100) / 100,
        unitSaving,
        annualSaving,
      });
    }

    // Sort by annual savings descending — biggest opportunities first
    opportunities.sort((a, b) => b.annualSaving - a.annualSaving);
    const top = opportunities.slice(0, 5);

    if (top.length === 0) {
      return {
        context: 'No cross-country savings opportunities found — all items are already at lowest landed cost for their category.',
        items: all.slice(0, 5),
      };
    }

    const totalAnnual = top.reduce((s, o) => s + o.annualSaving, 0);
    const lines = top.map((o, i) =>
      `${i + 1}. ${o.item.sku} ${o.item.name} (${o.item.currentSourceCountry} → ${o.bestAltCountry})\n` +
      `   Current landed: $${o.currentLanded}/unit | Alt landed: $${o.bestAltLanded}/unit\n` +
      `   SAVE: $${o.unitSaving}/unit × ${o.item.annualVolume.toLocaleString()} units = **$${o.annualSaving.toLocaleString()}/yr**`,
    );

    const context =
      `TOP SAVINGS (${top.length} items, $${totalAnnual.toLocaleString()}/yr potential):\n\n` +
      lines.join('\n\n');

    return { context, items: top.map(o => o.item) };
  }

  async query(userMessage: string): Promise<AgentResponse> {
    const lower = userMessage.toLowerCase();

    // SKU-specific queries: "Analyze switching SKU-059 from UAE", "show tariffs for SKU-031"
    const skuMatch = userMessage.match(/SKU-(\d+)/i);
    const exactSku = skuMatch ? `SKU-${skuMatch[1]}` : null;
    const exactItem = exactSku ? await this.store.getBySku(exactSku) : null;
    const isSkuSpecific = skuMatch && /switch|analyz|tariff|comparison|saving|alternative|from\s/i.test(lower);

    if (exactItem && DIRECT_SKU_PATTERNS.test(lower) && !isSkuSpecific) {
      return this.buildDirectSkuResponse(exactItem);
    }

    // Savings queries: cross-country comparison within same HS code
    const isSavingsQuery = !isSkuSpecific && SAVINGS_PATTERNS.some(p => p.test(lower));
    // Price-sorting queries: cheapest/most expensive overall
    const isPriceQuery = !isSkuSpecific && !isSavingsQuery && PRICE_SORT_PATTERNS.some(p => p.test(lower));

    let items: InventoryItem[];
    let contextHeader: string;
    let queryType: 'sku' | 'savings' | 'price' | 'browse' = 'browse';

    if (isSkuSpecific && skuMatch) {
      // Targeted SKU analysis — compare one item across all alternative countries
      queryType = 'sku';
      const { context, items: skuItems } = await this.buildSkuAnalysis(`SKU-${skuMatch[1]}`);
      items = skuItems;
      contextHeader = context;
    } else if (isSavingsQuery) {
      queryType = 'savings';
      // Cross-country savings analysis
      const { context, items: involvedItems } = await this.buildSavingsAnalysis();
      items = involvedItems;
      contextHeader = context;
    } else if (isPriceQuery) {
      queryType = 'price';
      const all = await this.store.getAll();
      const ascending = lower.match(/cheap|low|afford|value|sav(e|ing)|reduc|optimi|opportunit/) !== null;
      const sorted = [...all].sort((a, b) =>
        ascending ? a.unitCostUSD - b.unitCostUSD : b.unitCostUSD - a.unitCostUSD,
      );
      // Pass only top 10 — phi-4-mini loses track of the minimum across 50 rows
      items = sorted.slice(0, 10);
      const winner = items[0]!;
      const direction = ascending ? 'CHEAPEST' : 'MOST EXPENSIVE';
      contextHeader =
        `THE ${direction} ITEM IS: ${winner.sku} | ${winner.name} | ${winner.currentSourceCountry} | $${winner.unitCostUSD}\n` +
        `Top 10 items sorted by unit cost (${direction} first):`;
    } else if (exactItem) {
      items = [exactItem];
      contextHeader = `Exact inventory record for ${exactItem.sku}:`;
    } else {
      // Country detection: use CountryConfig (authoritative source, already loaded at startup)
      // This is faster than store.getAll() and covers all countries, not just those in inventory
      const config = getCountryConfig();
      const mentionedCountry = config.getAllCountryNames().find(c => lower.includes(c.toLowerCase()));

      // Category keyword filter — catches "spices", "electronics", etc.
      const categoryEntry = CATEGORY_PATTERNS.find(e => e.pattern.test(lower));

      if (mentionedCountry && categoryEntry) {
        // Both country AND category mentioned — filter by both
        const countryItems = await this.store.getByCountry(mentionedCountry);
        items = countryItems.filter((i: InventoryItem) => i.category === categoryEntry.category);
        contextHeader = `${categoryEntry.category} items sourced from ${mentionedCountry} — EXACT COUNT: ${items.length} SKUs:`;
      } else if (mentionedCountry) {
        items = await this.store.getByCountry(mentionedCountry);
        contextHeader = `Inventory items sourced from ${mentionedCountry} — EXACT COUNT: ${items.length} SKUs:`;
      } else if (categoryEntry) {
        const all = await this.store.getAll();
        items = all.filter((i: InventoryItem) => i.category === categoryEntry.category);
        contextHeader = `Inventory items matching your query — EXACT COUNT: ${items.length} SKUs:`;
      } else if (this.retriever) {
        // RAG retriever: semantic vector search with formatted grounding block
        const ragResult = await this.retriever.retrieve(userMessage, 8);
        items = ragResult.items;
        contextHeader = ragResult.formatted;
      } else {
        items = await this.store.search(userMessage, 8);
        contextHeader = `Inventory items matching your query:`;
      }
    }

    // For savings/SKU queries, the analysis is already pre-computed in contextHeader.
    // For browse/country queries: strip HS code + on-hand qty to keep context lean and
    // leave token budget for the LLM to write a proper synthesis.
    const context = (queryType === 'savings' || queryType === 'sku')
      ? contextHeader
      : items.length
        ? `${contextHeader}\n` +
          items
            .map((i, idx) =>
              `${idx + 1}. ${i.sku} | ${i.name} | ${i.currentSourceCountry} | $${i.unitCostUSD}/unit | vol: ${i.annualVolume.toLocaleString()}/yr`,
            )
            .join('\n')
        : `No inventory items found.`;

    // Flag any sanctioned source countries found in the result set
    const config = getCountryConfig();
    const sanctionedSources = Array.from(new Set(items.map(i => i.currentSourceCountry)))
      .filter(c => config.isSanctioned(c));
    const sanctionsWarning = sanctionedSources.map(c =>
      `⛔ COMPLIANCE ALERT: ${c} is subject to US OFAC comprehensive sanctions. ` +
      `${config.getSanctionsDetail(c) ?? 'Direct sourcing is prohibited.'}`,
    ).join('\n');

    // Embed data in user message so the LLM grounds on real inventory
    const groundedMessage = [
      `--- INVENTORY DATA ---`,
      sanctionsWarning || null,
      context,
      `--- END DATA ---`,
      ``,
      `User question: ${userMessage}`,
      queryType === 'sku'
        ? `Present the comparison as a bullet list. Highlight best alternative and savings.`
        : queryType === 'savings'
          ? `Present the savings clearly. Highlight top recommendations and total potential.`
          : isPriceQuery
            ? `The pre-computed answer at the top is correct — use it.`
            : `Answer the user's question in 2-3 sentences. Use the EXACT COUNT from the header. Highlight the highest-volume item and flag any concentration risk. Do NOT list or repeat the individual items — they are displayed separately in the UI.`,
    ].filter(Boolean).join('\n');

    // Token budget scales with query complexity:
    //  - savings: 5 SKUs × ~80 tokens each + summary prose = ~600
    //  - sku-specific: single item detail = ~300
    //  - price/browse: short list = ~350
    const maxTokens = queryType === 'savings' ? 600
      : queryType === 'sku' ? 300
      : 150;

    const systemPrompt = getPrompt(queryType === 'browse' ? 'inventory.browse' : 'inventory.analyst');

    let answer: string;
    try {
      answer = await this.foundry.chat(
        [{ role: 'user', content: groundedMessage }],
        systemPrompt,
        maxTokens,
      );
    } catch {
      // Strip RAG metadata markers so internal prompt scaffolding isn't exposed to users
      const fallbackContext = context
        .replace(/\[RAG CONTEXT[^\]]*\]\n?/g, '')
        .replace(/\[END RAG CONTEXT\]\n?/g, '')
        .trim();
      answer = `**AI summarization offline** — showing raw inventory data:\n\n${fallbackContext}\n\n*AI model is temporarily busy — retry in 30s for AI-written sourcing analysis.*`;
    }

    // For browse/price/savings queries: append pipe-delimited item list so the UI can render
    // the SKU table without re-parsing prose. Items are appended after the AI summary
    // and stripped from the visible answer text by the frontend.
    const structuredList = (queryType === 'browse' || queryType === 'price' || queryType === 'savings') && items.length > 0
      ? '\n\n' + items.map((i, idx) =>
          `${idx + 1}. ${i.sku} | ${i.name} | ${i.currentSourceCountry} | $${i.unitCostUSD}`,
        ).join('\n')
      : '';

    return { answer: answer + structuredList, source: 'local' };
  }
}
