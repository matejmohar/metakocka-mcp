/**
 * Drafts of documents waiting to be saved. A draft holds the exact request
 * that commit_document sends, built and checked by the server; the model can
 * only refer to it by id, never change it. Each draft is saved at most once.
 */
import { randomBytes } from "node:crypto";
import type { MkRecord } from "../api.js";
import type { WritableDocType } from "./settings.js";

export type DraftStatus =
  /** Built and shown; can be committed. */
  | "open"
  /** put_document is running. */
  | "committing"
  /** Saved in Metakocka. */
  | "committed"
  /** put_document didn't answer (timeout, network): it may or may not have been saved. */
  | "unknown"
  | "discarded";

export interface DraftLine {
  productId: string;
  code?: string;
  /** Metakocka's product number (count_code). */
  countCode?: string;
  name: string;
  unit?: string;
  quantity: number;
  price: number;
  discountPercent: number;
  taxCode: string;
  taxRatePercent: number;
  net: number;
  tax: number;
  gross: number;
}

export interface DraftTotals {
  net: number;
  tax: number;
  gross: number;
  currency: string;
}

export interface Draft {
  id: string;
  docType: WritableDocType;
  status: DraftStatus;
  createdAt: number;
  expiresAt: number;
  language: "sl" | "en";
  partner: { id: string; name?: string; taxId?: string; addressId: string; address?: string };
  docDate: string;
  lines: DraftLine[];
  totals: DraftTotals;
  /** The put_document body, without credentials. Never changes after the draft is built. */
  payload: MkRecord;
  /** One-paragraph summary the user confirms. */
  summary: string;
  /** Set once committed. */
  result?: { mkId?: string; number?: string };
}

export const DRAFT_TTL_MS = 15 * 60_000;

export class DraftStore {
  private readonly drafts = new Map<string, Draft>();

  constructor(private readonly now: () => number = Date.now) {}

  add(draft: Omit<Draft, "id" | "status" | "createdAt" | "expiresAt">): Draft {
    this.prune();
    const created = this.now();
    const full: Draft = { ...draft, id: `d_${randomBytes(6).toString("hex")}`, status: "open", createdAt: created, expiresAt: created + DRAFT_TTL_MS };
    this.drafts.set(full.id, full);
    return full;
  }

  get(id: string): Draft | undefined {
    return this.drafts.get(id);
  }

  isExpired(draft: Draft): boolean {
    return draft.status === "open" && draft.expiresAt <= this.now();
  }

  /** Documents committed from this store, newest first, e.g. to warn about a duplicate. */
  committed(): Draft[] {
    return [...this.drafts.values()].filter((d) => d.status === "committed").reverse();
  }

  /** Forget expired and finished drafts after a day, but keep anything still unresolved. */
  private prune(): void {
    const cutoff = this.now() - 24 * 60 * 60_000;
    for (const [id, d] of this.drafts) {
      if (d.createdAt < cutoff && d.status !== "unknown" && d.status !== "committing") this.drafts.delete(id);
    }
  }
}
