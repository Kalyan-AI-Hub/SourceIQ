// src/mcp/fxMcpServer.ts — live FX exchange rates via MCP protocol
// Tool: get_fx_rates
// Source: frankfurter.app (ECB daily rates, free, no API key)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fetchFxRates } from '../tools/exchangeRateFetcher';
import { getCountryConfig } from '../lib/countryConfig';

export function createFxMcpServer(): Server {
  const server = new Server(
    { name: 'sourceiq-fx', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_fx_rates',
        description:
          'Get live USD exchange rates for all sourcing country currencies (ECB via frankfurter.app). ' +
          'Use to calculate actual cost exposure when local currency fluctuates against USD.',
        inputSchema: {
          type: 'object',
          properties: {
            country: {
              type: 'string',
              description: 'Optional: filter to a specific country (e.g. "China", "India"). Returns all if omitted.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name !== 'get_fx_rates') throw new Error(`Unknown tool: ${name}`);

    const country = ((args ?? {}) as Record<string, string>)['country'];
    const rates = await fetchFxRates();

    if (Object.keys(rates).length === 0) {
      return { content: [{ type: 'text', text: 'FX rates temporarily unavailable — ECB/frankfurter.app unreachable.' }] };
    }

    const lines: string[] = [`LIVE USD EXCHANGE RATES (ECB via frankfurter.app):`];
    lines.push(`Updated: ${new Date().toUTCString()}`);
    lines.push('');

    // If country is specified, show just that one with context
    if (country) {
      const currency = getCountryConfig().getCurrency(country);
      if (!currency) {
        return { content: [{ type: 'text', text: `No currency mapping for "${country}".` }] };
      }
      const rate = rates[currency];
      if (!rate) {
        return { content: [{ type: 'text', text: `No live rate available for ${currency} (${country}).` }] };
      }
      lines.push(`${country}: 1 USD = ${rate} ${currency}`);
      lines.push(`Inverse: 1 ${currency} = $${(1 / rate).toFixed(4)} USD`);
      lines.push('');
      lines.push(`Sourcing Impact: A weaker ${currency} (higher number) means your USD buys more locally — ` +
        `lower effective cost from ${country} suppliers paying in local currency.`);
    } else {
      // Show all countries from DB
      for (const [c, currency] of Object.entries(getCountryConfig().getCurrencyMap())) {
        const rate = rates[currency];
        if (rate) {
          lines.push(`  ${c.padEnd(15)} ${currency}: 1 USD = ${rate}`);
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  return server;
}

// CLI entry point — init country config from DB before handling any requests
if (require.main === module) {
  void (async () => {
    const { createSqliteDb } = await import('../db/sqlite');
    const { SqliteCountryConfigStore } = await import('../adapters/sqliteCountryConfig');
    const { initCountryConfig } = await import('../lib/countryConfig');
    const { SQLITE_PATH } = await import('../lib/env');
    initCountryConfig(new SqliteCountryConfigStore(createSqliteDb(SQLITE_PATH)));

    const server = createFxMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
