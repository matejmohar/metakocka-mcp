import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MetakockaClient } from "./client.js";
import { InstallationUrlError, normalizeBaseUrl } from "./installation.js";

export interface MetakockaConfig {
  companyId: string;
  secretKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const SETUP_HELP = [
  "Metakocka is not configured yet.",
  "Set METAKOCKA_COMPANY_ID and METAKOCKA_SECRET_KEY in the MCP server's environment",
  "(in Claude Desktop: the \"env\" block of this server in claude_desktop_config.json).",
  "How to get both values from Metakocka:",
  "https://metakocka.freshdesk.com/en/support/solutions/articles/3000106126",
].join(" ");

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_MS = 300_000;

/**
 * An environment variable's value, or undefined when it is empty. Claude
 * Desktop extensions pass an optional setting the user left empty as the
 * literal placeholder (`${user_config.pdf_dir}`), which counts as empty too.
 */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value || /^\$\{user_config\.[^}]*\}$/.test(value)) return undefined;
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MetakockaConfig {
  const companyId = envValue(env, "METAKOCKA_COMPANY_ID");
  const secretKey = envValue(env, "METAKOCKA_SECRET_KEY");
  if (!companyId || !secretKey) throw new ConfigError(SETUP_HELP);

  // Settings that only take effect elsewhere are still checked here, so a typo shows up on the first tool call.
  cacheTtlMs(env, { strict: true });
  return { companyId, secretKey, baseUrl: baseUrlFromEnv(env), timeoutMs: timeoutMsFromEnv(env) };
}

/** The API base URL from METAKOCKA_BASE_URL (any form normalizeBaseUrl accepts), or the public installation. */
export function baseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return normalizeBaseUrl(envValue(env, "METAKOCKA_BASE_URL"));
  } catch (error) {
    if (error instanceof InstallationUrlError) throw new ConfigError(`METAKOCKA_BASE_URL: ${error.message}`);
    throw error;
  }
}

/** METAKOCKA_TIMEOUT_MS, or METAKOCKA_TIMEOUT_SECONDS (what the Claude Desktop extension sets). */
export function timeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const ms = envValue(env, "METAKOCKA_TIMEOUT_MS");
  const seconds = envValue(env, "METAKOCKA_TIMEOUT_SECONDS");
  if (ms === undefined && seconds === undefined) return DEFAULT_TIMEOUT_MS;
  const value = ms !== undefined ? Number(ms) : Number(seconds) * 1000;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(
      ms !== undefined
        ? "METAKOCKA_TIMEOUT_MS must be a positive number of milliseconds."
        : "METAKOCKA_TIMEOUT_SECONDS must be a positive number of seconds.",
    );
  }
  return value;
}

/**
 * How long lookups that rarely change (warehouses, partners) are cached.
 * METAKOCKA_CACHE_SECONDS=0 turns it off. An invalid value falls back to the
 * default, so the server still starts; with `strict` it throws instead.
 */
export function cacheTtlMs(env: NodeJS.ProcessEnv = process.env, { strict = false } = {}): number {
  const raw = envValue(env, "METAKOCKA_CACHE_SECONDS");
  if (raw === undefined) return DEFAULT_CACHE_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  if (strict) throw new ConfigError("METAKOCKA_CACHE_SECONDS must be a number of seconds, 0 or more (0 turns caching off).");
  return DEFAULT_CACHE_MS;
}

/** Where get_document_pdf saves files: METAKOCKA_PDF_DIR, else ~/Downloads, else the temp folder. */
export function pdfDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = envValue(env, "METAKOCKA_PDF_DIR");
  if (configured) return configured;
  const downloads = join(homedir(), "Downloads");
  return existsSync(downloads) ? join(downloads, "Metakocka") : join(tmpdir(), "metakocka");
}

/**
 * Returns a function that builds the client on first use. A missing
 * configuration therefore doesn't crash the server: the host still sees the
 * tools, and every tool call explains how to finish setup.
 */
export function lazyClientFromEnv(env: NodeJS.ProcessEnv = process.env): () => MetakockaClient {
  let client: MetakockaClient | undefined;
  return () => {
    if (!client) {
      const config = loadConfig(env);
      client = new MetakockaClient(config);
    }
    return client;
  };
}
