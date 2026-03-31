// src/adapters/foundryCloud.ts — implements IFoundryClient via Azure AI Foundry (cloud)
// Uses OpenAI-compatible REST API exposed by Azure AI Foundry deployments.
// Uses fetch() with Bearer token — avoids @azure/ai-projects SDK version instability.
// RULE 2: only visible inside src/adapters/. Inject via IFoundryClient everywhere else.
// NOTE: dev_mistakes.md [Pre-load] — if using AIProjectClient, import from v2 path only.

import type { IFoundryClient } from './interfaces';
import { getPrompt } from '../prompts/promptLoader';

export class FoundryCloudClient implements IFoundryClient {
  constructor(
    private readonly endpoint: string,   // e.g. https://xxx.openai.azure.com
    private readonly apiKey: string,
    private readonly model: string,
    // For embeddings we still prefer Foundry Local (on-device — sensitive pricing data)
    private readonly localEmbeddingClient?: IFoundryClient,
  ) {}

  async generateEmbedding(text: string): Promise<number[]> {
    // Embeddings always use Foundry Local (pricing data stays on-device)
    if (this.localEmbeddingClient) {
      return this.localEmbeddingClient.generateEmbedding(text);
    }
    // Fallback: use cloud endpoint
    const res = await fetch(`${this.endpoint}/openai/deployments/${this.model}/embeddings?api-version=2024-02-01`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
      body: JSON.stringify({ input: text }),
    });
    if (!res.ok) throw new Error(`Foundry Cloud embedding failed: ${res.status} ${res.statusText}`);
    const json = await res.json() as { data: { embedding: number[] }[] };
    return json.data[0].embedding;
  }

  async chat(
    messages: { role: string; content: string }[],
    systemPrompt?: string,
    maxTokens?: number,
  ): Promise<string> {
    const payload = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    const body: Record<string, unknown> = { messages: payload, temperature: 0 };
    if (maxTokens) body.max_tokens = maxTokens;

    const res = await fetch(
      `${this.endpoint}/openai/deployments/${this.model}/chat/completions?api-version=2024-02-01`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Foundry Cloud chat failed: ${res.status} ${res.statusText}`);
    const json = await res.json() as { choices: { message: { content: string } }[] };
    return json.choices[0].message.content;
  }

  async classifyText(
    text: string,
    labels: string[],
  ): Promise<{ label: string; confidence: number }> {
    const prompt = getPrompt('classifier.intentClassifier', { labels: labels.join(', '), text });
    const raw = await this.chat([{ role: 'user', content: prompt }]);
    try {
      const parsed = JSON.parse(raw.trim()) as { label: string; confidence: number };
      if (labels.includes(parsed.label)) return parsed;
      return { label: labels[0], confidence: 0 };
    } catch {
      return { label: labels[0], confidence: 0 };
    }
  }
}
