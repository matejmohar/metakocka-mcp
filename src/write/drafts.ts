/**
 * Drafts of documents waiting to be saved. A draft holds the exact request
 * that commit_document sends, built and checked by the server; the model can
 * only refer to it by id, never change it. Each draft is saved at most once.
 */
import { randomBytes } from "node:crypto";
import type { MkRecord } from "../api.js";
import type { ChangeSpec } from "./change.js";
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
  /** A file to attach once the document is saved (purchase invoices: the supplier's PDF). Never logged. */
  attachment?: { fileName: string; dataB64: string; bytes: number; attached?: boolean };
  /** A change to an existing document (payment, status): which one, and what it looked like when drafted. */
  target?: {
    docType: string;
    mkId: string;
    number?: string;
    /** Payments: sum_paid when drafted, and how much the payment changes it (negative for a refund). */
    paidBefore?: number;
    paidChange?: number;
    /** Status changes: the status when drafted, and the new one. */
    statusBefore?: string;
    status?: string;
  };
  /** New documents Metakocka saves with their own endpoint instead of put_document (transfers, work orders). */
  putEndpoint?: string;
  /** For changes saved with their own call (see change.ts): which call, and how to tell it took effect. */
  change?: ChangeSpec;
  /** Set once committed. */
  result?: { mkId?: string; number?: string; /** A new partner's address. */ addressId?: string; /** What a change call answered, for the tool's result. */ details?: Record<string, unknown> };
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
