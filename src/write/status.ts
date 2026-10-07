/**
 * A sales order's new status (change_document_status), drafted, confirmed and
 * saved like documents. Statuses are the company's own (register "Prodajna
 * naročila - status"); the API can't list them, so the statuses of existing
 * orders are offered as hints and Metakocka refuses an unknown one.
 */
import { findDocumentIdByNumber, getDocument, searchDocuments, type MkRecord } from "../api.js";
import { MetakockaError } from "../client.js";
import { str } from "../util.js";
import type { CommitContext, CommitOutcome } from "./commit.js";
import { DraftError, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";

export interface StatusInput {
  /** Order number as shown in Metakocka, e.g. "PP-18495". */
  number?: string;
  id?: string;
  /** The new status, exactly as in Metakocka's register, e.g. "Odpremljen". */
  status?: string;
  language?: "sl" | "en";
}

export async function buildStatusDraft(ctx: BuildContext, input: StatusInput): Promise<{ draft: Draft; warnings: string[] }> {
  const status = input.status?.trim();
  if (!status) throw new DraftError("Give the new status, exactly as in Metakocka (e.g. \"Odpremljen\").");
  if (!input.number && !input.id) throw new DraftError("Give the sales order's number (as in Metakocka) or id.");
  const id = input.id ?? (await findDocumentIdByNumber(ctx.client, "sales_order", input.number!));
  if (!id) throw new DraftError(`No sales order ${input.number} in Metakocka. Find it with search_documents (doc_type sales_order).`);
  const order = await getDocument(ctx.client, "sales_order", id);
  const number = str(order.count_code) ?? input.number;
  const current = str(order.status_code);
  if (current && current.toLowerCase() === status.toLowerCase()) throw new DraftError(`${number} already has the status ${current}.`);

  const warnings: string[] = [];
  const known = await knownStatuses(ctx);
  if (known.length && !known.some((s) => s.toLowerCase() === status.toLowerCase())) {
    warnings.push(`No other sales order has the status "${status}"; statuses in use: ${known.join(", ")}. Metakocka refuses a status that isn't in its register.`);
  }

  const partner = (order.partner ?? {}) as MkRecord;
  const language = input.language ?? "sl";
  const draft = ctx.drafts.add({
    docType: "order_status",
    language,
    partner: { id: str(partner.mk_id) ?? "", name: str(partner.customer), taxId: str(partner.tax_id_number), addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: str(order.currency_code) ?? "EUR" },
    payload: { doc_type: "sales_order", mk_id: id, status_code: status },
    summary: "",
    target: { docType: "sales_order", mkId: id, number, statusBefore: current, status },
  });
  const sl = language === "sl";
  draft.summary = [
    `${sl ? "Spremeni STATUS prodajnega naročila" : "Change the STATUS of sales order"} ${number} (${str(partner.customer) ?? "?"})`,
    `${current ?? (sl ? "(brez statusa)" : "(no status)")} → ${status}`,
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings };
}

/** Statuses on the latest sales orders: the API has no list of the register. */
async function knownStatuses(ctx: BuildContext): Promise<string[]> {
  const { documents } = await searchDocuments(ctx.client, { docType: "sales_order", limit: 100 });
  return [...new Set(documents.map((d) => str(d.status_code)).filter((s): s is string => !!s))];
}

/** Save the status: one change_document_status, then read the order back. */
export async function commitStatus(ctx: CommitContext, draft: Draft): Promise<CommitOutcome> {
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  draft.status = "committing";
  await ctx.journal({ ...base, event: "attempt", payload: draft.payload });
  try {
    await ctx.client.call("change_document_status", draft.payload, { idempotent: false, timeoutMs: ctx.timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MetakockaError && error.oprCode !== undefined) {
      draft.status = "open";
      await ctx.journal({ ...base, event: "failed", error: message });
      const hint = /Dinamični šifrant|must be set|mora biti nastavljen/i.test(message)
        ? " The status must exist in Metakocka's register (Šifranti → Prodajna naročila - status), spelled exactly as there."
        : "";
      return { status: "rejected", message: `Metakocka refused the status; nothing was changed: ${message}${hint}` };
    }
    draft.status = "unknown";
    await ctx.journal({ ...base, event: "unknown", error: message });
    return {
      status: "unknown",
      message: `It is not known whether the status was changed (${message}). Call commit_document with the same draft_id: it first reads the order's status.`,
    };
  }
  return finishStatus(ctx, draft, []);
}

/** After an unknown outcome: the status was changed if the order now has it. */
export async function resolveUnknownStatus(ctx: CommitContext, draft: Draft): Promise<CommitOutcome | { status: "not_found" }> {
  const target = draft.target!;
  const order = await getDocument(ctx.client, "sales_order", target.mkId);
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  if (str(order.status_code)?.toLowerCase() === target.status!.toLowerCase()) {
    await ctx.journal({ ...base, event: "resolved", found: target.mkId });
    return finishStatus(ctx, draft, ["The change had not answered; the order has the new status now."]);
  }
  draft.status = "open";
  await ctx.journal({ ...base, event: "resolved", found: null });
  return { status: "not_found" };
}

async function finishStatus(ctx: CommitContext, draft: Draft, warnings: string[]): Promise<CommitOutcome> {
  const target = draft.target!;
  draft.status = "committed";
  draft.result = { mkId: target.mkId, number: target.number };
  let stored: string | undefined;
  try {
    const order = await getDocument(ctx.client, "sales_order", target.mkId);
    stored = str(order.status_code);
    if (stored?.toLowerCase() !== target.status!.toLowerCase()) {
      warnings.push(`CHECK IN METAKOCKA: ${target.number} shows the status ${stored ?? "(none)"}, not ${target.status}.`);
    }
  } catch (error) {
    warnings.push(`The status was changed, but reading ${target.number} back failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await ctx.journal({ draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation, event: "committed", mk_id: target.mkId, number: target.number, warnings });
  return { status: "created", number: target.number, mk_id: target.mkId, ...(stored ? { order_status: stored } : {}), warnings };
}
