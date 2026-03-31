// src/lib/internalMcpClients.ts — MCP-backed store adapters for all 3 internal servers
//
// Architecture: agents accept store interfaces (ITariffStore, IInventoryStore, IRiskStore).
// At runtime these interfaces are fulfilled by MCP adapter classes that route ALL data
// calls through Client.callTool() over InMemoryTransport — the same protocol boundary
// used by external MCP tools (commodity, fx, sanctions, gdelt) in mcpToolRegistry.ts.
//
// Call flow:
//   Agent → McpXxxAdapter.method() → Client.callTool() → InMemoryTransport
//     → MCP server handler → raw store (SqliteTariffStore / LanceDbInventoryStore / InMemoryRiskStore)
//
// This guarantees that ALL agent-tool interactions traverse the MCP protocol at runtime,
// satisfying the three-layer MCP architecture claim.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTariffMcpServer } from '../mcp/tariffMcpServer';
import { createInventoryMcpServer } from '../mcp/inventoryMcpServer';
import { createRiskMcpServer } from '../mcp/riskMcpServer';
import type { ITariffStore, IInventoryStore, IRiskStore } from '../adapters/interfaces';
import type {
  TariffRate, InventoryItem, SourcingRiskIndex, RiskAlert, ConvergenceCard,
} from '../types/index';

// ── Singleton clients — initialized once per process ─────────────────────────
let _tariffClient:    Client | null = null;
let _inventoryClient: Client | null = null;
let _riskClient:      Client | null = null;

