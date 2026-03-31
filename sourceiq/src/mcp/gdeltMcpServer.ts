// src/mcp/gdeltMcpServer.ts — GDELT news search via MCP protocol
// Tools: search_gdelt_news, get_top_conflict_news
// Source: GDELT Project API (free, no API key, real-time global news index)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { searchGdeltDirect, fetchGdeltSignals } from '../tools/gdeltFetcher';
import { GDELT_ENDPOINT } from '../lib/env';

export function createGdeltMcpServer(): Server {
  const server = new Server(
    { name: 'sourceiq-gdelt', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_gdelt_news',
        description:
          'Search GDELT for live conflict, trade, and geopolitical news for a specific country. ' +
          'GDELT indexes 100+ global news sources in real time. Returns top articles from the last 24 hours.',
        inputSchema: {
          type: 'object',
          properties: {
            country: {
              type: 'string',
              description: 'Country to search news for (e.g. "Iran", "China", "India")',
            },
            maxResults: {
              type: 'number',
              description: 'Max articles to return (default 5, max 15)',
            },
          },
          required: ['country'],
        },
      },
      {
        name: 'get_top_conflict_news',
        description:
          'Get the top global conflict and trade disruption news from GDELT right now. ' +
          'Returns the most relevant articles across all monitored countries from the last 24h.',
        inputSchema: {
          type: 'object',
          properties: {
            country: {
              type: 'string',
              description: 'Optional: filter to a specific country',
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, string | number>;

    switch (name) {
      case 'search_gdelt_news': {
        const country    = String(a['country'] ?? '');
        const maxResults = Math.min(Number(a['maxResults'] ?? 5), 15);

        if (!country) {
          return { content: [{ type: 'text', text: 'Please specify a country to search.' }] };
        }

        const articles = await searchGdeltDirect(country, GDELT_ENDPOINT, maxResults);

        if (!articles.length) {
          return {
            content: [{
              type: 'text',
              text: `No GDELT articles found for "${country}" in the last 24 hours.\n` +
                    `This may indicate low news volume or a GDELT rate limit. Try again shortly.`,
            }],
          };
        }

        const lines = [
          `GDELT NEWS SEARCH: "${country}" — Last 24 hours`,
          `${articles.length} article(s) found:`,
          '',
          ...articles.map((a, i) => [
            `${i + 1}. ${a.title}`,
            `   Source: ${a.domain} | ${new Date(a.date).toLocaleString()}`,
            `   URL: ${a.url}`,
          ].join('\n')),
        ];

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'get_top_conflict_news': {
        const country = a['country'] ? String(a['country']) : '';

        let articles: { title: string; url: string; domain: string; date: string }[];

        if (country) {
          articles = await searchGdeltDirect(country, GDELT_ENDPOINT, 8);
        } else {
          // Use batch signals from the cycle cache — broadest conflict coverage
          const HIGH_RISK = ['Iran', 'Ukraine', 'Russia', 'Yemen', 'Sudan', 'Myanmar', 'Taiwan', 'China'];
          const allSignals = (
            await Promise.allSettled(HIGH_RISK.map(c => fetchGdeltSignals(c, GDELT_ENDPOINT)))
          )
            .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof fetchGdeltSignals>>> => r.status === 'fulfilled')
            .flatMap(r => r.value);

          articles = allSignals.slice(0, 10).map(s => ({
            title:  s.headline,
            url:    s.url ?? '',
            domain: s.source,
            date:   s.timestamp,
          }));
        }

        if (!articles.length) {
          return { content: [{ type: 'text', text: 'No conflict news available right now. GDELT may be rate-limited.' }] };
        }

        const lines = [
          country
            ? `TOP CONFLICT NEWS: "${country}" — Last 24 hours`
            : 'TOP GLOBAL CONFLICT & TRADE NEWS — Last 24 hours',
          '',
          ...articles.map((a, i) =>
            `${i + 1}. [${new Date(a.date).toLocaleDateString()}] ${a.title}\n   ${a.domain}`,
          ),
        ];

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
    const server = createGdeltMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
