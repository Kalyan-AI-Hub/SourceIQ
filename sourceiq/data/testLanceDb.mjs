// Final verification test
import { connect } from 'vectordb';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, 'lancedb');

const db = await connect(dbPath);
const table = await db.openTable('inventory');
const DUMMY_VEC = new Array(384).fill(0.1);

const all = await table.search(DUMMY_VEC).limit(500).execute();
console.log(`Total rows via search: ${all.length}`);

const countries = {};
all.forEach(r => { countries[r.currentSourceCountry] = (countries[r.currentSourceCountry] || 0) + 1; });
console.log('Countries:', countries);

const china = all.filter(r => r.currentSourceCountry === 'China');
console.log(`\nChina items: ${china.length}`);
china.forEach(r => console.log(`  ${r.sku} | $${r.unitCostUSD} | vol=${r.annualVolume} | hs=${r.hsCode}`));
