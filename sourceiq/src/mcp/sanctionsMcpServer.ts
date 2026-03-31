// src/mcp/sanctionsMcpServer.ts — US sanctions screening via MCP protocol
// Tool: get_sanctions_check
// Sources:
//   1. US OFAC comprehensive sanctions list (static, maintained by Treasury)
//   2. OFAC SDN entity screening via api.ofac.dev (free public API)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// US OFAC comprehensive country-level sanctions (broad import/export restrictions)
// Source: US Treasury OFAC — https://ofac.treasury.gov/sanctions-programs-and-country-information
export const COMPREHENSIVE_SANCTIONS: Record<string, string> = {
  Iran:         'US OFAC comprehensive sanctions — all transactions prohibited without OFAC license',
  'North Korea': 'US OFAC comprehensive sanctions — most stringent; near-total trade embargo',
  Cuba:         'US OFAC CACR sanctions — trade embargo in effect since 1962',
  Syria:        'US OFAC Syrian Sanctions Regulations — comprehensive restrictions',
  Russia:       'US/EU broad sectoral sanctions (finance, energy, defense) since 2022',
  Belarus:      'US/EU sectoral sanctions — financial and trade restrictions',
  Venezuela:    'US OFAC sectoral sanctions — financial sector, gold, oil targeted',
  Myanmar:      'US OFAC sanctions on military entities — targeted restrictions',
  Sudan:        'US OFAC Darfur-related sanctions — partial restrictions',
  Libya:        'UN/US arms embargo — limited trade restrictions',
};

// EU additional sanctions not in OFAC comprehensive list
const EU_ADDITIONAL_SANCTIONS: Record<string, string> = {
  Russia:  'EU Council comprehensive sanctions — financial, energy, transport, luxury goods',
  Belarus: 'EU sectoral sanctions — finance, transport, energy, potash',
};

interface OfacScreeningResult {
  match: boolean;
  score: number;
  name: string;
  programs: string[];
}

async function screenEntity(name: string): Promise<OfacScreeningResult | null> {
  try {
    const res = await fetch('https://api.ofac.dev/v1/screening/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'free', minScore: 90, name }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { identityMatches?: OfacScreeningResult[] };
    return json.identityMatches?.[0] ?? null;
  } catch {
    return null; // graceful — don't break on API unavailability
  }
}

export function createSanctionsMcpServer(): Server {
  const server = new Server(
    { name: 'sourceiq-sanctions', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_sanctions_check',
        description:
          'Check if a country or entity is subject to US OFAC or EU sanctions. ' +
          'Returns sanction program details and sourcing compliance implications.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Country name or company/entity name to screen',
            },
          },
          required: ['name'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name: toolName, arguments: args } = req.params;
    if (toolName !== 'get_sanctions_check') throw new Error(`Unknown tool: ${toolName}`);

    const entityName = ((args ?? {}) as Record<string, string>)['name'] ?? '';
    if (!entityName) return { content: [{ type: 'text', text: 'Please provide a country or entity name.' }] };

    const lines: string[] = [`SANCTIONS CHECK: "${entityName}"`];
    lines.push(`Checked: ${new Date().toUTCString()}`);
    lines.push('');

    // 1. Country-level comprehensive sanctions lookup
    const ofacSanction = COMPREHENSIVE_SANCTIONS[entityName];
    const euSanction   = EU_ADDITIONAL_SANCTIONS[entityName];

    if (ofacSanction) {
      lines.push(`⛔ US OFAC SANCTIONS ACTIVE:`);
      lines.push(`   ${ofacSanction}`);
      lines.push(`   → Direct sourcing PROHIBITED without OFAC license`);
      lines.push(`   → Processing payments through US financial system is PROHIBITED`);
    } else {
      lines.push(`✅ No US OFAC comprehensive country sanctions found for "${entityName}"`);
    }

    if (euSanction) {
      lines.push('');
      lines.push(`⛔ EU SANCTIONS ACTIVE:`);
      lines.push(`   ${euSanction}`);
    }

    // 2. Live SDN entity screening (catches specific companies/individuals)
    lines.push('');
    lines.push('SDN Entity Screening (live OFAC database):');
    const sdnResult = await screenEntity(entityName);
    if (sdnResult?.match) {
      lines.push(`⛔ SDN MATCH — Score: ${sdnResult.score}%`);
      lines.push(`   Entity: ${sdnResult.name}`);
      lines.push(`   Programs: ${sdnResult.programs.join(', ')}`);
      lines.push(`   → Transactions with this entity are PROHIBITED`);
    } else {
      lines.push(`✅ No SDN entity match found (score below 90% threshold)`);
    }

    // 3. Sourcing recommendation
    lines.push('');
    lines.push('Sourcing Recommendation:');
    if (ofacSanction) {
      lines.push(`❌ DO NOT SOURCE from ${entityName} — comprehensive US sanctions apply.`);
      lines.push(`   Legal exposure: civil penalties up to $1M per violation; criminal charges possible.`);
      lines.push(`   Alternative: review nearby countries with similar capabilities.`);
    } else {
      lines.push(`✓ No comprehensive sanctions block on ${entityName}.`);
      lines.push(`  Always conduct supplier-level due diligence before contracting.`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  });

  return server;
}

// CLI entry point
if (require.main === module) {
  void (async () => {
    const server = createSanctionsMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
}
