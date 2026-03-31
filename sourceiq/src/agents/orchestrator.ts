// src/agents/orchestrator.ts — LangGraph StateGraph-based orchestrator (Track B)
// Replaces the switch-based dispatcher with a compiled StateGraph.
// Public API is unchanged: route(userMessage) → AgentResponse
// RULE 3: receives all agents as constructor params — never creates them.

import type { IFoundryClient } from '../adapters/interfaces';
import type { AgentResponse } from '../types/index';
import { cache } from '../lib/cache';
import { getPrompt } from '../prompts/promptLoader';
import { recordSpan } from '../lib/tracingClient';
import type { InventoryAgent } from './inventoryAgent';
import type { TariffAgent } from './tariffAgent';
import type { GeoRiskAgent } from './geoRiskAgent';
import type { DashboardAgent } from './dashboardAgent';
import type { NewsAggregatorAgent } from './newsAggregatorAgent';
import type { MarketIntelAgent } from './marketIntelAgent';

const INTENT_LABELS = ['inventory', 'tariff', 'risk', 'news', 'market', 'comparison', 'general'] as const;
type Intent = typeof INTENT_LABELS[number];

// Keyword overrides — checked before LLM classifier (faster + reliable for small models)
const NEWS_PATTERNS   = /\b(news|alerts?|headlines?|what('s| is) happening|briefing|today('s| is)|conflict news|war news|summarize|what broke|latest)\b/i;
const MARKET_PATTERNS = /\b(oil|crude|wti|brent|barrel|fuel|bdi|baltic|shipping costs?|shipping index|freight costs?|freight rate|cotton price|copper price|commodity|fx rate|exchange rate|currency rate|sanction|ofac|embargo|compliance check)\b/i;
// Standalone risk queries — country + risk language without inventory context
const RISK_PATTERNS   = /\b(sourcing risk|geopolitical risk|safe to source|danger(ous)? to source|analyze.*risk|risk.*analys|is .* safe|how risky|conflict (in|with)|war (in|with)|advisory (for|in)|sourcing exposure|supply.?chain exposure|china exposure|best savings|savings opportunit)\b/i;
// Direct country comparisons — route to tariff agent (lighter than full comparison pipeline)
const COMPARE_PATTERNS = /\b(compare|vs\.?|versus)\b/i;

// ── Keyword PromptShield — instant jailbreak / injection detection ─────────
// Zero overhead: regex only, no LLM call. Catches >95% of real attempts.
// Runs in route() before the graph is even invoked — blocked queries never
// reach the serial Foundry queue, so they don't slow down legitimate requests.
const INJECTION_PATTERNS = /ignore (previous|all|above|your|prior)|you are now|new (persona|identity|role|instructions?)|disregard your|pretend (you|to be)|act as (if|though)|forget (your|all|previous) instructions?|override (your|previous|all)|system prompt|<\/?system>|\[INST\]|###\s*(instruction|system)|you must now|from now on (you|act|ignore|forget)/i;

// Out-of-scope content policy — hard block before the graph is invoked.
// Catches explicit off-topic or harmful requests that aren't prompt injections.
const OUT_OF_SCOPE_PATTERNS = /\b(harmful content|illegal|how to (hack|kill|harm|make a bomb|steal)|explicit|pornograph|violence|violent|weapon|drug (deal|traffick)|murder|assault|abuse|self-harm)\b/i;

// Supply-chain signal — at least one of these must appear for a "general" query to reach the LLM.
// If absent, the query is off-topic and gets a hard redirect without burning an LLM call.
const SUPPLY_CHAIN_SIGNAL = /\b(source|sourcing|supplier|supply chain|inventory|sku|product|goods|import|export|tariff|duty|hs code|trade|freight|shipping|logistics|vendor|procurement|purchase|buy|buying|cost|price|quote|lead time|country|region|risk|compliance|sanction|embargo|geopolit|currency|exchange rate|commodity|oil|cotton|copper|bdi|baltic|wti|brent|port|customs|fta|usmca|cptpp|nafta|gsp|mfn|fob|cif|incoterm|warehouse|stock|reorder|moq|minimum order|diversif|concentration|spend|annual volume|unit cost|disruption|alternative|switch|pivot|near.?shor|friend.?shor|china|vietnam|india|mexico|bangladesh|indonesia|turkey|morocco|brazil|cambodia|egypt|jordan|saudi|uae)\b/i;

