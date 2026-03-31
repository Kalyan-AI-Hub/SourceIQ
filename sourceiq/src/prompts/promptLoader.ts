// src/prompts/promptLoader.ts — centralized prompt registry for all SourceIQ agents
//
// Prompts are stored in prompts.json (Prompty-inspired format):
//   - Single source of truth — no prompt strings scattered across agent files
//   - {{variableName}} placeholders replaced at call time
//   - model.parameters.max_tokens exported alongside the system string so callers
//     don't hardcode token budgets separately from the prompts they belong to
//
// Usage:
//   import { getPrompt, getMaxTokens } from '../prompts/promptLoader';
//   const system = getPrompt('geoRisk.analyst', { sanctionedList: 'Iran, Cuba, ...' });
//   const tokens = getMaxTokens('geoRisk.analyst');   // → 500

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RAW = require('./prompts.json') as Record<string, JsonValue>;

interface PromptEntry {
  name?: string;
  description?: string;
  model?: { api?: string; parameters?: { max_tokens?: number } };
  system: string;
}

function isPromptEntry(v: unknown): v is PromptEntry {
  return typeof v === 'object' && v !== null && typeof (v as Record<string,unknown>)['system'] === 'string';
}

/** Flat map of dot-notation key → PromptEntry, built once at module load. */
const REGISTRY = new Map<string, PromptEntry>();

function flatten(obj: Record<string, JsonValue>, prefix = ''): void {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('$') || k.startsWith('_')) continue; // skip schema/comment keys
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPromptEntry(v)) {
      REGISTRY.set(key, v as unknown as PromptEntry);
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      flatten(v as Record<string, JsonValue>, key);
    }
  }
}

flatten(RAW);

/**
 * Retrieve a system prompt by dot-notation key with optional variable substitution.
 *
 * @param key      Dot-notation key matching prompts.json hierarchy, e.g. 'geoRisk.analyst'
 * @param vars     Key/value pairs to substitute for {{varName}} placeholders
 * @returns        The resolved system prompt string
 * @throws         If the key is not found (fail-fast — misconfiguration, not a runtime error)
 */
export function getPrompt(key: string, vars?: Record<string, string>): string {
  const entry = REGISTRY.get(key);
  if (!entry) {
    throw new Error(`[PromptLoader] Unknown prompt key: "${key}". Available: ${Array.from(REGISTRY.keys()).join(', ')}`);
  }
  let text = entry.system;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{{${name}}}`, value);
    }
  }
  return text;
}

/**
 * Return the recommended max_tokens for a prompt entry, or a fallback default.
 */
export function getMaxTokens(key: string, fallback = 512): number {
  return REGISTRY.get(key)?.model?.parameters?.max_tokens ?? fallback;
}

/**
 * Return the full prompt entry (name, description, system, model params).
 * Useful for tracing/logging which prompt version was used.
 */
export function getPromptMeta(key: string): Readonly<PromptEntry> | undefined {
  return REGISTRY.get(key);
}

/** All registered prompt keys — for validation in tests or debug endpoints. */
export function listPromptKeys(): string[] {
  return Array.from(REGISTRY.keys());
}
