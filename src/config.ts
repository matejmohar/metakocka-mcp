import { DEFAULT_BASE_URL, MetakockaClient } from "./client.js";

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MetakockaConfig {
  const companyId = env.METAKOCKA_COMPANY_ID?.trim();
  const secretKey = env.METAKOCKA_SECRET_KEY?.trim();
  if (!companyId || !secretKey) throw new ConfigError(SETUP_HELP);

  const timeoutMs = env.METAKOCKA_TIMEOUT_MS ? Number(env.METAKOCKA_TIMEOUT_MS) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("METAKOCKA_TIMEOUT_MS must be a positive number of milliseconds.");
  }
  return {
    companyId,
    secretKey,
    baseUrl: env.METAKOCKA_BASE_URL?.trim() || DEFAULT_BASE_URL,
    timeoutMs,
  };
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
