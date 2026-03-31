// src/lib/countryConfig.ts — singleton accessor for the country config store
// Initialized once at startup via initCountryConfig().
// All consumers call getCountryConfig() — no imports of concrete DB classes.
//
// Uses globalThis so the store survives Next.js dev-mode per-route module
// re-evaluation. Without this, each route bundle gets _store = null even after
// another bundle has already initialized it.

import type { ICountryConfigStore } from '../adapters/interfaces';

declare global {
  // eslint-disable-next-line no-var
  var __sourceIQCountryConfig: ICountryConfigStore | undefined;
}

/** Called once in startup.ts after the DB is ready. */
export function initCountryConfig(store: ICountryConfigStore): void {
  globalThis.__sourceIQCountryConfig = store;
}

/**
 * Returns the loaded country config store.
 * Throws if called before initCountryConfig() — indicates a startup ordering bug.
 */
export function getCountryConfig(): ICountryConfigStore {
  if (!globalThis.__sourceIQCountryConfig) {
    throw new Error('[CountryConfig] Not initialized — call initCountryConfig() at startup before using country config');
  }
  return globalThis.__sourceIQCountryConfig;
}
