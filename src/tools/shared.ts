import type { ServerContext } from "@modelcontextprotocol/server";
import { listWarehouses, type MkRecord } from "../api.js";
import type { TtlCache } from "../cache.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { ConfigError } from "../config.js";
import type { WarehouseRef } from "../inventory.js";
import { str } from "../util.js";

export interface ToolContext {
  /** Folder for files the tools save (PDFs). Defaults to pdfDirectory() from config.ts. */
  pdfDir?: string;
  /** "embedded": return PDFs inside the tool result instead of saving them (HTTP server). */
  pdfDelivery?: "file" | "embedded";
  /** Throws ConfigError when credentials are missing. */
  getClient: () => MetakockaClient;
  /** Injected for tests. */
  now: () => Date;
  /** Shared by all tools of one server; see cache.ts. */
  cache: TtlCache;
  /** Downloads files Metakocka links to (accounting exports); injected for tests. Defaults to fetch. */
  fetchFile?: typeof fetch;
}

/** Warehouses change rarely and several tools need them to resolve names. */
export function cachedWarehouses(ctx: ToolContext): Promise<MkRecord[]> {
  const client = ctx.getClient();
  return ctx.cache.getOrLoad("warehouses", () => listWarehouses(client));
}

/** Called after each page fetched from Metakocka, with a short description of what's being read. */
export type ReportProgress = (message: string) => void;

/**
 * Progress notifications for long tool calls (many pages, several document
 * types). Clients ask for them by sending a progressToken; otherwise this does nothing.
 */
export function progressReporter(extra: Pick<ServerContext, "mcpReq"> | undefined): ReportProgress {
  const token = extra?.mcpReq._meta?.progressToken;
  if (token === undefined) return () => {};
  let step = 0;
  return (message) => {
    step++;
    extra!.mcpReq
      .notify({ method: "notifications/progress", params: { progressToken: token, progress: step, message } })
      .catch(() => {}); // progress is best-effort; never fail the tool over it
  };
}

export interface ToolResult {
  [key: string]: unknown;
  content: (
    | { type: "text"; text: string }
    | { type: "resource_link"; uri: string; name: string; mimeType?: string; description?: string }
    | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }
  )[];
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

/**
 * Like run(), for tools with an outputSchema: the value also goes into
 * structuredContent. It is round-tripped through JSON so it matches what the
 * text says exactly (undefined fields dropped).
 */
export async function runStructured(body: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    const text = JSON.stringify(await body());
    return { content: [{ type: "text", text }], structuredContent: JSON.parse(text) as Record<string, unknown> };
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
