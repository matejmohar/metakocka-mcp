/**
 * Saving a draft: one put_document, never retried, then a check that
 * Metakocka stored what the user confirmed. A call that didn't answer leaves
 * the draft "unknown" until a search shows whether the document exists.
 */
import { addAttachment, getDocument, putDocument, searchDocuments, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { fromMkDate } from "../dates.js";
import { asArray, num, str } from "../util.js";
import type { Draft, DraftStore } from "./drafts.js";
import type { Journal } from "./journal.js";
import { commitChange, resolveUnknownChange } from "./change.js";
import { commitPayment, resolveUnknownPayment } from "./payment.js";
import { commitRecord, resolveUnknownRecord } from "./records.js";
import { isRecordType, type NewDocumentType } from "./settings.js";

type DocumentType = NewDocumentType;

export interface CommitContext {
  client: MetakockaClient;
  drafts: DraftStore;
  journal: Journal;
  timeoutMs: number;
  /** Host of the Metakocka installation, for the audit log. */
  installation: string;
}

export type CommitOutcome =
  | {
      status: "created";
      number?: string;
      mk_id: string;
      total?: number;
      currency?: string;
      address_id?: string;
      paid_now?: number;
      details?: Record<string, unknown>;
      warnings: string[];
    }
  | { status: "rejected"; message: string }
  | { status: "unknown"; message: string };

export async function commitDraft(ctx: CommitContext, draft: Draft): Promise<CommitOutcome> {
  if (isRecordType(draft.docType)) return commitRecord(ctx, draft);
  if (draft.docType === "payment") return commitPayment(ctx, draft);
  if (draft.change) return commitChange(ctx, draft);
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  draft.status = "committing";
  await ctx.journal({ ...base, event: "attempt", payload: draft.payload });

  let response: MkRecord;
  try {
    response = draft.putEndpoint
      ? await ctx.client.call(draft.putEndpoint, draft.payload, { idempotent: false, timeoutMs: ctx.timeoutMs })
      : await putDocument(ctx.client, draft.payload, ctx.timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MetakockaError && error.oprCode !== undefined) {
      // Metakocka answered and refused: nothing was saved, the draft can be fixed and built again.
      draft.status = "open";
      await ctx.journal({ ...base, event: "failed", error: message });
      return { status: "rejected", message: `Metakocka refused the document; nothing was saved: ${message}` };
    }
    draft.status = "unknown";
    await ctx.journal({ ...base, event: "unknown", error: message });
    return { status: "unknown", message: unknownMessage(message) };
  }

  const mkId = str(response.mk_id);
  if (!mkId) {
    draft.status = "unknown";
    await ctx.journal({ ...base, event: "unknown", response });
    return { status: "unknown", message: unknownMessage("Metakocka answered without a document id") };
  }
  return finishCommitted(ctx, draft, mkId, str(response.count_code), verifyResponse(draft, response));
}

/** After an unknown outcome: look for the document before anything else may happen with this draft. */
export async function resolveUnknown(ctx: CommitContext, draft: Draft): Promise<CommitOutcome | { status: "not_found" } | { status: "ambiguous"; candidates: string[] }> {
  const docType = draft.docType;
  if (isRecordType(docType)) return resolveUnknownRecord(ctx, draft);
  if (docType === "payment") return resolveUnknownPayment(ctx, draft);
  if (draft.change) return resolveUnknownChange(ctx, draft);
  const { documents } = await searchDocuments(ctx.client, {
    docType: docType as DocumentType,
    dateFrom: draft.docDate,
    dateTo: draft.docDate,
    // Transfers between warehouses have no partner.
    filters: draft.partner.id ? [{ type: "partner_mk_id", value: draft.partner.id }] : [],
    limit: 100,
  });
  const known = new Set(ctx.drafts.committed().map((d) => d.result?.mkId));
  const candidates = documents.filter(
    (doc) =>
      !known.has(str(doc.mk_id)) &&
      asArray(doc.product_list).length === draft.lines.length &&
      Math.abs((num(doc.sum_all) ?? Number.NaN) - draft.totals.gross) < 0.01,
  );
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  if (candidates.length === 1) {
    const doc = candidates[0]!;
    await ctx.journal({ ...base, event: "resolved", found: str(doc.mk_id) });
    return finishCommitted(ctx, draft, str(doc.mk_id)!, str(doc.count_code), [
      "The save had not answered; this document was found afterwards and matches the draft.",
    ]);
  }
  if (!candidates.length) {
    draft.status = "open";
    await ctx.journal({ ...base, event: "resolved", found: null });
    return { status: "not_found" };
  }
  return { status: "ambiguous", candidates: candidates.map((d) => str(d.count_code) ?? str(d.mk_id) ?? "?") };
}

async function finishCommitted(ctx: CommitContext, draft: Draft, mkId: string, number: string | undefined, warnings: string[]): Promise<CommitOutcome> {
  const docType = draft.docType as DocumentType;
  draft.status = "committed";
  draft.result = { mkId, number };
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  try {
    warnings.push(...verifyStored(draft, await getDocument(ctx.client, docType, mkId)));
  } catch (error) {
    warnings.push(`The document was saved, but reading it back to check it failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = draft.attachment;
  if (file && !file.attached) {
    try {
      await addAttachment(ctx.client, docType, mkId, file.fileName, file.dataB64, ctx.timeoutMs);
      file.attached = true;
    } catch (error) {
      warnings.push(`The document was saved, but attaching ${file.fileName} failed; attach it in Metakocka: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await ctx.journal({ ...base, event: "committed", mk_id: mkId, number, warnings, ...(file ? { attachment: { file_name: file.fileName, bytes: file.bytes, attached: !!file.attached } } : {}) });
  return { status: "created", number, mk_id: mkId, total: draft.totals.gross, currency: draft.totals.currency, warnings };
}

/** put_document names the partner it used; anything else means Metakocka matched or created a different one. */
function verifyResponse(draft: Draft, response: MkRecord): string[] {
  const partnerId = str((response.partner as MkRecord | undefined)?.mk_id);
  return partnerId && partnerId !== draft.partner.id
    ? [`CHECK IN METAKOCKA: the document was saved for partner ${partnerId}, not ${draft.partner.id} (${draft.partner.name}).`]
    : [];
}

/** Compare the stored document with the draft the user confirmed. */
export function verifyStored(draft: Draft, doc: MkRecord): string[] {
  const problems: string[] = [];
  const partner = (doc.partner ?? {}) as MkRecord;
  if (str(partner.mk_id) && str(partner.mk_id) !== draft.partner.id) problems.push(`partner is ${str(partner.customer) ?? str(partner.mk_id)}, not ${draft.partner.name}`);
  if (str(partner.mk_address_id) && str(partner.mk_address_id) !== draft.partner.addressId) problems.push("partner address differs");

  // Transfers and work orders carry no prices.
  const unpriced = draft.docType === "transfer_order" || draft.docType === "workorder";
  const stored = asArray<MkRecord>(doc.product_list);
  if (stored.length !== draft.lines.length) problems.push(`${stored.length} lines stored, ${draft.lines.length} confirmed`);
  draft.lines.forEach((line, i) => {
    const s = stored[i];
    if (!s) return;
    const n = i + 1;
    if (str(s.mk_id) && str(s.mk_id) !== line.productId) problems.push(`line ${n} has product ${str(s.code) ?? str(s.mk_id)}, not ${line.code ?? line.productId}`);
    if (!near(num(s.amount), line.quantity, 1e-6)) problems.push(`line ${n} quantity ${str(s.amount)}, not ${line.quantity}`);
    if (!unpriced && !near(num(s.price), line.price, 1e-4)) problems.push(`line ${n} price ${str(s.price)}, not ${line.price}`);
    if (!unpriced && str(s.tax) && str(s.tax) !== line.taxCode) problems.push(`line ${n} tax ${str(s.tax)}, not ${line.taxCode}`);
  });
  const total = num(doc.sum_all);
  if (!unpriced && total !== undefined && !near(total, draft.totals.gross, 0.01)) problems.push(`total ${total}, not ${draft.totals.gross}`);
  const due = fromMkDate(draft.payload.duo_payment);
  if (due && fromMkDate(doc.duo_payment) && fromMkDate(doc.duo_payment) !== due) problems.push(`due date ${fromMkDate(doc.duo_payment)}, not ${due}`);
  // Invoices are meant to stay not issued until the user issues them in Metakocka.
  if (draft.docType.startsWith("sales_bill_") && str(doc.publish_ts)) problems.push("the invoice is already issued");
  // Purchase invoices carry the supplier's own number.
  const number = str(draft.payload.count_code);
  if (draft.docType.startsWith("purchase_bill_") && number && str(doc.count_code) && str(doc.count_code) !== number) problems.push(`number ${str(doc.count_code)}, not ${number}`);
  return problems.length ? [`CHECK IN METAKOCKA — the stored document differs from what was confirmed: ${problems.join("; ")}.`] : [];
}

function near(a: number | undefined, b: number, tolerance: number): boolean {
  return a !== undefined && Math.abs(a - b) <= tolerance;
}

function unknownMessage(reason: string): string {
  return (
    `It is not known whether the document was saved (${reason}). Do NOT create it again. ` +
    "Call commit_document with the same draft_id: it first checks Metakocka for the document and only then allows another attempt."
  );
}
