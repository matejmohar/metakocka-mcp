/**
 * Opt-in settings for creating documents in Metakocka. Without
 * METAKOCKA_WRITE the server registers no write tools and stays read-only.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigError, envValue } from "../config.js";

/** Document types the write tools can create. Phase 1: offers only. */
export const WRITABLE_TYPES = { offers: "sales_offer" } as const;
export type WritableDocType = (typeof WRITABLE_TYPES)[keyof typeof WRITABLE_TYPES];

export interface WriteSettings {
  docTypes: WritableDocType[];
  /**
   * How the user confirms each document before it is saved:
   * - "client" (default): a confirmation prompt (MCP elicitation) where the client supports it; otherwise the
   *   client's own approval of the commit_document call, which must carry the draft's exact summary.
   * - "elicitation": only a confirmation prompt; clients without elicitation can't save at all.
   * - "never": no confirmation.
   */
  confirm: "client" | "elicitation" | "never";
  /** Timeout for put_document; Metakocka can take well over the read timeout to insert a document. */
  timeoutMs: number;
  /** JSONL audit log of every write; undefined = log to stderr (HTTP server). */
  logPath?: string;
}

const DEFAULT_WRITE_TIMEOUT_MS = 120_000;

/**
 * METAKOCKA_WRITE=offers (or METAKOCKA_WRITE_OFFERS=true, what the Claude
 * Desktop extension's checkbox sets) enables the offer tools. Returns
 * undefined when writing is off. Throws ConfigError for values it doesn't
 * understand, so a typo never silently changes what the server may do.
 */
export function writeSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): WriteSettings | undefined {
  const raw = envValue(env, "METAKOCKA_WRITE");
  const names = raw && !["off", "false", "0", "no"].includes(raw.toLowerCase()) ? raw.split(",") : [];
  if (flag(env, "METAKOCKA_WRITE_OFFERS")) names.push("offers");
  if (!names.length) return undefined;

  const docTypes: WritableDocType[] = [];
  for (const name of names.map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const type = WRITABLE_TYPES[name as keyof typeof WRITABLE_TYPES];
    if (!type) {
      throw new ConfigError(`METAKOCKA_WRITE: unknown value "${name}". Allowed: ${Object.keys(WRITABLE_TYPES).join(", ")}.`);
    }
    if (!docTypes.includes(type)) docTypes.push(type);
  }

  // "true"/"false" come from the extension's "Confirm each document" checkbox.
  const confirmRaw = (envValue(env, "METAKOCKA_WRITE_CONFIRM") ?? "client").toLowerCase();
  const confirm = confirmRaw === "true" ? "client" : confirmRaw === "false" ? "never" : confirmRaw;
  if (confirm !== "client" && confirm !== "elicitation" && confirm !== "never") {
    throw new ConfigError('METAKOCKA_WRITE_CONFIRM must be "client" (default), "elicitation" or "never".');
  }

  const timeoutRaw = envValue(env, "METAKOCKA_WRITE_TIMEOUT_SECONDS");
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_WRITE_TIMEOUT_MS : Number(timeoutRaw) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError("METAKOCKA_WRITE_TIMEOUT_SECONDS must be a positive number of seconds.");
  }

  return {
    docTypes,
    confirm,
    timeoutMs,
    logPath: envValue(env, "METAKOCKA_WRITE_LOG") ?? join(homedir(), ".metakocka-mcp", "writes.jsonl"),
  };
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = envValue(env, name)?.toLowerCase();
  if (value === undefined || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return true;
  throw new ConfigError(`${name} must be true or false.`);
}
