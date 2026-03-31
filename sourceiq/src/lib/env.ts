// SourceIQ — Typed environment variable accessor (RULE 5)
// ALL process.env access goes through this file. No module reads process.env directly.
// Throws a descriptive error at startup if any required variable is missing.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[SourceIQ] Missing required environment variable: ${name}\n` +
      `Copy .env.example → .env.local and fill in all required values.`
    );
  }
  return value;
}

function optional(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function optionalNoDefault(name: string): string | undefined {
  return process.env[name];
}

// ── Required (no defaults) ────────────────────────────────────────────
export const FOUNDRY_LOCAL_MODEL    = required('FOUNDRY_LOCAL_MODEL');
export const LANCEDB_PATH           = required('LANCEDB_PATH');
export const SQLITE_PATH            = required('SQLITE_PATH');
export const GDELT_ENDPOINT         = required('GDELT_ENDPOINT');
export const NEXT_PUBLIC_APP_URL    = required('NEXT_PUBLIC_APP_URL');

// ── Optional with defaults ────────────────────────────────────────────
// FOUNDRY_LOCAL_ENDPOINT: foundry-local-sdk auto-discovers the port via startWebService().
// Set this only to pin a specific port or connect to an externally-started service.
export const FOUNDRY_LOCAL_ENDPOINT = optional('FOUNDRY_LOCAL_ENDPOINT', 'http://127.0.0.1:5273');
// FOUNDRY_LOCAL_APP_NAME: passed to foundry-local-sdk for logs/telemetry.
export const FOUNDRY_LOCAL_APP_NAME = optional('FOUNDRY_LOCAL_APP_NAME', 'sourceiq');
// FOUNDRY_USE_SDK: set to 'false' to bypass foundry-local-sdk and use raw HTTP (instant rollback).
export const FOUNDRY_USE_SDK        = optional('FOUNDRY_USE_SDK', 'true') === 'true';
export const RISK_POLL_INTERVAL_MS  = parseInt(optional('RISK_POLL_INTERVAL_MS', '900000'), 10);
export const NODE_ENV               = optional('NODE_ENV', 'development') as 'development' | 'production' | 'test';

// ── Optional, no default (cloud / paid services) ──────────────────────
export const AZURE_FOUNDRY_ENDPOINT = optionalNoDefault('AZURE_FOUNDRY_ENDPOINT');
export const AZURE_FOUNDRY_API_KEY  = optionalNoDefault('AZURE_FOUNDRY_API_KEY');
export const AZURE_FOUNDRY_MODEL    = optional('AZURE_FOUNDRY_MODEL', 'gpt-4o');
export const BING_SEARCH_API_KEY    = optionalNoDefault('BING_SEARCH_API_KEY');
export const STATE_DEPT_ADVISORY_URL = optional('STATE_DEPT_ADVISORY_URL', '');

// ── Optional: morning brief email (nodemailer SMTP) ───────────────────
export const ALERT_EMAIL_TO   = optionalNoDefault('ALERT_EMAIL_TO');   // recipient
export const SMTP_HOST        = optionalNoDefault('SMTP_HOST');         // e.g. smtp.gmail.com
export const SMTP_PORT        = optionalNoDefault('SMTP_PORT');         // e.g. 587
export const SMTP_USER        = optionalNoDefault('SMTP_USER');         // your login
export const SMTP_PASS        = optionalNoDefault('SMTP_PASS');         // app password

// ── Convenience object ────────────────────────────────────────────────
export const env = {
  FOUNDRY_LOCAL_ENDPOINT,
  FOUNDRY_LOCAL_MODEL,
  FOUNDRY_LOCAL_APP_NAME,
  FOUNDRY_USE_SDK,
  LANCEDB_PATH,
  SQLITE_PATH,
  GDELT_ENDPOINT,
  NEXT_PUBLIC_APP_URL,
  RISK_POLL_INTERVAL_MS,
  NODE_ENV,
  AZURE_FOUNDRY_ENDPOINT,
  AZURE_FOUNDRY_API_KEY,
  AZURE_FOUNDRY_MODEL,
  BING_SEARCH_API_KEY,
  STATE_DEPT_ADVISORY_URL,
  ALERT_EMAIL_TO,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
} as const;
