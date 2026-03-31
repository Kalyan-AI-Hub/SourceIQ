// src/adapters/inMemoryRisk.ts — implements IRiskStore as an in-memory store
// Used by riskPoller. SRI scores are cached here after each poll cycle.
// RULE 2: Only file that knows about internal data structure. Inject via IRiskStore.

import type { IRiskStore } from './interfaces';
import type { SourcingRiskIndex, RiskAlert, ConvergenceCard } from '../types/index';
import { riskEmitter } from '../lib/riskEvents';

export class InMemoryRiskStore implements IRiskStore {
  private readonly sriMap = new Map<string, SourcingRiskIndex>();
  private convergenceCards: ConvergenceCard[] = [];

  async getSriForCountry(country: string): Promise<SourcingRiskIndex | null> {
    return this.sriMap.get(country) ?? null;
  }

  async getHeatmapData(): Promise<SourcingRiskIndex[]> {
    return Array.from(this.sriMap.values());
  }

  async getConflictAlerts(country?: string): Promise<RiskAlert[]> {
    const entries = country
      ? [this.sriMap.get(country)].filter(Boolean) as SourcingRiskIndex[]
      : Array.from(this.sriMap.values());

    return entries.flatMap(sri => sri.activeAlerts);
  }

  async updateSri(data: SourcingRiskIndex): Promise<void> {
    this.sriMap.set(data.country, data);
    riskEmitter.emit('update', data.country);
  }

  async getConvergenceCards(): Promise<ConvergenceCard[]> {
    return this.convergenceCards;
  }

  async setConvergenceCards(cards: ConvergenceCard[]): Promise<void> {
    this.convergenceCards = cards;
    riskEmitter.emit('convergence');
  }
}
