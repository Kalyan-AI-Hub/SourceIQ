import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

import { createSqliteDb } from '../src/db/sqlite';
import { env } from '../src/lib/env';

const tariffs  = require('./tariffs.json')  as { country: string; hsCode: string; rate: number; tradeAgreement: string | null; expiryDate?: string; effectiveDate: string }[];
const suppliers = require('./suppliers.json') as { country: string; category: string; leadTimeDays: number; reliabilityScore: number; carbonScore: number; minimumOrderQuantity: number }[];

const db = createSqliteDb(env.SQLITE_PATH);

const insertTariff = db.prepare(
  `INSERT OR REPLACE INTO tariffs (country, hsCode, rate, tradeAgreement, expiryDate, effectiveDate)
   VALUES (@country, @hsCode, @rate, @tradeAgreement, @expiryDate, @effectiveDate)`
);

const insertSupplier = db.prepare(
  `INSERT OR REPLACE INTO suppliers (country, category, leadTimeDays, reliabilityScore, carbonScore, minimumOrderQuantity)
   VALUES (@country, @category, @leadTimeDays, @reliabilityScore, @carbonScore, @minimumOrderQuantity)`
);

const seedTariffs  = db.transaction(() => {
  for (const row of tariffs) {
    insertTariff.run({ expiryDate: null, ...row });
  }
});
const seedSuppliers = db.transaction(() => { for (const row of suppliers) insertSupplier.run(row); });

seedTariffs();
seedSuppliers();

const tariffCount   = (db.prepare('SELECT COUNT(*) as n FROM tariffs').get()   as { n: number }).n;
const supplierCount = (db.prepare('SELECT COUNT(*) as n FROM suppliers').get() as { n: number }).n;

console.log(`✅ Inserted ${tariffCount} tariff rows.`);
console.log(`✅ Inserted ${supplierCount} supplier rows.`);

db.close();