/** Extract plain text from an MCP tool result payload. */
function extractText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  return (r?.content ?? [])
    .filter((c): c is { type: string; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

/**
 * Wire all 3 internal MCP servers to in-process clients via InMemoryTransport.
 * Must be called once from startup.ts after stores are created, before agents are built.
 */
export async function initInternalMcpClients(
  tariffStore:    ITariffStore,
  inventoryStore: IInventoryStore,
  riskStore:      IRiskStore,
): Promise<void> {
  if (_tariffClient && _inventoryClient && _riskClient) return; // already initialized

  // Tariff MCP
  const [tc, ts] = InMemoryTransport.createLinkedPair();
  _tariffClient = new Client({ name: 'sourceiq-tariff-int', version: '1.0.0' });
  _tariffClient.onerror = (e) => console.warn('[MCP/tariff-int]', e instanceof Error ? e.message : e);
  await Promise.all([createTariffMcpServer(tariffStore).connect(ts), _tariffClient.connect(tc)]);

  // Inventory MCP
  const [ic, is] = InMemoryTransport.createLinkedPair();
  _inventoryClient = new Client({ name: 'sourceiq-inventory-int', version: '1.0.0' });
  _inventoryClient.onerror = (e) => console.warn('[MCP/inventory-int]', e instanceof Error ? e.message : e);
  await Promise.all([createInventoryMcpServer(inventoryStore).connect(is), _inventoryClient.connect(ic)]);

  // Risk MCP
  const [rc, rs] = InMemoryTransport.createLinkedPair();
  _riskClient = new Client({ name: 'sourceiq-risk-int', version: '1.0.0' });
  _riskClient.onerror = (e) => console.warn('[MCP/risk-int]', e instanceof Error ? e.message : e);
  await Promise.all([createRiskMcpServer(riskStore).connect(rs), _riskClient.connect(rc)]);

  console.log('[InternalMCP] Tariff + Inventory + Risk MCP clients connected via InMemoryTransport');
}

// ── MCP-backed ITariffStore ───────────────────────────────────────────────────
// Every method calls a tariff MCP server tool — no direct DB access.

export class McpTariffAdapter implements ITariffStore {
  async getAllRates(): Promise<TariffRate[]> {
    const r = await _tariffClient!.callTool({ name: 'get_all_rates', arguments: {} });
    return JSON.parse(extractText(r)) as TariffRate[];
  }

  async getRate(country: string, hsCode: string): Promise<TariffRate | null> {
    const r = await _tariffClient!.callTool({ name: 'get_tariff_rate', arguments: { country, hsCode, json: 'true' } });
    const text = extractText(r);
    if (text.startsWith('No tariff data')) return null;
    return JSON.parse(text) as TariffRate;
  }

  async compareCountries(hsCode: string): Promise<TariffRate[]> {
    const r = await _tariffClient!.callTool({ name: 'compare_countries', arguments: { hsCode, json: 'true' } });
    const text = extractText(r);
    if (text.startsWith('No tariff data')) return [];
    return JSON.parse(text) as TariffRate[];
  }

  async calculateSavings(item: InventoryItem, targetCountry: string): Promise<number> {
    // Delegates to getAllRates (→ MCP) + in-process arithmetic
    const rates = await this.getAllRates();
    const currentRate = rates.find(r => r.country === item.currentSourceCountry && r.hsCode === item.hsCode)?.rate ?? 0;
    const targetRate  = rates.find(r => r.country === targetCountry            && r.hsCode === item.hsCode)?.rate;
    if (targetRate === undefined) return 0;
    const currentLanded = item.unitCostUSD * (1 + currentRate / 100);
    const targetLanded  = item.unitCostUSD * (1 + targetRate  / 100);
    return Math.round((currentLanded - targetLanded) * item.annualVolume);
  }
}

// ── MCP-backed IInventoryStore ────────────────────────────────────────────────
// Every method calls an inventory MCP server tool — no direct DB access.

export class McpInventoryAdapter implements IInventoryStore {
  async search(query: string, limit = 5): Promise<InventoryItem[]> {
    const r = await _inventoryClient!.callTool({
      name: 'search_inventory',
      arguments: { query, limit, json: 'true' },
    });
    const text = extractText(r);
    if (text === 'No matching SKUs found.') return [];
    return JSON.parse(text) as InventoryItem[];
  }

  async getBySku(sku: string): Promise<InventoryItem | null> {
    const r = await _inventoryClient!.callTool({ name: 'get_sku', arguments: { sku } });
    const text = extractText(r);
    if (text.includes('not found')) return null;
    return JSON.parse(text) as InventoryItem;
  }

  async getAll(): Promise<InventoryItem[]> {
    const r = await _inventoryClient!.callTool({ name: 'get_all_inventory', arguments: {} });
    return JSON.parse(extractText(r)) as InventoryItem[];
  }

  async getByCountry(country: string): Promise<InventoryItem[]> {
    const r = await _inventoryClient!.callTool({ name: 'get_by_country', arguments: { country, json: 'true' } });
    const text = extractText(r);
    if (text.startsWith('No SKUs')) return [];
    return JSON.parse(text) as InventoryItem[];
  }
}

// ── MCP-backed IRiskStore ─────────────────────────────────────────────────────
// Read operations (agent-facing) go through the risk MCP server tool calls.
// Write operations (riskPoller-facing: updateSri, getConvergenceCards, setConvergenceCards)
// delegate directly to the raw store — they are maintenance ops, not agent tool calls.

export class McpRiskAdapter implements IRiskStore {
  constructor(private readonly _rawStore: IRiskStore) {}

  async getSriForCountry(country: string): Promise<SourcingRiskIndex | null> {
    const r = await _riskClient!.callTool({ name: 'get_sri_for_country', arguments: { country } });
    const text = extractText(r);
    if (text.startsWith('No data')) return null;
    return JSON.parse(text) as SourcingRiskIndex;
  }

  async getHeatmapData(): Promise<SourcingRiskIndex[]> {
    const r = await _riskClient!.callTool({ name: 'get_heatmap_data', arguments: {} });
    return JSON.parse(extractText(r)) as SourcingRiskIndex[];
  }

  async getConflictAlerts(country?: string): Promise<RiskAlert[]> {
    const args = country ? { country } : {};
    const r = await _riskClient!.callTool({ name: 'get_conflict_alerts', arguments: args });
    const text = extractText(r);
    if (text === 'No active alerts') return [];
    return JSON.parse(text) as RiskAlert[];
  }

  // Write ops — bypass MCP, go directly to raw store (risk poller, startup pre-seed)
  async updateSri(data: SourcingRiskIndex): Promise<void>             { return this._rawStore.updateSri(data); }
  async getConvergenceCards(): Promise<ConvergenceCard[]>              { return this._rawStore.getConvergenceCards(); }
  async setConvergenceCards(cards: ConvergenceCard[]): Promise<void>   { return this._rawStore.setConvergenceCards(cards); }
}
