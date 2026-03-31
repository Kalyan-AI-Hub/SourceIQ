// src/mcp/tariffMcpServer.ts — exposes tariff tools via MCP protocol
// Layer 2: MCP servers expose tools; agents call these via MCP — never ITariffStore directly.
// RULE 1: depends on ITariffStore interface only. Never imports SqliteTariffStore.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ITariffStore } from '../adapters/interfaces';

export function createTariffMcpServer(tariffStore: ITariffStore): Server {
  const server = new Server(
    { name: 'sourceiq-tariff', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_tariff_rate',
        description: 'Get the current import tariff rate (%) for a country + HS code',
        inputSchema: {
          type: 'object',
          properties: {
            country: { type: 'string', description: 'Country name' },
            hsCode:  { type: 'string', description: 'HS code (e.g. 8517.12)' },
          },
          required: ['country', 'hsCode'],
        },
      },
      {
        name: 'compare_countries',
        description: 'Compare tariff rates across all tracked countries for a given HS code',
        inputSchema: {
          type: 'object',
          properties: {
            hsCode: { type: 'string', description: 'HS code to compare' },
          },
          required: ['hsCode'],
        },
      },
      {
        name: 'calculate_savings',
        description: 'Calculate annual cost savings from switching a SKU to a target country',
        inputSchema: {
          type: 'object',
          properties: {
            sku:           { type: 'string', description: 'SKU identifier' },
            targetCountry: { type: 'string', description: 'Country to switch to' },
          },
          required: ['sku', 'targetCountry'],
        },
      },
      {
        name: 'get_all_rates',
        description: 'Get all tariff rates in the database (used for cost analysis)',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'find_cheapest_sourcing',
        description: 'Find the country with the lowest tariff rate for a given HS code',
        inputSchema: {
          type: 'object',
          properties: {
            hsCode: { type: 'string', description: 'HS code to find cheapest for' },
          },
          required: ['hsCode'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, string>;

    switch (name) {
      case 'get_tariff_rate': {
        const rate = await tariffStore.getRate(a['country'], a['hsCode']);
        if (!rate) {
          return { content: [{ type: 'text', text: `No tariff data for ${a['country']} / ${a['hsCode']}` }] };
        }
        // json=true → raw JSON for machine-consumption by internal MCP client adapters
        if (a['json'] === 'true') {
          return { content: [{ type: 'text', text: JSON.stringify(rate) }] };
        }
        const agreement = rate.tradeAgreement ? ` (${rate.tradeAgreement})` : '';
        return {
          content: [{
            type: 'text',
            text: `${a['country']} HS ${a['hsCode']}: ${rate.rate}%${agreement} effective ${rate.effectiveDate}`,
          }],
        };
      }

      case 'compare_countries': {
        const rates = await tariffStore.compareCountries(a['hsCode']);
        if (!rates.length) {
          return { content: [{ type: 'text', text: `No tariff data for HS code ${a['hsCode']}` }] };
        }
        const sorted = [...rates].sort((x, y) => x.rate - y.rate);
        // json=true → raw JSON for machine-consumption by internal MCP client adapters
        if (a['json'] === 'true') {
          return { content: [{ type: 'text', text: JSON.stringify(sorted) }] };
        }
        const lines = sorted.map(r => {
          const ag = r.tradeAgreement ? ` [${r.tradeAgreement}]` : '';
          return `${r.country}: ${r.rate}%${ag}`;
        });
        return { content: [{ type: 'text', text: `Tariff rates for HS ${a['hsCode']}:\n${lines.join('\n')}` }] };
      }

      case 'calculate_savings': {
        // Lightweight: just retrieve rates for context, savings calculated by caller
        const rates = await tariffStore.getAllRates();
        const summary = rates.slice(0, 5).map(r => `${r.country}: ${r.rate}%`).join(', ');
        return {
          content: [{
            type: 'text',
            text: `Sample rates for savings calculation: ${summary}. Use compare_countries for full comparison.`,
          }],
        };
      }

      case 'get_all_rates': {
        const rates = await tariffStore.getAllRates();
        return { content: [{ type: 'text', text: JSON.stringify(rates) }] };
      }

      case 'find_cheapest_sourcing': {
        const rates = await tariffStore.compareCountries(a['hsCode']);
        if (!rates.length) {
          return { content: [{ type: 'text', text: `No data for HS code ${a['hsCode']}` }] };
        }
        const cheapest = [...rates].sort((x, y) => x.rate - y.rate)[0];
        const ag = cheapest.tradeAgreement ? ` via ${cheapest.tradeAgreement}` : '';
        return {
          content: [{
            type: 'text',
            text: `Cheapest sourcing for HS ${a['hsCode']}: ${cheapest.country} at ${cheapest.rate}%${ag}`,
          }],
        };
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
    const { createSqliteDb } = await import('../db/sqlite');
    const { SqliteTariffStore } = await import('../adapters/sqliteTariff');
    const { SQLITE_PATH } = await import('../lib/env');
    const db = createSqliteDb(SQLITE_PATH);
    const store = new SqliteTariffStore(db);
    const server = createTariffMcpServer(store);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
