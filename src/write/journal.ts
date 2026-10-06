/**
 * Audit log of every attempt to write to Metakocka: one JSON object per line.
 * Never contains the secret key (the client adds credentials itself, after
 * the payload is logged). A failing log never blocks or fails a write.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface JournalEntry {
  event: "attempt" | "committed" | "failed" | "unknown" | "resolved";
  draft_id: string;
  doc_type: string;
  installation: string;
  company_id?: string;
  [key: string]: unknown;
}

export type Journal = (entry: JournalEntry) => Promise<void>;

/** Appends to a JSONL file; without a path, writes one line per entry to stderr (HTTP server logs). */
export function createJournal(path: string | undefined, now: () => Date = () => new Date()): Journal {
  let dirReady: Promise<unknown> | undefined;
  return async (entry) => {
    const line = JSON.stringify({ ts: now().toISOString(), ...entry });
    try {
      if (!path) {
        process.stderr.write(`[metakocka-mcp write] ${line}\n`);
        return;
      }
      dirReady ??= mkdir(dirname(path), { recursive: true });
      await dirReady;
      await appendFile(path, `${line}\n`, "utf8");
    } catch (error) {
      process.stderr.write(`[metakocka-mcp] could not write the audit log ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
}
