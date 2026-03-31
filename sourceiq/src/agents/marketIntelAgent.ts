// src/agents/marketIntelAgent.ts — live market intelligence via MCP tool calling
// Answers queries about oil prices, shipping costs, FX rates, sanctions, commodity prices.
// Uses the MCP runtime bridge to select and execute relevant tools at query time.
// This is the "agentic" pattern: query → tool selection → MCP tool calls → LLM synthesis.
//
// RULE 1: depends on IFoundryClient interface only.

import type { IFoundryClient } from '../adapters/interfaces';
import type { AgentResponse } from '../types/index';
import { selectTools, executeTools, MCP_TOOLS } from '../lib/mcpToolRegistry';
import { getCountryConfig } from '../lib/countryConfig';
import { getPrompt } from '../prompts/promptLoader';

/** Extract country name from query — country list loaded from DB, no hardcoding */
function extractCountry(query: string): string | undefined {
  const lower = query.toLowerCase();
  return getCountryConfig().getAllCountryNames().find(c => lower.includes(c.toLowerCase()));
}

export class MarketIntelAgent {
  constructor(private readonly foundry: IFoundryClient) {}

  async query(userMessage: string): Promise<AgentResponse> {
    const country = extractCountry(userMessage);

    // ── Step 1: Tool selection — pick relevant tools based on query ────────
    const selectedTools = selectTools(userMessage, country);

    // If no tools matched, fall back to general answer
    if (selectedTools.length === 0) {
      let answer: string;
      try {
        answer = await this.foundry.chat(
          [{ role: 'user', content: userMessage }],
          getPrompt('marketIntel.analyst'),
        );
      } catch {
        answer = `**AI summarization offline** — no market data tools matched for this query.\n\n*AI model is temporarily busy — retry in 30s for AI-written market intelligence.*`;
      }
      return { answer, source: 'local' };
    }

    // ── Step 2: Parallel tool execution via MCP registry ──────────────────
    const toolArgs: Record<string, string> = country ? { country } : {};
    const toolResults = await executeTools(selectedTools, toolArgs);

    // ── Step 3: Build tool manifest for tracing/display ───────────────────
    const toolsUsed = toolResults.map(r => {
      const def = MCP_TOOLS.find(t => t.name === r.tool);
      return def?.description ?? r.tool;
    });

    // ── Step 4: Ground LLM on tool results ────────────────────────────────
    const dataBlock = toolResults
      .map(r => {
        const label = r.tool.replace(/_/g, ' ').toUpperCase();
        return `[${label}]\n${r.result}`;
      })
      .join('\n\n');

    const groundedMessage = [
      `[LIVE MARKET DATA — fetched ${new Date().toUTCString()}]`,
      dataBlock,
      `[END LIVE MARKET DATA]`,
      ``,
      `Tools called: ${selectedTools.join(', ')}`,
      country ? `Country context: ${country}` : '',
      ``,
      `User question: ${userMessage}`,
      ``,
      `Answer using ONLY the live market data above. Quote exact prices and rates.`,
    ].filter(Boolean).join('\n');

    let answer: string;
    try {
      answer = await this.foundry.chat(
        [{ role: 'user', content: groundedMessage }],
        getPrompt('marketIntel.analyst'),
      );
    } catch {
      answer = `**AI summarization offline** — showing raw market data:\n\n${dataBlock}\n\n*AI model is temporarily busy — retry in 30s for AI-written market analysis.*`;
    }

    return {
      answer,
      source: 'local',
      toolsUsed,
    };
  }
}
