import { describe, it, expect } from 'vitest';
import { calculateSri } from '../src/services/riskScorer';

describe('calculateSri', () => {
  it('Yemen SRI >= 85 (active conflict floor)', () => {
    const sri = calculateSri({
      country: 'Yemen',
      signals: [],
      baselineRisk: 0,
      tariffRate: 0,
      doNotTravel: false,
      previousScores: [],
    });
    expect(sri.score).toBeGreaterThanOrEqual(85);
    expect(sri.tier).toBe('critical');
  });

  it('Mexico SRI <= 35 (no conflict, low tariff, no floor)', () => {
    const sri = calculateSri({
      country: 'Mexico',
      signals: [],
      baselineRisk: 10,
      tariffRate: 5,
      doNotTravel: false,
      previousScores: [],
    });
    expect(sri.score).toBeLessThanOrEqual(35);
  });

  it('sanctions floor — Russia SRI >= 75', () => {
    const sri = calculateSri({
      country: 'Russia',
      signals: [],
      baselineRisk: 0,
      tariffRate: 0,
      doNotTravel: false,
      previousScores: [],
    });
    expect(sri.score).toBeGreaterThanOrEqual(75);
  });

  it('do-not-travel floor — SRI >= 65', () => {
    const sri = calculateSri({
      country: 'TestCountry',
      signals: [],
      baselineRisk: 0,
      tariffRate: 0,
      doNotTravel: true,
      previousScores: [],
    });
    expect(sri.score).toBeGreaterThanOrEqual(65);
  });
});
