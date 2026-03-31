// src/agents/tariffAgent.ts — answers tariff/cost questions
// Uses IFoundryClient.chat() directly for LLM + ITariffStore for data.
// RULE 1: depends on ITariffStore + IFoundryClient + optional IInventoryStore/IRiskStore interfaces only.

import type { ITariffStore, IFoundryClient, IInventoryStore, IRiskStore } from '../adapters/interfaces';
import type { AgentResponse, SourcingRecommendation } from '../types/index';
import { effectiveCost } from '../tools/costCalculator';
import { estimateAltUnitCost } from '../lib/costIndex';
import { getPrompt } from '../prompts/promptLoader';

/** Detect queries that want a switching/savings analysis for a specific SKU */
const SKU_SWITCH_PATTERN = /\b(switch(?:ing)?|analyz(?:e|ing)|compar(?:e|ing)|sav(?:e|ings)|mov(?:e|ing)|reroute?|shift(?:ing)?|best alternative)\b.{0,60}\b(sku-?\d+)\b/i;
const SKU_EXTRACT = /\b(sku-?\d+)\b/i;
const COUNTRY_IN_MSG = (msg: string, country: string) => msg.toLowerCase().includes(country.toLowerCase());

export class TariffAgent {
  constructor(
    private readonly store: ITariffStore,
    private readonly foundry: IFoundryClient,
    private readonly inventory?: IInventoryStore,
    private readonly riskStore?: IRiskStore,
  ) {}

  async query(userMessage: string): Promise<AgentResponse> {
    // ── Structured SKU-switch path ────────────────────────────────────────
    // When the query is "analyze switching SKU-XXX from CountryA", build a full
    // SourcingRecommendation[] so the Decision Brief tiles populate correctly.
    if (this.inventory && SKU_SWITCH_PATTERN.test(userMessage)) {
      const skuMatch = SKU_EXTRACT.exec(userMessage);
      const skuId = skuMatch?.[1]?.toUpperCase();
      if (skuId) {
        const structured = await this._buildSkuSwitchResponse(userMessage, skuId);
        if (structured) return structured;
      }
    }

    // ── General tariff query path ─────────────────────────────────────────
    const allRates = await this.store.getAllRates();
    const lower = userMessage.toLowerCase();
    const filtered = allRates.filter(r => COUNTRY_IN_MSG(lower, r.country));

    let rates: typeof allRates;
    if (filtered.length > 0) {
      rates = filtered;
    } else {
      const seen = new Set<string>();
      rates = allRates
        .slice()
        .sort((a, b) => a.rate - b.rate)
        .filter(r => { if (seen.has(r.country)) return false; seen.add(r.country); return true; })
        .slice(0, 20);
    }

    const ratesContext = rates
      .map(r =>
        `${r.country} | HS ${r.hsCode} | ${r.rate}%${r.tradeAgreement ? ` (${r.tradeAgreement})` : ''} | effective ${r.effectiveDate}`,
      )
      .join('\n');

    const today = new Date().toISOString().slice(0, 10);
    const grounded = `${getPrompt('tariff.analyst')}

Today's date: ${today}. Any effectiveDate on or before today is ALREADY IN EFFECT — use past tense ("is" / "has been"), not future tense ("will be").

Relevant US tariff data (${rates.length} rows):
${ratesContext}

Answer the following question using only the data above. If a country/HS code is not in the data, say so.`;

    let answer: string;
    try {
      answer = await this.foundry.chat(
        [{ role: 'user', content: userMessage }],
        grounded,
      );
    } catch {
      answer = `**AI summarization offline** — showing raw tariff data:\n\n${ratesContext}\n\n*AI model is temporarily busy — retry in 30s for AI-written tariff analysis.*`;
    }

    return { answer, source: 'local' };
  }

  /** Build structured SourcingRecommendation[] for SKU switching queries */
  private async _buildSkuSwitchResponse(
    userMessage: string,
    skuId: string,
  ): Promise<AgentResponse | null> {
    if (!this.inventory) return null;

    const item = await this.inventory.getBySku(skuId);
    if (!item) return null;

    const currentCountry = item.currentSourceCountry;
    const currentRateRow = await this.store.getRate(currentCountry, item.hsCode);
    const currentRate = currentRateRow?.rate ?? 0;
    const currentCost = effectiveCost(item.unitCostUSD, currentRate);

    const altRates = await this.store.compareCountries(item.hsCode);
    const alternatives = altRates
      .filter(r => r.country !== currentCountry)
      .map(r => {
        const altUnit = estimateAltUnitCost(item.unitCostUSD, currentCountry, r.country, item.category);
        const altLanded = effectiveCost(altUnit, r.rate);
        const annualSavings = Math.round((currentCost - altLanded) * item.annualVolume);
        return { country: r.country, rate: r.rate, altLanded, annualSavings };
      })
      .sort((a, b) => b.annualSavings - a.annualSavings);

    if (alternatives.length === 0) return null;

    // Fetch SRI risk scores for alternatives if risk store is available
    const riskScores = new Map<string, number>();
    if (this.riskStore) {
      await Promise.all(
        alternatives.slice(0, 8).map(async a => {
          const sri = await this.riskStore!.getSriForCountry(a.country);
          if (sri) riskScores.set(a.country, sri.score);
        }),
      );
    }

    const best = alternatives[0]!;

    // Build structured recommendations (top 6 alternatives)
    const recommendations: SourcingRecommendation[] = alternatives.slice(0, 6).map(a => ({
      sku: skuId,
      currentCountry,
      recommendedCountry: a.country,
      currentCostUSD: currentCost,
      recommendedCostUSD: a.altLanded,
      annualSavingsUSD: a.annualSavings,
      tariffRate: a.rate,
      riskScore: riskScores.get(a.country) ?? 50,
      riskAlerts: [],
    }));

    // Build answer text
    const lines = [
      ...alternatives.slice(0, 6).map(a =>
        a.annualSavings > 0
          ? `Switching from ${currentCountry} to ${a.country}:\n- Savings: $${a.annualSavings.toLocaleString()}/yr\n- Tariff: ${a.rate}%\n- Landed cost: $${a.altLanded.toFixed(2)}/unit`
          : `Switching from ${currentCountry} to ${a.country}:\n- Additional cost: $${Math.abs(a.annualSavings).toLocaleString()}/yr\n- Tariff: ${a.rate}%\n- Landed cost: $${a.altLanded.toFixed(2)}/unit`,
      ),
      `\n**Best Alternative: ${best.country}**\n- Savings: $${best.annualSavings > 0 ? best.annualSavings.toLocaleString() : '0'}/yr\n- Tariff: ${best.rate}%\n- Landed cost: $${best.altLanded.toFixed(2)}/unit`,
    ];

    const answer = lines.join('\n');

    return {
      answer,
      recommendations,
      source: 'local',
    };
  }
}
