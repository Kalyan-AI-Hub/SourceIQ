// src/lib/mcpToolRegistry.ts — MCP client/runtime bridge
// The app runtime now talks to the same MCP server definitions used for stdio mode,
// but connects via SDK-backed in-memory transports instead of calling tool functions directly.
// This preserves a real MCP protocol boundary while avoiding subprocess overhead in Next.js.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCommodityMcpServer } from '../mcp/commodityMcpServer';
import { createFxMcpServer } from '../mcp/fxMcpServer';
import { createSanctionsMcpServer } from '../mcp/sanctionsMcpServer';
import { createGdeltMcpServer } from '../mcp/gdeltMcpServer';

// ── Tool definitions (mirrors MCP server schemas) ─────────────────────────

export interface McpTool {
  name:        string;
  description: string;
  /** Keywords that indicate this tool is relevant to a query */
  triggers:    RegExp[];
}

type ToolArgs = Record<string, string>;
type McpServerKey = 'commodity' | 'fx' | 'sanctions' | 'gdelt';

const clientPromises = new Map<McpServerKey, Promise<Client>>();

function createClient(serverKey: McpServerKey): Promise<Client> {
  const existing = clientPromises.get(serverKey);
  if (existing) return existing;

  const pending = (async () => {
    const server = (() => {
      switch (serverKey) {
        case 'commodity': return createCommodityMcpServer();
        case 'fx':        return createFxMcpServer();
        case 'sanctions': return createSanctionsMcpServer();
        case 'gdelt':     return createGdeltMcpServer();
      }
    })();

    const client = new Client({ name: `sourceiq-${serverKey}-client`, version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client.onerror = (error) => {
      console.warn(`[MCP/${serverKey}] client error:`, error instanceof Error ? error.message : error);
    };

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    return client;
  })();

  clientPromises.set(serverKey, pending);
  return pending;
}

function getServerForTool(toolName: string): McpServerKey {
  switch (toolName) {
    case 'get_oil_price':
    case 'get_shipping_index':
    case 'get_commodity_prices':
      return 'commodity';
    case 'get_fx_rates':
      return 'fx';
    case 'get_sanctions_check':
      return 'sanctions';
    case 'search_gdelt_news':
      return 'gdelt';
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function getToolArguments(toolName: string, args: ToolArgs): ToolArgs {
  if (toolName === 'get_sanctions_check') {
    return { name: args['country'] ?? args['name'] ?? '' };
  }
  return args;
}

function flattenContent(result: unknown): string {
  const content =
    typeof result === 'object' &&
    result !== null &&
    'content' in result &&
    Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: Array<{ type?: string; text?: string }> }).content
      : [];

  const parts = content
    .filter((item): item is { type?: string; text?: string } => item?.type === 'text')
    .map(item => item.text ?? '')
    .filter(Boolean);
  return parts.join('\n\n');
}

function normalizeToolOutput(toolName: string, text: string): string {
  if (toolName !== 'get_sanctions_check') {
    return text;
  }

  if (text.includes('Please provide a country or entity name.')) {
    return 'No country/entity name provided for sanctions check.';
  }

  if (text.includes('No US OFAC comprehensive country sanctions found')) {
    return text.replace('No US OFAC comprehensive country sanctions found', 'No US comprehensive sanctions found');
  }

  if (text.includes('US OFAC SANCTIONS ACTIVE') || text.includes('EU SANCTIONS ACTIVE')) {
    return `SANCTIONED\n${text}`;
  }

  return text;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'get_oil_price',
    description: 'Live WTI and Brent crude oil prices (Stooq). Includes freight surcharge assessment.',
    triggers: [/oil|crude|wti|brent|fuel|petroleum|barrel|energy price/i],
  },
  {
    name: 'get_shipping_index',
    description: 'Live Baltic Dry Index — global benchmark for bulk shipping costs.',
    triggers: [/shipping|freight|bdi|baltic|container|cargo|logistics cost/i],
  },
  {
    name: 'get_commodity_prices',
    description: 'Live cotton (USD/lb) and copper (USD/lb) futures prices.',
    triggers: [/cotton|copper|textile|commodity|material cost|input cost/i],
  },
  {
    name: 'get_fx_rates',
    description: 'Live USD exchange rates for all sourcing country currencies (ECB).',
    triggers: [/fx|exchange rate|currency|usd|dollar|yuan|rupee|peso|taka/i],
  },
  {
    name: 'get_sanctions_check',
    description: 'US OFAC sanctions screening for a country or entity.',
    triggers: [/sanction|ofac|embargo|prohibited|compliance|legal.*source|ban/i],
  },
  {
    name: 'search_gdelt_news',
    description: 'Search GDELT for live conflict and trade news for a specific country.',
    triggers: [/news|conflict|war|alert|gdelt|headline/i],
  },
];

// ── Tool selection: pick relevant tools from a query ──────────────────────

export function selectTools(query: string, country?: string): string[] {
  const selected = new Set<string>();

  // Always include market context for sourcing/cost queries
  if (/cost|sourc|price|cheap|expensive|afford|budget|spend/i.test(query)) {
    selected.add('get_oil_price');
    selected.add('get_shipping_index');
    selected.add('get_fx_rates');
  }

  // Pattern-match each tool's triggers
  for (const tool of MCP_TOOLS) {
    if (tool.triggers.some(t => t.test(query))) {
      selected.add(tool.name);
    }
  }

  // Country-specific: always check sanctions + FX + live news when a country is mentioned
  if (country) {
    selected.add('get_sanctions_check');
    selected.add('get_fx_rates');
    selected.add('search_gdelt_news');
  }

  return Array.from(selected);
}

export async function executeTool(toolName: string, args: ToolArgs = {}): Promise<string> {
  const client = await createClient(getServerForTool(toolName));
  const result = await client.callTool({
    name: toolName,
    arguments: getToolArguments(toolName, args),
  });
  return normalizeToolOutput(toolName, flattenContent(result)) || `No response from MCP tool: ${toolName}`;
}

// ── Batch executor: run all selected tools, return labelled results ────────

export async function executeTools(
  toolNames: string[],
  args: ToolArgs = {},
): Promise<{ tool: string; result: string }[]> {
  const results = await Promise.allSettled(
    toolNames.map(name => executeTool(name, args).then(result => ({ tool: name, result }))),
  );
  return results
    .filter((r): r is PromiseFulfilledResult<{ tool: string; result: string }> => r.status === 'fulfilled')
    .map(r => r.value);
}
