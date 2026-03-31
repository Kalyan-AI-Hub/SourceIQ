// src/db/sqlite.ts — factory function (NOT a singleton)
// Always inject the returned Database instance; never import this in agents directly.
// Schema is inlined to avoid __dirname path resolution issues in Next.js webpack bundles.
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tariffs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  country         TEXT    NOT NULL,
  hsCode          TEXT    NOT NULL,
  rate            REAL    NOT NULL,
  tradeAgreement  TEXT,
  expiryDate      TEXT,
  effectiveDate   TEXT    NOT NULL,
  UNIQUE(country, hsCode)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  country               TEXT    NOT NULL,
  category              TEXT    NOT NULL,
  leadTimeDays          INTEGER NOT NULL,
  reliabilityScore      REAL    NOT NULL,
  carbonScore           REAL    NOT NULL,
  minimumOrderQuantity  INTEGER NOT NULL,
  UNIQUE(country, category)
);

-- Single source of truth for all country metadata.
-- Replaces all hardcoded Sets/maps scattered across agents and tools.
-- Add a row here to make a new country visible to the entire system.
CREATE TABLE IF NOT EXISTS country_config (
  name                   TEXT PRIMARY KEY,
  iso2                   TEXT,           -- ISO 3166-1 alpha-2 (World Bank API, map GeoJSON)
  currency               TEXT,           -- ISO 4217 currency code (for FX display)
  is_sanctioned          INTEGER NOT NULL DEFAULT 0,  -- US OFAC comprehensive sanctions
  is_high_risk           INTEGER NOT NULL DEFAULT 0,  -- monitored for geopolitical signals, not sourced
  is_active_conflict     INTEGER NOT NULL DEFAULT 0,  -- active armed conflict → SRI floor 85
  is_chronic_instability INTEGER NOT NULL DEFAULT 0,  -- persistent instability → SRI floor 55
  risk_score_override    INTEGER,        -- override WB baseline (e.g. Taiwan=38, Gaza=90)
  sanctions_detail       TEXT            -- human-readable sanctions description for compliance tool
);

INSERT OR IGNORE INTO country_config
  (name, iso2, currency, is_sanctioned, is_high_risk, is_active_conflict, is_chronic_instability, risk_score_override, sanctions_detail)
VALUES
  ('China',        'CN', 'CNY', 0, 0, 0, 0, NULL, NULL),
  ('Vietnam',      'VN', 'VND', 0, 0, 0, 0, NULL, NULL),
  ('India',        'IN', 'INR', 0, 0, 0, 0, NULL, NULL),
  ('Mexico',       'MX', 'MXN', 0, 0, 0, 0, NULL, NULL),
  ('Bangladesh',   'BD', 'BDT', 0, 0, 0, 0, NULL, NULL),
  ('Cambodia',     'KH', 'KHR', 0, 0, 0, 0, NULL, NULL),
  ('Indonesia',    'ID', 'IDR', 0, 0, 0, 0, NULL, NULL),
  ('Turkey',       'TR', 'TRY', 0, 0, 0, 0, NULL, NULL),
  ('Morocco',      'MA', 'MAD', 0, 0, 0, 0, NULL, NULL),
  ('Brazil',       'BR', 'BRL', 0, 0, 0, 0, NULL, NULL),
  ('Egypt',        'EG', 'EGP', 0, 0, 0, 0, NULL, NULL),
  ('Jordan',       'JO', 'JOD', 0, 0, 0, 0, NULL, NULL),
  ('Saudi Arabia', 'SA', 'SAR', 0, 0, 0, 0, NULL, NULL),
  ('UAE',          'AE', 'AED', 0, 0, 0, 0, NULL, NULL),
  ('Oman',         'OM', 'OMR', 0, 0, 0, 0, NULL, NULL),
  ('Qatar',        'QA', 'QAR', 0, 0, 0, 0, NULL, NULL),
  ('Iran',         'IR', 'IRR', 1, 0, 1, 0, NULL, 'US OFAC comprehensive sanctions — direct sourcing PROHIBITED'),
  ('Yemen',        'YE', 'YER', 0, 1, 1, 0, NULL, NULL),
  ('Sudan',        'SD', 'SDG', 0, 1, 1, 0, NULL, NULL),
  ('Myanmar',      'MM', 'MMK', 0, 1, 1, 0, NULL, NULL),
  ('Iraq',         'IQ', 'IQD', 0, 1, 0, 1, NULL, NULL),
  ('Russia',       'RU', 'RUB', 1, 1, 0, 0, NULL, 'US/EU broad sectoral sanctions since 2022'),
  ('Libya',        'LY', 'LYD', 0, 1, 1, 0, NULL, NULL),
  ('Somalia',      'SO', 'SOS', 0, 1, 1, 0, NULL, NULL),
  ('Ukraine',      'UA', 'UAH', 0, 1, 1, 0, NULL, NULL),
  ('Taiwan',       'TW', 'TWD', 0, 1, 0, 1, 38,   NULL),
  ('North Korea',  'KP', 'KPW', 1, 0, 0, 0, NULL, 'US OFAC comprehensive sanctions — near-total embargo'),
  ('Cuba',         'CU', 'CUP', 1, 0, 0, 0, NULL, 'US CACR sanctions — trade embargo since 1962'),
  ('Syria',        'SY', 'SYP', 1, 1, 1, 0, NULL, 'US OFAC comprehensive sanctions'),
  ('Venezuela',    'VE', 'VES', 1, 0, 0, 0, NULL, 'US OFAC sectoral sanctions'),
  ('Belarus',      'BY', 'BYR', 1, 0, 0, 0, NULL, 'US/EU sectoral sanctions'),
  ('Gaza',         NULL, NULL,  0, 1, 1, 0, 90,   NULL);
`;

export function createSqliteDb(dbPath: string): Database.Database {
  const resolved = path.resolve(dbPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  return db;
}
