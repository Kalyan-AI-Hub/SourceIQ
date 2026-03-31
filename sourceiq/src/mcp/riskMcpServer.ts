// src/mcp/riskMcpServer.ts — exposes risk tools via MCP protocol
// Layer 2: MCP servers expose tools; agents call these via MCP — never IRiskStore directly.
// RULE 1: depends on IRiskStore interface only. Never imports InMemoryRiskStore.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { IRiskStore } from '../adapters/interfaces';
import { getCountryConfig } from '../lib/countryConfig';

export function createRiskMcpServer(riskStore: IRiskStore): Server {
  const server = new Server(
    { name: 'sourceiq-risk', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_risk_score',
        description: 'Get the SourcingRiskIndex score (0-100) for a country',
        inputSchema: {
          type: 'object',
          properties: { country: { type: 'string', description: 'Country name' } },
          required: ['country'],
        },
      },
      {
        name: 'check_sanctions',
        description: 'Check if a country is under US sanctions or has SRI >= 75',
        inputSchema: {
          type: 'object',
          properties: { country: { type: 'string', description: 'Country name' } },
          required: ['country'],
        },
      },
      {
        name: 'get_conflict_alerts',
        description: 'Get active conflict/risk alerts, optionally for a specific country',
        inputSchema: {
          type: 'object',
          properties: { country: { type: 'string', description: 'Country name (optional)' } },
        },
      },
      {
        name: 'get_sri_for_country',
        description: 'Get full SourcingRiskIndex data for a country',
        inputSchema: {
          type: 'object',
          properties: { country: { type: 'string', description: 'Country name' } },
          required: ['country'],
        },
      },
      {
        name: 'get_heatmap_data',
        description: 'Get SRI scores for all tracked countries (used to render the risk heatmap)',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, string>;

    switch (name) {
      case 'get_risk_score': {
        const sri = await riskStore.getSriForCountry(a['country']);
        if (!sri) return { content: [{ type: 'text', text: `No risk data for ${a['country']}` }] };
        return { content: [{ type: 'text', text: `${a['country']}: SRI ${sri.score}/100 (${sri.tier}) — ${sri.trend}` }] };
      }

      case 'check_sanctions': {
        const isSanctioned = getCountryConfig().isSanctioned(a['country']);
        const sri = await riskStore.getSriForCountry(a['country']);
        const highRisk = (sri?.score ?? 0) >= 75;
        const result = isSanctioned || highRisk;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              country: a['country'],
              sanctioned: isSanctioned,
              highRisk,
              avoid: result,
              reason: isSanctioned ? 'US sanctions' : highRisk ? `SRI ${sri?.score} >= 75` : 'safe to source',
            }),
          }],
        };
      }

      case 'get_conflict_alerts': {
        const alerts = await riskStore.getConflictAlerts(a['country']);
        if (!alerts.length) return { content: [{ type: 'text', text: 'No active alerts' }] };
        return { content: [{ type: 'text', text: JSON.stringify(alerts) }] };
      }

      case 'get_sri_for_country': {
        const sri = await riskStore.getSriForCountry(a['country']);
        if (!sri) return { content: [{ type: 'text', text: `No data for ${a['country']}` }] };
        return { content: [{ type: 'text', text: JSON.stringify(sri) }] };
      }

      case 'get_heatmap_data': {
        const data = await riskStore.getHeatmapData();
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
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
    const { SqliteCountryConfigStore } = await import('../adapters/sqliteCountryConfig');
    const { initCountryConfig } = await import('../lib/countryConfig');
    const { SQLITE_PATH } = await import('../lib/env');
    initCountryConfig(new SqliteCountryConfigStore(createSqliteDb(SQLITE_PATH)));

    const { InMemoryRiskStore } = await import('../adapters/inMemoryRisk');
    const riskStore = new InMemoryRiskStore();
    const server = createRiskMcpServer(riskStore);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
