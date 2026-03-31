/**
 * tests/setup.ts — Global vitest setup
 * Initializes CountryConfig with a minimal in-memory mock so tests that call
 * getCountryConfig() (via calculateSri, executeTool, InventoryAgent, etc.) don't throw.
 * This replaces the need for a live SQLite DB in unit tests.
 */

import { initCountryConfig } from '../src/lib/countryConfig';
import type { ICountryConfigStore, CountryConfigRow } from '../src/adapters/interfaces';

const SANCTIONED  = new Set(['Iran', 'Russia', 'North Korea', 'Cuba', 'Syria', 'Belarus']);
const CONFLICT    = new Set(['Iran', 'Yemen', 'Sudan', 'Somalia', 'Libya', 'Ethiopia', 'Myanmar', 'Ukraine']);
const INSTABILITY = new Set(['Iraq', 'Pakistan', 'Egypt', 'Nigeria', 'Venezuela', 'Haiti', 'Taiwan']);

const CURRENCY_MAP: Record<string, string> = {
  China: 'CNY', India: 'INR', Vietnam: 'VND', Bangladesh: 'BDT', Mexico: 'MXN',
  Turkey: 'TRY', Indonesia: 'IDR', Cambodia: 'KHR', Pakistan: 'PKR', Sri_Lanka: 'LKR',
  Egypt: 'EGP', Jordan: 'JOD', UAE: 'AED', Qatar: 'QAR', Oman: 'OMR', Saudi_Arabia: 'SAR',
  Iran: 'IRR', Russia: 'RUB', Ukraine: 'UAH', Brazil: 'BRL', Peru: 'PEN', Colombia: 'COP',
  South_Korea: 'KRW', Japan: 'JPY', Taiwan: 'TWD', Thailand: 'THB', Malaysia: 'MYR',
  Philippines: 'PHP', Nigeria: 'NGN', Ethiopia: 'ETB', Kenya: 'KES', Ghana: 'GHS',
};

const ISO2_MAP: Record<string, string> = {
  China: 'CN', India: 'IN', Vietnam: 'VN', Bangladesh: 'BD', Mexico: 'MX',
  Turkey: 'TR', Indonesia: 'ID', Cambodia: 'KH', Pakistan: 'PK',
  Egypt: 'EG', Jordan: 'JO', UAE: 'AE', Qatar: 'QA', Oman: 'OM', 'Saudi Arabia': 'SA',
  Iran: 'IR', Russia: 'RU', Ukraine: 'UA', Brazil: 'BR', Peru: 'PE', Colombia: 'CO',
  'South Korea': 'KR', Japan: 'JP', Taiwan: 'TW', Thailand: 'TH', Malaysia: 'MY',
  Philippines: 'PH', Nigeria: 'NG', Ethiopia: 'ET', Kenya: 'KE', Ghana: 'GH',
  Yemen: 'YE', Sudan: 'SD', Somalia: 'SO', Libya: 'LY', Myanmar: 'MM',
  'North Korea': 'KP', Cuba: 'CU', Syria: 'SY', Belarus: 'BY',
};

const SANCTIONS_DETAIL: Record<string, string> = {
  Iran:         'US OFAC comprehensive sanctions — prohibited sourcing',
  Russia:       'US/EU broad sectoral sanctions — restricted sourcing',
  'North Korea':'US OFAC near-total embargo — all trade prohibited',
  Cuba:         'US OFAC embargo — prohibited sourcing',
  Syria:        'US OFAC comprehensive sanctions — prohibited sourcing',
  Belarus:      'US/EU sectoral sanctions — restricted sourcing',
};

// All countries the test suite references
const ALL_COUNTRIES = [
  'China', 'India', 'Vietnam', 'Bangladesh', 'Mexico', 'Turkey', 'Indonesia',
  'Cambodia', 'Pakistan', 'Egypt', 'Jordan', 'UAE', 'Qatar', 'Oman', 'Saudi Arabia',
  'Iran', 'Russia', 'Ukraine', 'Brazil', 'Peru', 'Colombia', 'South Korea',
  'Japan', 'Taiwan', 'Thailand', 'Malaysia', 'Philippines', 'Nigeria', 'Ethiopia',
  'Kenya', 'Ghana', 'Yemen', 'Sudan', 'Somalia', 'Libya', 'Myanmar', 'North Korea',
  'Cuba', 'Syria', 'Belarus', 'Iraq', 'Sri Lanka', 'Venezuela', 'Haiti',
];

const mockCountryConfig: ICountryConfigStore = {
  getAll(): CountryConfigRow[] {
    return ALL_COUNTRIES.map(name => ({
      name,
      iso2: ISO2_MAP[name] ?? null,
      currency: CURRENCY_MAP[name] ?? null,
      isSanctioned: SANCTIONED.has(name),
      isHighRisk: INSTABILITY.has(name),
      isActiveConflict: CONFLICT.has(name),
      isChronicInstability: INSTABILITY.has(name),
      riskScoreOverride: null,
      sanctionsDetail: SANCTIONS_DETAIL[name] ?? null,
    }));
  },
  getHighRiskCountries(): string[] {
    return ALL_COUNTRIES.filter(c => INSTABILITY.has(c));
  },
  getAllCountryNames(): string[] {
    return ALL_COUNTRIES;
  },
  isSanctioned(name: string): boolean {
    return SANCTIONED.has(name);
  },
  isActiveConflict(name: string): boolean {
    return CONFLICT.has(name);
  },
  isChronicInstability(name: string): boolean {
    return INSTABILITY.has(name);
  },
  getCurrency(country: string): string | null {
    return CURRENCY_MAP[country] ?? null;
  },
  getIso2(country: string): string | null {
    return ISO2_MAP[country] ?? null;
  },
  getSanctionsDetail(country: string): string | null {
    return SANCTIONS_DETAIL[country] ?? null;
  },
  getRiskOverride(_country: string): number | null {
    return null;
  },
  getCurrencyMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const c of ALL_COUNTRIES) {
      if (CURRENCY_MAP[c]) map[c] = CURRENCY_MAP[c]!;
    }
    return map;
  },
  getIso2Map(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const c of ALL_COUNTRIES) {
      if (ISO2_MAP[c]) map[c] = ISO2_MAP[c]!;
    }
    return map;
  },
};

// Initialize once for all tests in this process
initCountryConfig(mockCountryConfig);
