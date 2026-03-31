// src/mcp/commodityMcpServer.ts — live commodity prices via MCP protocol
// Tools: get_oil_price, get_shipping_index, get_commodity_prices
// Data source: Stooq (free, no API key, live market data)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  fetchOilPrices,
  fetchShippingIndex,
  fetchCommodityPrices,
} from '../tools/commodityFetcher';

export function createCommodityMcpServer(): Server {
  const server = new Server(
    { name: 'sourceiq-commodity', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_oil_price',
        description:
          'Get live WTI and Brent crude oil prices (USD/barrel) from Stooq. ' +
          'Includes freight surcharge impact assessment for retail sourcing.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_shipping_index',
        description:
          'Get the live Baltic Dry Index (BDI) — the global benchmark for bulk shipping costs. ' +
          'High BDI = expensive to ship from Asia; signals supply chain cost pressure.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_commodity_prices',
        description:
          'Get live prices for cotton (USD/lb) and copper (USD/lb) from Stooq. ' +
          'Cotton affects textile/apparel sourcing costs. Copper affects electronics manufacturing.',
        inputSchema: {
          type: 'object',
          properties: {
            commodity: {
              type: 'string',
              enum: ['cotton', 'copper', 'all'],
              description: 'Which commodity to fetch. Defaults to all.',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, string>;

    switch (name) {
      case 'get_oil_price': {
        const oil = await fetchOilPrices();
        const wtiChange  = oil.wti.change1d  !== undefined ? ` (${oil.wti.change1d  > 0 ? '+' : ''}${oil.wti.change1d}% today)`  : '';
        const brentChange = oil.brent.change1d !== undefined ? ` (${oil.brent.change1d > 0 ? '+' : ''}${oil.brent.change1d}% today)` : '';
        return {
          content: [{
            type: 'text',
            text: [
              `LIVE OIL PRICES (as of ${oil.wti.date}):`,
              `  WTI Crude:   $${oil.wti.price}/barrel${wtiChange}`,
              `  Brent Crude: $${oil.brent.price}/barrel${brentChange}`,
              ``,
              `Freight Surcharge Impact: ${oil.freightImpact}`,
              ``,
              `Sourcing Implications:`,
              `  • Oil-importing countries (China, India, Bangladesh, Vietnam) face higher input costs`,
              `  • Every $10/barrel rise adds ~3-5% to ocean freight surcharges`,
              `  • Petrochemical inputs (plastics, synthetic textiles) correlate directly with oil price`,
            ].join('\n'),
          }],
        };
      }

      case 'get_shipping_index': {
        const shipping = await fetchShippingIndex();
        const bdiChange = shipping.bdi.change1d !== undefined
          ? ` (${shipping.bdi.change1d > 0 ? '+' : ''}${shipping.bdi.change1d}% today)`
          : '';
        return {
          content: [{
            type: 'text',
            text: [
              `LIVE BALTIC DRY INDEX (as of ${shipping.bdi.date}):`,
              `  BDI: ${shipping.bdi.price} points${bdiChange}`,
              ``,
              `Shipping Cost Assessment: ${shipping.freightImpact}`,
              ``,
              `BDI Reference:`,
              `  < 1,000 — Cheap shipping (buyer advantage)`,
              `  1,000–2,000 — Normal range`,
              `  2,000–3,000 — Elevated (book early)`,
              `  > 3,000 — High (similar to 2021 supply chain crunch)`,
              `  > 4,000 — Crisis level`,
            ].join('\n'),
          }],
        };
      }

      case 'get_commodity_prices': {
        const bundle = await fetchCommodityPrices();
        const filter = a['commodity'] ?? 'all';
        const lines: string[] = [`LIVE COMMODITY PRICES (as of ${bundle.cotton.date}):`];

        if (filter === 'all' || filter === 'cotton') {
          const ch = bundle.cotton.change1d !== undefined
            ? ` (${bundle.cotton.change1d > 0 ? '+' : ''}${bundle.cotton.change1d}% today)` : '';
          lines.push(
            `  Cotton (ICE Futures): $${bundle.cotton.price}/lb${ch}`,
            `  → Directly affects apparel/textile sourcing costs from Bangladesh, India, Vietnam`,
          );
        }

        if (filter === 'all') lines.push('');

        if (filter === 'all' || filter === 'copper') {
          const ch = bundle.copper.change1d !== undefined
            ? ` (${bundle.copper.change1d > 0 ? '+' : ''}${bundle.copper.change1d}% today)` : '';
          lines.push(
            `  Copper (COMEX Futures): $${bundle.copper.price}/lb${ch}`,
            `  → Key input for electronics manufacturing (China, Taiwan, Vietnam)`,
          );
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

// CLI entry point
if (require.main === module) {
  void (async () => {
    const server = createCommodityMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
