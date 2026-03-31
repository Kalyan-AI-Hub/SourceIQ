// src/lib/foundryLocal.ts — factory for FoundryLocalClient
//
// Two modes (controlled by FOUNDRY_USE_SDK env var):
//
//   SDK mode (default, FOUNDRY_USE_SDK=true):
//     Uses foundry-local-sdk native path:
//       FoundryLocalManager → model.load() → model.createChatClient() → completeChat()
//     This calls the Foundry Local DLL directly — no HTTP involved.
//     The web service is still started so health probes and the existing
//     HTTP fallback continue to work if the DLL path fails.
//
//   Fallback mode (FOUNDRY_USE_SDK=false):
//     Raw HTTP to FOUNDRY_LOCAL_ENDPOINT — identical to original behaviour.
//     Set this if the SDK causes issues; zero code changes required elsewhere.

import path from 'path';
import fs from 'fs';
import { FoundryLocalClient } from '../adapters/foundryLocal';
import type { IFoundryClient } from '../adapters/interfaces';
import {
  FOUNDRY_LOCAL_ENDPOINT,
  FOUNDRY_LOCAL_MODEL,
  FOUNDRY_LOCAL_APP_NAME,
  FOUNDRY_USE_SDK,
} from './env';

function resolveFoundryCoreLibraryPath(): string | undefined {
  try {
    const ext = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';
    const candidate = path.join(
      process.cwd(),
      'node_modules', 'foundry-local-sdk',
      'packages', '@foundry-local-core',
      `${process.platform}-${process.arch}`,
      `Microsoft.AI.Foundry.Local.Core${ext}`,
    );
    const realPath = fs.realpathSync(candidate);
    console.log(`[FoundrySDK] Resolved core library: ${realPath}`);
    return realPath;
  } catch (err) {
    console.warn('[FoundrySDK] Could not resolve core library path:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

function normalizeModelIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function isFoundryEndpointHealthy(endpoint: string): Promise<boolean> {
  const probePaths = ['/v1/models', '/openai/status'];
  try {
    for (const probePath of probePaths) {
      try {
        const response = await fetch(`${endpoint}${probePath}`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) return true;
      } catch {
        // Try the next supported probe path.
      }
    }
    return false;
  } catch {
    return false;
  }
}

// ── Singletons in globalThis ──────────────────────────────────────────────────
declare global {
  // eslint-disable-next-line no-var
  var __foundrySDKInitPromise: Promise<string> | null | undefined;
  // eslint-disable-next-line no-var
  var __foundryResolvedModel: string | undefined;
  // eslint-disable-next-line no-var
  var __foundrySDKModel: unknown; // loaded Model instance from SDK (used for native ChatClient)
}
if (globalThis.__foundrySDKInitPromise === undefined) globalThis.__foundrySDKInitPromise = null;
if (globalThis.__foundryResolvedModel === undefined)  globalThis.__foundryResolvedModel = FOUNDRY_LOCAL_MODEL;
if (globalThis.__foundrySDKModel === undefined)       globalThis.__foundrySDKModel = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveAndLoadModel(manager: any): Promise<void> {
  const configuredModel = FOUNDRY_LOCAL_MODEL.trim();
  globalThis.__foundryResolvedModel = configuredModel;

  const normalizedConfigured = normalizeModelIdentifier(configuredModel);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const models: Array<{ alias: string; variants?: Array<{ id: string }> }> = await manager.catalog.getModels();

  // Try exact alias match first, then variant ID match, then fuzzy
  const aliasMatch   = models.find(m => m.alias === configuredModel);
  const variantMatch = !aliasMatch && models.find(m =>
    (m.variants ?? []).some(v => v.id === configuredModel),
  );
  const fuzzyMatch   = !aliasMatch && !variantMatch && [...models]
    .sort((a, b) => normalizeModelIdentifier(b.alias).length - normalizeModelIdentifier(a.alias).length)
    .find(m => normalizedConfigured.includes(normalizeModelIdentifier(m.alias)));

  const resolvedAlias = aliasMatch?.alias
    ?? (variantMatch ? variantMatch.alias : undefined)
    ?? (fuzzyMatch   ? fuzzyMatch.alias   : undefined);
  if (!resolvedAlias) {
    console.warn(`[FoundrySDK] Could not match ${configuredModel} to any catalog model — skipping native SDK load`);
    return;
  }

  if (!aliasMatch) {
    console.log(`[FoundrySDK] Mapped ${configuredModel} → catalog alias "${resolvedAlias}"`);
  }

  // Get the Model object and select the exact variant ID if configured
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const model: any = await manager.catalog.getModel(resolvedAlias);
  if (!model) {
    console.warn(`[FoundrySDK] catalog.getModel("${resolvedAlias}") returned null`);
    return;
  }

  // If the configured model ID is a full variant ID (not just alias), select it
  if (configuredModel !== resolvedAlias) {
    try {
      model.selectVariant(configuredModel);
    } catch {
      // Some SDK catalogs expose only alias-level variants while HTTP mode accepts
      // the configured model id. In this case, skip native load and keep HTTP mode.
      console.warn(`[FoundrySDK] Configured model id ${configuredModel} is not selectable in SDK variants for alias ${resolvedAlias}; skipping native load`);
      return;
    }
  }

  // Load the model into memory (no-op if already loaded by Foundry Local desktop)
  if (!model.isCached) {
    console.warn(`[FoundrySDK] SDK-selected variant ${model.id} is not cached locally; skipping native load`);
    return;
  }

  const alreadyLoaded = await model.isLoaded();
  if (!alreadyLoaded) {
    console.log(`[FoundrySDK] Loading model ${model.id} into memory…`);
    await model.load();
    console.log(`[FoundrySDK] Model ${model.id} loaded — native SDK chat ready`);
  } else {
    console.log(`[FoundrySDK] Model ${model.id} already loaded — native SDK chat ready`);
  }

  globalThis.__foundrySDKModel = model;
}

export async function initFoundrySDK(): Promise<string> {
  if (!FOUNDRY_USE_SDK) {
    console.log('[FoundrySDK] SDK disabled (FOUNDRY_USE_SDK=false) — using raw HTTP endpoint');
    return FOUNDRY_LOCAL_ENDPOINT;
  }

  if (globalThis.__foundrySDKInitPromise) return globalThis.__foundrySDKInitPromise;

  globalThis.__foundrySDKInitPromise = (async (): Promise<string> => {
    try {
      const { FoundryLocalManager } = await import(
        /* webpackIgnore: true */ 'foundry-local-sdk'
      );

      const manager = FoundryLocalManager.create({
        appName:        FOUNDRY_LOCAL_APP_NAME,
        logLevel:       'warn',
        webServiceUrls: FOUNDRY_LOCAL_ENDPOINT,
        libraryPath:    resolveFoundryCoreLibraryPath(),
      });

      // Start HTTP web service first (used by default path + fallback).
      try {
        manager.startWebService();
        const endpoint = (manager.urls?.[0] ?? FOUNDRY_LOCAL_ENDPOINT) as string;
        console.log(`[FoundrySDK] HTTP service also available at ${endpoint}`);
      } catch (svcErr) {
        // Port already in use (Foundry Local desktop is running) — that's fine.
        // The native SDK path (globalThis.__foundrySDKModel) is already set up.
        console.log('[FoundrySDK] HTTP service already running on port 5273 — native SDK path active');
      }

      // Resolve model alias + attempt native SDK model load.
      // Non-fatal: if this fails, HTTP path still works.
      try {
        await resolveAndLoadModel(manager);
      } catch (nativeErr) {
        console.warn('[FoundrySDK] Native SDK model load skipped:', nativeErr instanceof Error ? nativeErr.message : nativeErr);
      }

      return FOUNDRY_LOCAL_ENDPOINT;
    } catch (err) {
      // DLL failed to load entirely — fall back to raw HTTP if the service is up
      if (await isFoundryEndpointHealthy(FOUNDRY_LOCAL_ENDPOINT)) {
        console.warn('[FoundrySDK] Native SDK unavailable — falling back to HTTP service:', err instanceof Error ? err.message : err);
        return FOUNDRY_LOCAL_ENDPOINT;
      }

      globalThis.__foundrySDKInitPromise = null;
      throw new Error(
        `[FoundrySDK] Native SDK failed and no Foundry Local HTTP service found at ${FOUNDRY_LOCAL_ENDPOINT}. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  return globalThis.__foundrySDKInitPromise;
}

export function createFoundryLocalClient(): IFoundryClient {
  return new FoundryLocalClient(FOUNDRY_LOCAL_ENDPOINT, FOUNDRY_LOCAL_MODEL);
}

export function getResolvedFoundryLocalModel(): string {
  return FOUNDRY_LOCAL_MODEL;
}
