// src/mcp/inventoryMcpServer.ts — exposes inventory tools via MCP protocol
// Layer 2: MCP servers expose tools; agents call these via MCP — never IInventoryStore directly.
// RULE 1: depends on IInventoryStore interface only. Never imports LanceDbInventoryStore.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { IInventoryStore } from '../adapters/interfaces';

export function createInventoryMcpServer(inventoryStore: IInventoryStore): Server {
  const server = new Server(
    { name: 'sourceiq-inventory', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_inventory',
        description: 'Semantic search across all inventory SKUs using natural language',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            limit: { type: 'number', description: 'Max results (default 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_sku',
        description: 'Look up a specific SKU by its identifier',
        inputSchema: {
          type: 'object',
          properties: {
            sku: { type: 'string', description: 'SKU identifier (e.g. SKU-023)' },
          },
          required: ['sku'],
        },
      },
      {
        name: 'get_by_country',
        description: 'Get all SKUs currently sourced from a given country',
        inputSchema: {
          type: 'object',
          properties: {
            country: { type: 'string', description: 'Country name (e.g. China, Vietnam)' },
          },
          required: ['country'],
        },
      },
      {
        name: 'get_all_inventory',
        description: 'Retrieve the full inventory list (use sparingly — prefer search)',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'country_exposure_summary',
        description: 'Summarize how many SKUs and total annual volume are sourced from each country',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, string | number>;

    switch (name) {
      case 'search_inventory': {
        const query = a['query'] as string;
        const limit = typeof a['limit'] === 'number' ? a['limit'] : 5;
        const results = await inventoryStore.search(query, limit);
        if (!results.length) return { content: [{ type: 'text', text: 'No matching SKUs found.' }] };
        // json=true → raw JSON for machine-consumption by internal MCP client adapters
        if (a['json'] === 'true') {
          return { content: [{ type: 'text', text: JSON.stringify(results) }] };
        }
        const lines = results.map(r =>
          `${r.sku}: ${r.name} — ${r.currentSourceCountry} @ $${r.unitCostUSD} (vol: ${r.annualVolume.toLocaleString()}/yr)`,
        );
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'get_sku': {
        const item = await inventoryStore.getBySku(a['sku'] as string);
        if (!item) return { content: [{ type: 'text', text: `SKU ${a['sku']} not found.` }] };
        return { content: [{ type: 'text', text: JSON.stringify(item) }] };
      }

      case 'get_by_country': {
        const items = await inventoryStore.getByCountry(a['country'] as string);
        if (!items.length) {
          return { content: [{ type: 'text', text: `No SKUs sourced from ${a['country']}.` }] };
        }
        // json=true → raw JSON for machine-consumption by internal MCP client adapters
        if (a['json'] === 'true') {
          return { content: [{ type: 'text', text: JSON.stringify(items) }] };
        }
        const lines = items.map(r =>
          `${r.sku}: ${r.name} — $${r.unitCostUSD} × ${r.annualVolume.toLocaleString()}/yr`,
        );
        return {
          content: [{
            type: 'text',
            text: `${items.length} SKUs from ${a['country']}:\n${lines.join('\n')}`,
          }],
        };
      }

      case 'get_all_inventory': {
        const items = await inventoryStore.getAll();
        return { content: [{ type: 'text', text: JSON.stringify(items) }] };
      }

      case 'country_exposure_summary': {
        const items = await inventoryStore.getAll();
        const summary = new Map<string, { skus: number; volume: number; spend: number }>();
        for (const item of items) {
          const existing = summary.get(item.currentSourceCountry) ?? { skus: 0, volume: 0, spend: 0 };
          existing.skus++;
          existing.volume += item.annualVolume;
          existing.spend  += item.unitCostUSD * item.annualVolume;
          summary.set(item.currentSourceCountry, existing);
        }
        const sorted = Array.from(summary.entries()).sort((a, b) => b[1].spend - a[1].spend);
        const lines = sorted.map(([country, data]) =>
          `${country}: ${data.skus} SKUs, ${data.volume.toLocaleString()} units/yr, $${Math.round(data.spend).toLocaleString()} base spend`,
        );
        return { content: [{ type: 'text', text: `Country exposure:\n${lines.join('\n')}` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

// CLI entry point — run as standalone MCP server via stdio
if (require.main === module) {
  void (async () => {
    const { LanceDbInventoryStore } = await import('../adapters/lanceDbInventory');
    const { createFoundryLocalClient }  = await import('../lib/foundryLocal');
    const { LANCEDB_PATH } = await import('../lib/env');
    const foundry = createFoundryLocalClient();
    const store = new LanceDbInventoryStore(LANCEDB_PATH, foundry);
    const server = createInventoryMcpServer(store);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
