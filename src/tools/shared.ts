import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { ConfigError } from "../config.js";

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
