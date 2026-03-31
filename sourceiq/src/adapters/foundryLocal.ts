// src/adapters/foundryLocal.ts — implements IFoundryClient via Foundry Local
// Foundry Local uses Azure AI-style deployment routing, NOT the standard OpenAI /v1/ prefix.
// Chat:       POST {endpoint}/deployments/{model}/chat/completions
// Embeddings: POST {endpoint}/deployments/{model}/embeddings
// RULE 2: Only visible inside src/adapters/. Inject via IFoundryClient everywhere else.

import type { IFoundryClient } from './interfaces';
import { getPrompt } from '../prompts/promptLoader';

// Keyword-based intent classification used when Foundry is unavailable
function keywordClassify(text: string, labels: string[]): { label: string; confidence: number } {
  const lower = text.toLowerCase();
  const scores: Record<string, number> = {};
  for (const label of labels) scores[label] = 0;

  if (/sku|inventory|stock|product|item|search|find/.test(lower))    scores['inventory']  = 0.75;
  if (/tariff|duty|rate|cost|import|tax|percent|%/.test(lower))      scores['tariff']     = 0.75;
  if (/risk|conflict|advisory|safe|danger|war|alert/.test(lower))    scores['risk']       = 0.75;
  if (/compar|vs\b|versus|better|difference|switch/.test(lower))     scores['comparison'] = 0.75;

  const best = labels.reduce((a, b) => (scores[a] >= scores[b] ? a : b));
  if ((scores[best] ?? 0) === 0 && labels.includes('general')) {
    return { label: 'general', confidence: 0.4 };
  }
  return { label: best, confidence: scores[best] || 0.4 };
}


export class FoundryLocalClient implements IFoundryClient {
  private static readonly HEALTH_PROBE_PATHS = ['/v1/models', '/openai/status'];
  // Serial queue — phi-4-mini is single-threaded and rejects concurrent requests with 500.
  // All chat() calls chain onto this promise so they execute one at a time.
  private _queue: Promise<unknown> = Promise.resolve();

  // Mini circuit breaker — when a call times out or gets 5xx, skip Foundry instantly for
  // COOLDOWN_MS instead of making subsequent callers wait 25s in the queue just to time out too.
  private _cooldownUntil = 0;
  // 5s cooldown — model is local and healthy; don't block long after a single slow response
  private static readonly COOLDOWN_MS = 5_000;
  private _endpointHealthyUntil = 0;
  private _lastSuccessfulChatAt = 0;
  private static readonly HEALTH_PROBE_TTL_MS = 120_000; // don't re-probe during a long generation
  private static readonly HEALTH_PROBE_TIMEOUT_MS = 2_000;
  // phi-4-mini on OpenVINO can take 30-50s for longer prompts depending on hardware.
  // Timeouts below these values cause false-positive cooldowns even when the model is healthy.
  private static readonly DEFAULT_CHAT_TIMEOUT_MS = 30_000; // short prompts / classifyText
  private static readonly LONG_CHAT_TIMEOUT_MS = 90_000;    // phi-4-mini observed max ~60s; 90s gives real headroom

  constructor(
    private readonly endpoint: string,  // resolved by foundry-local-sdk via initFoundrySDK(); fallback: FOUNDRY_LOCAL_ENDPOINT
    private readonly model: string,      // e.g. phi-4-mini-instruct-openvino-gpu:2
  ) {}

  async generateEmbedding(text: string): Promise<number[]> {
    // Use local Transformers.js model — does not consume Foundry inference capacity
    const { embed } = await import('../lib/localEmbeddings');
    return embed(text);
  }

