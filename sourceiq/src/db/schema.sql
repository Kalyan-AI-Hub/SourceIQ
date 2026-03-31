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
