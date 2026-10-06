import type { MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { ConfigError } from "../config.js";
import type { WarehouseRef } from "../inventory.js";
import { str } from "../util.js";

export interface ToolContext {
  /** Throws ConfigError when credentials are missing. */
  getClient: () => MetakockaClient;
  /** Injected for tests. */
  now: () => Date;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Every tool here only reads data from Metakocka. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Run a tool body; return its value as compact JSON, or a readable error the model can act on. */
export async function run(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await body();
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: describeError(error) }] };
  }
}

export function describeError(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  if (error instanceof MetakockaError) return error.message;
  if (error instanceof Error) return `Unexpected error: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}

/** Find a warehouse by id, mark or name (case-insensitive), or explain which ones exist. */
export function resolveWarehouse(warehouses: MkRecord[], wanted: string): MkRecord {
  const w = warehouses.find((x) => [x.mk_id, x.mark, x.name].some((v) => str(v)?.toLowerCase() === wanted.toLowerCase()));
  if (!w) {
    const known = warehouses.map((x) => `${str(x.name)} (${str(x.mark)})`).join(", ");
    throw new MetakockaError(`Unknown warehouse "${wanted}". Known warehouses: ${known}`);
  }
  return w;
}

export function warehouseRef(w: MkRecord): WarehouseRef {
  return { id: str(w.mk_id), mark: str(w.mark), name: str(w.name) };
}

/** A `warning` field when some document types hit max_documents, so the model doesn't present partial totals as complete. */
export function truncationWarning(truncatedTypes: readonly string[], fix: string): { warning?: string } {
  return truncatedTypes.length
    ? { warning: `More documents matched than max_documents for: ${truncatedTypes.join(", ")}. Totals are incomplete — ${fix}.` }
    : {};
}