  async chat(
    messages: { role: string; content: string }[],
    systemPrompt?: string,
    maxTokens?: number,
  ): Promise<string> {
    // Fast-fail: if Foundry recently timed out / 5xx'd, reject immediately instead of
    // making the caller wait 25s in the serial queue just to get the same error.
    if (Date.now() < this._cooldownUntil) {
      const e = new Error('FOUNDRY_OFFLINE');
      e.name = 'FoundryOfflineError';
      throw e;
    }

    // Enqueue — wait for any in-flight request to finish before sending this one
    const result = this._queue.then(
      () => this._doChat(messages, systemPrompt, maxTokens),
      () => this._doChat(messages, systemPrompt, maxTokens),
    );
    // Advance the queue tail (swallow errors so queue never breaks)
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  private async _ensureEndpointHealthy(): Promise<void> {
    if (Date.now() < this._endpointHealthyUntil) return;

    try {
      let healthy = false;
      for (const path of FoundryLocalClient.HEALTH_PROBE_PATHS) {
        try {
          const res = await fetch(`${this.endpoint}${path}`, {
            signal: AbortSignal.timeout(FoundryLocalClient.HEALTH_PROBE_TIMEOUT_MS),
          });
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {
          // Try the next supported probe path.
        }
      }
      if (!healthy) throw new Error('no supported health endpoint responded');
      this._endpointHealthyUntil = Date.now() + FoundryLocalClient.HEALTH_PROBE_TTL_MS;
    } catch {
      console.warn('[FoundryLocal] Health probe failed — entering cooldown');
      this._cooldownUntil = Date.now() + FoundryLocalClient.COOLDOWN_MS;
      const e = new Error('FOUNDRY_OFFLINE');
      e.name = 'FoundryOfflineError';
      throw e;
    }
  }

  private _stripThinkBlocks(raw: string): string {
    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (stripped.length > 0) return stripped;
    const afterThink = raw.split('</think>').pop()?.trim() ?? '';
    return afterThink.length > 0 ? afterThink : raw.trim();
  }

  private async _doChat(
    messages: { role: string; content: string }[],
    systemPrompt?: string,
    maxTokens?: number,
  ): Promise<string> {
    if (Date.now() < this._cooldownUntil) {
      const e = new Error('FOUNDRY_OFFLINE');
      e.name = 'FoundryOfflineError';
      throw e;
    }

    const payload = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;
    const tokens = maxTokens ?? 400;

    // ── Native SDK path ──────────────────────────────────────────────────────
    // Use model.createChatClient().completeChat() when the model was loaded via
    // the Foundry Local SDK (set in globalThis.__foundrySDKModel by initFoundrySDK).
    // This calls the DLL directly — no HTTP, no socket, no timeout needed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkModel = (globalThis as any).__foundrySDKModel;
    if (sdkModel) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chatClient: any = sdkModel.createChatClient();
        chatClient.settings.maxTokens = tokens;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response: { choices: Array<{ message: { content: string } }> } = await chatClient.completeChat(payload);
        this._lastSuccessfulChatAt = Date.now();
        this._endpointHealthyUntil = Date.now() + FoundryLocalClient.HEALTH_PROBE_TTL_MS;
        const raw = response.choices[0]?.message?.content ?? '';
        return this._stripThinkBlocks(raw);
      } catch (sdkErr: unknown) {
        // SDK DLL error — log and fall through to HTTP fallback
        const msg = sdkErr instanceof Error ? sdkErr.message : String(sdkErr);
        console.warn(`[FoundryLocal] Native SDK chat failed — falling back to HTTP: ${msg}`);
      }
    }

    // ── HTTP fallback path ───────────────────────────────────────────────────
    const promptChars = payload.reduce((sum, msg) => sum + msg.content.length, 0);
    const timeoutMs = tokens <= 150 && promptChars <= 4_000
      ? FoundryLocalClient.DEFAULT_CHAT_TIMEOUT_MS
      : FoundryLocalClient.LONG_CHAT_TIMEOUT_MS;

    try {
      if (Date.now() - this._lastSuccessfulChatAt > FoundryLocalClient.HEALTH_PROBE_TTL_MS) {
        await this._ensureEndpointHealthy();
      }

      const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: payload, max_tokens: tokens }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        if (res.status >= 500) {
          console.warn(`[FoundryLocal] Server error ${res.status} — entering cooldown`);
          this._cooldownUntil = Date.now() + FoundryLocalClient.COOLDOWN_MS;
          const e = new Error('FOUNDRY_OFFLINE');
          e.name = 'FoundryOfflineError';
          throw e;
        }
        throw new Error(`Foundry Local chat failed: ${res.status} ${res.statusText}`);
      }
      const json = await res.json() as { choices: { message: { content: string } }[] };
      this._lastSuccessfulChatAt = Date.now();
      this._endpointHealthyUntil = Date.now() + FoundryLocalClient.HEALTH_PROBE_TTL_MS;
      return this._stripThinkBlocks(json.choices[0].message.content);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'FoundryOfflineError') throw err;
      const isConnErr = err instanceof Error && (
        err.message.includes('ECONNREFUSED') ||
        err.message.includes('fetch failed') ||
        err.message.includes('ENOTFOUND') ||
        err.name === 'TimeoutError'
      );
      if (isConnErr) {
        console.warn('[FoundryLocal] Service unavailable — entering cooldown');
        this._cooldownUntil = Date.now() + FoundryLocalClient.COOLDOWN_MS;
        const e = new Error('FOUNDRY_OFFLINE');
        e.name = 'FoundryOfflineError';
        throw e;
      }
      throw err;
    }
  }

  async classifyText(
    text: string,
    labels: string[],
  ): Promise<{ label: string; confidence: number }> {
    const prompt = getPrompt('classifier.intentClassifier', { labels: labels.join(', '), text });

    try {
      const raw = await this.chat([{ role: 'user', content: prompt }]);
      const parsed = JSON.parse(raw.trim()) as { label: string; confidence: number };
      if (labels.includes(parsed.label)) return parsed;
      return keywordClassify(text, labels);
    } catch {
      return keywordClassify(text, labels);
    }
  }
}