// Data mutation guard — SourceIQ is read-only. Block any request to write, modify, or delete data.
// Checked before the graph so it never reaches an agent that might misinterpret it as a browse query.
const MUTATION_PATTERNS = /\b(delete|drop|truncate|remove|clear|wipe|erase|destroy|reset|purge|update|modify|alter|change|edit|patch|insert|add new|create|write|overwrite|corrupt|format)\b[\s\S]{0,40}\b(inventory|database|db|data|table|record|sku|supplier|tariff|file|schema|row|rows|entry|entries|all items|everything)\b/i;

// Conversational bypass attempts — pressure tactics used after a refusal.
// Small models like phi-4-mini can't detect these from context alone.
const BYPASS_PATTERNS = /\b(come on (you can|do it)|come one|you can do (it|that)|i (know|bet) you can|stop pretending|drop the act|just (do it|tell me|say it)|i won't tell|between (us|you and me)|off the record|no one is watching|be honest (with me)?|don't (be|act) like you can't|yes you can|i think (so|you can)|i don't think so|oh really|don't lie|break the rules|break.*?rules|circumvent|bypass (the|your)|ignore (your|the) (policy|policies|rules|restrictions|guidelines|boundaries)|i want you to|give me .{0,20}(anyway|regardless)|but (just|still) (give|show|tell))\b/i;

// ── Graph State ────────────────────────────────────────────────────────────
interface GraphState {
  userMessage: string;
  intent: Intent | null;
  inventoryResult: AgentResponse | null;
  tariffResult: AgentResponse | null;
  riskResult: AgentResponse | null;
  finalResponse: AgentResponse | null;
}

export class Orchestrator {
  private graphReady = false;
  // Lazily-loaded compiled graph (dynamic import of LangGraph avoids ESM issues at build time)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private compiledGraph: any = null;
  // Mutable per-request status emitter — set before each route() call
  private _emit: (msg: string) => void = () => {};

  constructor(
    private readonly inventory: InventoryAgent,
    private readonly tariff: TariffAgent,
    private readonly geoRisk: GeoRiskAgent,
    private readonly dashboard: DashboardAgent,
    private readonly foundry: IFoundryClient,
    private readonly newsAggregator: NewsAggregatorAgent,
    private readonly marketIntel: MarketIntelAgent,
  ) {}

  // ── Build graph lazily (avoids ESM top-level import) ──────────────────────
  private async buildGraph() {
    if (this.graphReady) return;

    const { StateGraph, END } = await import('@langchain/langgraph');

    // Capture agent references for node closures
    const foundry         = this.foundry;
    const inventory       = this.inventory;
    const tariff          = this.tariff;
    const geoRisk         = this.geoRisk;
    const dashboard       = this.dashboard;
    const newsAggregator  = this.newsAggregator;
    const marketIntel     = this.marketIntel;
    // emitStatus reads this._emit at call-time — works correctly across requests
    const emitStatus      = (msg: string) => this._emit(msg);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const graph: any = new StateGraph<GraphState>({
      channels: {
        userMessage:      { value: (_prev, next) => next, default: () => '' },
        intent:           { value: (_prev, next) => next, default: () => null },
        inventoryResult:  { value: (_prev, next) => next, default: () => null },
        tariffResult:     { value: (_prev, next) => next, default: () => null },
        riskResult:       { value: (_prev, next) => next, default: () => null },
        finalResponse:    { value: (_prev, next) => next, default: () => null },
      },
    });

    // ── Nodes ────────────────────────────────────────────────────────────────
    graph.addNode('classify', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Classifying query…');
      const lower = state.userMessage.toLowerCase();
      const t0 = Date.now();

      // Keyword checks run FIRST — faster and more reliable than LLM for clear-cut patterns.
      // This avoids burning a 300-2000ms LLM call on queries that match obvious patterns.

      // Override: news/alert queries → NewsAggregatorAgent
      if (NEWS_PATTERNS.test(lower)) {
        console.log(`[Orchestrator/LangGraph] intent="news" (keyword) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→news]', Date.now() - t0);
        return { intent: 'news' };
      }

      // Override: market/commodity/sanctions queries → MarketIntelAgent (MCP tool calling)
      if (MARKET_PATTERNS.test(lower)) {
        console.log(`[Orchestrator/LangGraph] intent="market" (keyword) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→market]', Date.now() - t0);
        return { intent: 'market' };
      }

      // Override: SKU-specific switching/savings/tariff queries → tariff agent
      // Must be checked BEFORE RISK_PATTERNS because savings queries often contain
      // "risk assessment" which would otherwise be caught by \banalyze.*risk\b.
      if (/\bsku-\d+/i.test(lower) && /switch|saving|analyz|tariff|alternative/i.test(lower)) {
        console.log(`[Orchestrator/LangGraph] intent="tariff" (keyword-sku) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→tariff]', Date.now() - t0);
        return { intent: 'tariff' };
      }

      // Override: standalone risk queries (e.g. "Analyze sourcing risk for Iran")
      if (RISK_PATTERNS.test(lower)) {
        console.log(`[Orchestrator/LangGraph] intent="risk" (keyword) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→risk]', Date.now() - t0);
        return { intent: 'risk' };
      }

      // Override: "compare X vs Y" → full comparison pipeline (parallel fan-out)
      if (COMPARE_PATTERNS.test(lower)) {
        console.log(`[Orchestrator/LangGraph] intent="comparison" (keyword-compare) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→comparison]', Date.now() - t0);
        return { intent: 'comparison' };
      }

      // Override: queries explicitly asking for BOTH items AND risk → full comparison pipeline
      const hasInventory = /\b(inventory|sku|items?|products?|stock|anything (to|can) source|what (can\s+\w+\s+)?source|source from|do i (source|buy|order|get|have)|which .*(source|buy|order|get|have)|what .*(source|buy|order|get|have)|sourcing from|sourced from|we (source|buy|order)|i (source|buy|order)|savings?|saving opportunit|best alternative|switch|portfolio|spend|annual|concentration|exposure)\b/.test(lower);
      const hasRisk = /\b(risk|safe|danger|conflict|advisory|threat|concern|exposure|vulnerable|dependency|relian)\b/.test(lower);

      // Override: portfolio-level exposure + savings queries → full comparison pipeline
      // e.g. "What is my China sourcing exposure and best savings opportunities?"
      if (/\b(exposure|concentration|dependency|relian)\b/.test(lower) && /\b(saving|alternative|switch|best|opportunit|portfolio|spend)\b/.test(lower)) {
        console.log(`[Orchestrator/LangGraph] intent="comparison" (keyword-exposure) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→comparison]', Date.now() - t0);
        return { intent: 'comparison' };
      }

      if (hasInventory && hasRisk) {
        console.log(`[Orchestrator/LangGraph] intent="comparison" (keyword) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→comparison]', Date.now() - t0);
        return { intent: 'comparison' };
      }

      // Pure inventory queries (no risk angle) — route directly, skip LLM classifier
      if (hasInventory) {
        console.log(`[Orchestrator/LangGraph] intent="inventory" (keyword-inventory) query="${state.userMessage.slice(0, 60)}"`);
        recordSpan('orchestrator', 'classifyText[keyword→inventory]', Date.now() - t0);
        return { intent: 'inventory' };
      }

      // Only call LLM when keyword patterns don't match — preserves inference capacity
      emitStatus('Classifying with AI…');
      const { label } = await foundry.classifyText(state.userMessage, [...INTENT_LABELS]);
      // classifyText is already traced by withTracing wrapper — no recordSpan needed here
      console.log(`[Orchestrator/LangGraph] intent="${label}" (llm) query="${state.userMessage.slice(0, 60)}"`);
      return { intent: label as Intent };
    });

    graph.addNode('inventoryNode', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Searching inventory…');
      const t0 = Date.now();
      try {
        const result = await inventory.query(state.userMessage);
        recordSpan('inventory-agent', 'query', Date.now() - t0);
        return { inventoryResult: result };
      } catch (err) {
        recordSpan('inventory-agent', 'query', Date.now() - t0, 'error', (err as Error).message);
        console.error('[Orchestrator] inventoryNode failed:', (err as Error).message);
        return { inventoryResult: { answer: '*The AI model is processing another request — please retry in a few seconds.*', source: 'local' as const } };
      }
    });

    graph.addNode('tariffNode', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Checking tariff rates…');
      const t0 = Date.now();
      try {
        const result = await tariff.query(state.userMessage);
        recordSpan('tariff-agent', 'query', Date.now() - t0);
        return { tariffResult: result };
      } catch (err) {
        recordSpan('tariff-agent', 'query', Date.now() - t0, 'error', (err as Error).message);
        console.error('[Orchestrator] tariffNode failed:', (err as Error).message);
        return { tariffResult: { answer: '*The AI model is processing another request — please retry in a few seconds.*', source: 'local' as const } };
      }
    });

    graph.addNode('riskNode', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Assessing geopolitical risk…');
      const t0 = Date.now();
      try {
        const result = await geoRisk.query(state.userMessage);
        recordSpan('georisk-agent', 'query', Date.now() - t0);
        return { riskResult: result };
      } catch (err) {
        recordSpan('georisk-agent', 'query', Date.now() - t0, 'error', (err as Error).message);
        console.error('[Orchestrator] riskNode failed:', (err as Error).message);
        return { riskResult: { answer: '*The AI model is processing another request — please retry in a few seconds.*', source: 'local' as const } };
      }
    });

    graph.addNode('dashboardNode', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Building sourcing recommendations…');
      const inv  = state.inventoryResult  ?? { answer: '', source: 'local' as const };
      const tar  = state.tariffResult     ?? { answer: '', source: 'local' as const };
      const result = await dashboard.buildResponse(inv, tar, state.userMessage);

      // For comparison queries, weave in geo-risk analysis
      const geoAnswer = state.riskResult?.answer;
      if (geoAnswer) {
        return {
          finalResponse: {
            ...result,
            answer: result.answer + `\n\nGeopolitical Risk Assessment:\n${geoAnswer}`,
            riskAlerts: [...(result.riskAlerts ?? []), ...(state.riskResult?.riskAlerts ?? [])],
          },
        };
      }

      return { finalResponse: result };
    });

    // ── Parallel fan-out for comparison queries ─────────────────────────
    // Dispatches inventory, tariff, and risk agents simultaneously via
    // Promise.allSettled — each agent gathers data + calls LLM independently.
    // The Foundry serial queue naturally serializes LLM calls, but data
    // retrieval (LanceDB, SQLite, risk store) runs truly in parallel.
    // allSettled ensures partial results if any agent times out.
    graph.addNode('comparisonFanOut', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Running parallel multi-agent analysis…');
      const t0 = Date.now();

      const [invResult, tarResult, riskResult] = await Promise.allSettled([
        inventory.query(state.userMessage),
        tariff.query(state.userMessage),
        geoRisk.query(state.userMessage),
      ]);

      recordSpan('orchestrator', 'comparisonFanOut[inventory+tariff+georisk]', Date.now() - t0);

      return {
        inventoryResult: invResult.status === 'fulfilled'
          ? invResult.value
          : { answer: '*Inventory data unavailable — agent timed out.*', source: 'local' as const },
        tariffResult: tarResult.status === 'fulfilled'
          ? tarResult.value
          : { answer: '*Tariff data unavailable — agent timed out.*', source: 'local' as const },
        riskResult: riskResult.status === 'fulfilled'
          ? riskResult.value
          : { answer: '*Risk assessment unavailable — agent timed out.*', source: 'local' as const },
      };
    });

    graph.addNode('generalNode', async (state: GraphState): Promise<Partial<GraphState>> => {
      // Hard topic guard — if the query has no supply-chain signal, redirect without an LLM call.
      // Small models like phi-4-mini cannot reliably self-enforce topic scope via system prompts.
      if (!SUPPLY_CHAIN_SIGNAL.test(state.userMessage)) {
        console.log(`[Orchestrator] Off-topic blocked in generalNode: "${state.userMessage.slice(0, 60)}"`);
        return {
          finalResponse: {
            answer: "I'm SourceIQ — a supply chain intelligence assistant. I can only help with sourcing decisions, tariff analysis, inventory risk, and geopolitical threats to your supply chain. What sourcing question can I help you with?",
            source: 'local' as const,
          },
        };
      }

      emitStatus('Generating response…');
      const systemPrompt = getPrompt('orchestrator.general');
      let answer: string;
      try {
        answer = await foundry.chat([{ role: 'user', content: state.userMessage }], systemPrompt);
      } catch {
        answer = `**AI summarization offline** — the AI model is temporarily busy.\n\nYour question: *${state.userMessage}*\n\nPlease retry in 30 seconds.`;
      }
      return { finalResponse: { answer, source: 'local' as const } };
    });

    graph.addNode('packInventory', async (state: GraphState): Promise<Partial<GraphState>> => ({
      finalResponse: state.inventoryResult ?? { answer: '', source: 'local' as const },
    }));

    graph.addNode('packTariff', async (state: GraphState): Promise<Partial<GraphState>> => ({
      finalResponse: state.tariffResult ?? { answer: '', source: 'local' as const },
    }));

    graph.addNode('packRisk', async (state: GraphState): Promise<Partial<GraphState>> => ({
      finalResponse: state.riskResult ?? { answer: '', source: 'local' as const },
    }));

    graph.addNode('newsNode', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Fetching live news alerts…');
      const t0 = Date.now();
      const result = await newsAggregator.query(state.userMessage);
      recordSpan('news-agent', 'query', Date.now() - t0);
      return { finalResponse: result };
    });

    graph.addNode('marketNode', async (state: GraphState): Promise<Partial<GraphState>> => {
      emitStatus('Querying market intelligence…');
      const t0 = Date.now();
      const result = await marketIntel.query(state.userMessage);
      recordSpan('market-intel-agent', 'query', Date.now() - t0);
      return { finalResponse: result };
    });

    // ── Edges ─────────────────────────────────────────────────────────────────
    graph.setEntryPoint('classify');

    // Conditional routing after classification
    graph.addConditionalEdges('classify', (state: GraphState) => {
      switch (state.intent) {
        case 'inventory':   return 'inventoryNode';
        case 'tariff':      return 'tariffNode';
        case 'risk':        return 'riskNode';
        case 'news':        return 'newsNode';
        case 'market':      return 'marketNode';
        case 'comparison':  return 'comparisonFanOut';  // parallel fan-out
        case 'general':
        default:            return 'generalNode';
      }
    });

    // Standalone agent routes → pack and finish
    graph.addEdge('inventoryNode', 'packInventory');
    graph.addEdge('tariffNode',    'packTariff');
    graph.addEdge('riskNode',      'packRisk');

    // Comparison: parallel fan-out → dashboard merge
    graph.addEdge('comparisonFanOut', 'dashboardNode');
    graph.addEdge('dashboardNode', END);
    graph.addEdge('generalNode',   END);
    graph.addEdge('newsNode',      END);
    graph.addEdge('marketNode',    END);
    graph.addEdge('packInventory', END);
    graph.addEdge('packTariff',    END);
    graph.addEdge('packRisk',      END);

    this.compiledGraph = graph.compile();
    this.graphReady = true;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  // onStatus: optional callback invoked at each pipeline step (used for SSE status events)
  async route(userMessage: string, onStatus?: (msg: string) => void): Promise<AgentResponse> {
    // PromptShield — keyword-based injection detection (instant, no LLM overhead).
    // Blocked here before the graph is invoked — never reaches the serial Foundry queue.
    if (INJECTION_PATTERNS.test(userMessage)) {
      console.warn(`[PromptShield] Injection attempt blocked: "${userMessage.slice(0, 80)}"`);
      return {
        answer: 'I can only answer supply chain and sourcing questions. Please ask about tariffs, inventory, or geopolitical risk.',
        source: 'local',
      };
    }

    if (OUT_OF_SCOPE_PATTERNS.test(userMessage)) {
      console.warn(`[ContentPolicy] Out-of-scope request blocked: "${userMessage.slice(0, 80)}"`);
      return {
        answer: 'I\'m a supply chain intelligence assistant. I can only help with sourcing decisions, tariff analysis, inventory, and geopolitical risk. Please ask me about your supply chain.',
        source: 'local',
      };
    }

    if (BYPASS_PATTERNS.test(userMessage)) {
      console.warn(`[ContentPolicy] Bypass attempt blocked: "${userMessage.slice(0, 80)}"`);
      return {
        answer: 'I can only assist with supply chain and sourcing topics — tariffs, inventory, and geopolitical risk. What sourcing question can I help you with?',
        source: 'local',
      };
    }

    if (MUTATION_PATTERNS.test(userMessage)) {
      console.warn(`[ContentPolicy] Data mutation request blocked: "${userMessage.slice(0, 80)}"`);
      return {
        answer: 'SourceIQ is a read-only intelligence system. I can analyze your sourcing data, but I cannot create, modify, or delete any records. What would you like to know about your supply chain?',
        source: 'local',
      };
    }

    // ── Exact-query cache (Phase 7) ──────────────────────────────────────
    // Short TTL (90s) — deduplicate repeated demo queries without serving stale risk data.
    // Only cache deterministic query classes (risk analysis, inventory lookup, tariff compare).
    // Freeform multi-agent synthesis is excluded (too sensitive to freshness).
    const isRepeatableQuery = /\b(sourcing risk|analyze.*risk|risk.*analys|which.*source from|what.*tariff|tariff rate|compare.*tariff|inventory|sku|what do i source|how much.*tariff)\b/i.test(userMessage);
    if (isRepeatableQuery) {
      const queryKey = `query:${userMessage.toLowerCase().trim().replace(/\s+/g, ' ')}`;
      const cached = cache.get<AgentResponse>(queryKey);
      if (cached) {
        console.log(`[Orchestrator] Cache hit for query: "${userMessage.slice(0, 60)}"`);
        return cached;
      }
      // Run graph and cache result
      this._emit = onStatus ?? (() => {});
      await this.buildGraph();
      const result = await this.compiledGraph.invoke({
        userMessage, intent: null, inventoryResult: null, tariffResult: null, riskResult: null, finalResponse: null,
      } as GraphState);
      const response = (result as GraphState).finalResponse ?? { answer: 'No response', source: 'local' };
      cache.set(queryKey, response, { ttlMs: 90_000, tags: ['risk', 'inventory', 'tariff'] });
      return response;
    }

    this._emit = onStatus ?? (() => {});
    await this.buildGraph();

    const result = await this.compiledGraph.invoke({
      userMessage,
      intent: null,
      inventoryResult: null,
      tariffResult: null,
      riskResult: null,
      finalResponse: null,
    } as GraphState);

    return (result as GraphState).finalResponse ?? { answer: 'No response', source: 'local' };
  }
}
