/**
 * A payment on a document that already exists (put_transaction): an invoice
 * paid, a prepayment on an offer or order, or a refund. Drafted, confirmed
 * and saved like documents. The amount is checked against what is still open,
 * and the payment type defaults to the one the company's earlier payments use.
 * Afterwards the document is read back to check that its paid amount moved
 * by exactly the payment.
 */
import { findDocumentIdByNumber, getDocument, searchDocuments, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { fromMkDate, isIsoDate, toMkDate } from "../dates.js";
import type { DocType } from "../doc-types.js";
import { asArray, round2, str, num } from "../util.js";
import type { CommitContext, CommitOutcome } from "./commit.js";
import { DraftError, money, oneLine, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";

/** Document types put_transaction takes. */
export const PAYABLE_TYPES = [
  "sales_bill_domestic",
  "sales_bill_foreign",
  "sales_bill_retail",
  "purchase_bill_domestic",
  "purchase_bill_foreign",
  "sales_offer",
  "sales_order",
] as const;
export type PayableType = (typeof PAYABLE_TYPES)[number];

export interface PaymentInput {
  doc_type: PayableType;
  /** Document number as shown in Metakocka, e.g. "RD-2/2026". */
  number?: string;
  /** Or its Metakocka id. */
  id?: string;
  /** Default: everything still open (for a refund: everything paid). */
  amount?: number;
  /** Default: today. */
  date?: string;
  /** payment (plačilo), prepayment (avans) or return (vračilo). */
  mode?: "payment" | "prepayment" | "return";
  /** As in Metakocka's register, e.g. "Transakcijski račun", "Gotovina". */
  payment_type?: string;
  cash_register?: string;
  note?: string;
  language?: "sl" | "en";
}

const isPurchase = (t: string) => t.startsWith("purchase_");

export async function buildPaymentDraft(ctx: BuildContext, input: PaymentInput): Promise<{ draft: Draft; warnings: string[] }> {
  const warnings: string[] = [];
  if (!input.number && !input.id) throw new DraftError("Give the document's number (as in Metakocka) or id.");
  const id = input.id ?? (await findDocumentIdByNumber(ctx.client, input.doc_type, input.number!));
  if (!id) throw new DraftError(`No ${input.doc_type} with number ${input.number} in Metakocka. Find it with search_documents.`);
  const doc = await readWithPayments(ctx.client, input.doc_type, id);
  const number = str(doc.count_code) ?? input.number;
  const currency = str(doc.currency_code) ?? "EUR";
  if (currency !== "EUR") throw new DraftError(`${number} is in ${currency}; only payments in EUR are supported.`);

  const total = Math.abs(num(doc.sum_all) ?? Number.NaN);
  if (!Number.isFinite(total)) throw new DraftError(`${number} has no total in Metakocka.`);
  const paid = Math.abs(num(doc.sum_paid) ?? 0);
  const open = round2(total - paid);
  const mode = input.mode ?? "payment";
  if (mode === "prepayment" && !["sales_offer", "sales_order"].includes(input.doc_type)) {
    throw new DraftError("A prepayment (avans) goes on an offer or a sales order; on an invoice it is a payment.");
  }

  let amount: number;
  if (mode === "return") {
    if (paid <= 0) throw new DraftError(`Nothing has been paid on ${number}, so nothing can be refunded.`);
    amount = round2(input.amount ?? paid);
    if (amount > paid + 0.005) throw new DraftError(`Only ${paid} has been paid on ${number}; a refund can't be more than that.`);
  } else {
    if (open <= 0) throw new DraftError(`${number} is already paid in full (${paid} of ${total}).`);
    amount = round2(input.amount ?? open);
    if (amount > open + 0.005) {
      throw new DraftError(`${number} has ${open} open (${paid} of ${total} paid); the payment can't be more than that. Overpayments are entered in Metakocka.`);
    }
  }
  if (!(amount > 0)) throw new DraftError("The amount must be more than 0.");

  const date = input.date ?? ctx.today;
  if (!isIsoDate(date)) throw new DraftError("date must be a date as YYYY-MM-DD.");
  if (date > ctx.today) throw new DraftError("The payment date can't be in the future.");
  const docDate = fromMkDate(doc.doc_date);
  if (docDate && date < docDate && mode !== "prepayment") warnings.push(`The payment date ${date} is before the document's date ${docDate}.`);

  const paymentType = input.payment_type?.trim() || (await usualPaymentType(ctx.client, doc, input.doc_type));
  if (!paymentType) {
    throw new DraftError(
      'There are no earlier payments to take the payment type from. Ask the user how it was paid (e.g. "Transakcijski račun" for a bank transfer, "Gotovina" for cash) and pass payment_type.',
    );
  }

  // The same payment already on the document is probably this one, entered before.
  const same = asArray<MkRecord>(doc.mark_paid).find(
    (p) => fromMkDate(p.date) === date && [num(p.amount), parseSl(p.amount)].some((a) => a !== undefined && Math.abs(a - amount) < 0.005),
  );
  if (same) warnings.push(`${number} already has a payment of ${amount} on ${date}. Make sure this is another one.`);

  const payload: MkRecord = {
    doc_type: input.doc_type,
    // Metakocka takes either mk_id or count_code, not both.
    mk_id: id,
    payment_mode: mode,
    payment_type: paymentType,
    ...(input.cash_register?.trim() ? { cash_register: input.cash_register.trim() } : {}),
    date: toMkDate(date),
    price: amount.toFixed(2),
    ...(input.note?.trim() ? { notes: input.note.trim().slice(0, 100) } : {}),
  };
  const partner = (doc.partner ?? {}) as MkRecord;
  const language = input.language ?? "sl";
  const draft = ctx.drafts.add({
    docType: "payment",
    language,
    partner: { id: str(partner.mk_id) ?? "", name: str(partner.customer), taxId: str(partner.tax_id_number), addressId: "" },
    docDate: date,
    lines: [],
    totals: { net: amount, tax: 0, gross: amount, currency },
    payload,
    summary: "",
    target: { docType: input.doc_type, mkId: id, number, paidBefore: paid, paidChange: mode === "return" ? -amount : amount },
  });

  const sl = language === "sl";
  const m = (n: number) => money(n, language);
  const head = {
    payment: sl ? (isPurchase(input.doc_type) ? "Zabeleži PLAČILO dobavitelju" : "Zabeleži PLAČILO") : isPurchase(input.doc_type) ? "Record a PAYMENT to the supplier" : "Record a PAYMENT",
    prepayment: sl ? "Zabeleži AVANS" : "Record a PREPAYMENT",
    return: sl ? "Zabeleži VRAČILO" : "Record a REFUND",
  }[mode];
  const remaining = mode === "return" ? round2(open + amount) : round2(open - amount);
  draft.summary = [
    `${head} ${m(amount)} ${sl ? "na" : "on"} ${number} (${str(partner.customer) ?? "?"})`,
    [
      `${sl ? "Datum" : "Date"} ${date}`,
      paymentType,
      ...(input.cash_register?.trim() ? [input.cash_register.trim()] : []),
    ].join(" · "),
    ...(input.note?.trim() ? [`${sl ? "Opomba" : "Note"}: ${oneLine(input.note).slice(0, 100)}`] : []),
    "",
    `${sl ? "Skupaj" : "Total"}: ${m(total)} · ${sl ? "plačano doslej" : "paid so far"}: ${m(paid)} · ${sl ? "odprto po vnosu" : "open afterwards"}: ${m(remaining)}`,
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings };
}

async function readWithPayments(client: MetakockaClient, docType: string, id: string): Promise<MkRecord> {
  return getDocument(client, docType as DocType, id, { show_payment_detail: "true" });
}

/** Payment amounts in mark_paid come in Slovenian format ("0,72"). */
function parseSl(value: unknown): number | undefined {
  return typeof value === "string" ? num(value.replace(/\./g, "").replace(",", ".")) : undefined;
}

/** The payment type used most on this document, else on the latest documents of its type. */
async function usualPaymentType(client: MetakockaClient, doc: MkRecord, docType: PayableType): Promise<string | undefined> {
  const mostCommon = (docs: MkRecord[]) => {
    const counts = new Map<string, number>();
    for (const d of docs) for (const p of asArray<MkRecord>(d.mark_paid)) {
      const t = str(p.payment_type);
      if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const own = mostCommon([doc]);
  if (own) return own;
  const { documents } = await searchDocuments(client, { docType, paymentDetail: true, limit: 100 });
  return mostCommon(documents);
}

/** Save a payment: one put_transaction, never retried, then check the document's paid amount. */
export async function commitPayment(ctx: CommitContext, draft: Draft): Promise<CommitOutcome> {
  const target = draft.target!;
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  // Someone may have entered it (or another payment) in Metakocka since it was drafted.
  const now = await readWithPayments(ctx.client, target.docType, target.mkId);
  if (Math.abs((num(now.sum_paid) ?? 0) - target.paidBefore!) > 0.005) {
    return {
      status: "rejected",
      message: `The paid amount of ${target.number} changed since this was drafted (now ${num(now.sum_paid) ?? 0}); nothing was saved. Check it and draft the payment again if it is still needed.`,
    };
  }
  draft.status = "committing";
  await ctx.journal({ ...base, event: "attempt", payload: draft.payload });
  try {
    await ctx.client.call("put_transaction", draft.payload, { idempotent: false, timeoutMs: ctx.timeoutMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MetakockaError && error.oprCode !== undefined) {
      draft.status = "open";
      await ctx.journal({ ...base, event: "failed", error: message });
      return { status: "rejected", message: `Metakocka refused the payment; nothing was saved: ${message}` };
    }
    draft.status = "unknown";
    await ctx.journal({ ...base, event: "unknown", error: message });
    return { status: "unknown", message: unknownMessage(message) };
  }
  return finishPayment(ctx, draft, []);
}

/** After an unknown outcome: the payment was saved if the document's paid amount moved by it. */
export async function resolveUnknownPayment(ctx: CommitContext, draft: Draft): Promise<CommitOutcome | { status: "not_found" } | { status: "ambiguous"; candidates: string[] }> {
  const target = draft.target!;
  const doc = await readWithPayments(ctx.client, target.docType, target.mkId);
  const paid = num(doc.sum_paid) ?? 0;
  const base = { draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation };
  if (Math.abs(paid - target.paidBefore!) <= 0.005) {
    draft.status = "open";
    await ctx.journal({ ...base, event: "resolved", found: null });
    return { status: "not_found" };
  }
  if (Math.abs(paid - (target.paidBefore! + target.paidChange!)) <= 0.005) {
    await ctx.journal({ ...base, event: "resolved", found: target.mkId });
    return finishPayment(ctx, draft, ["The save had not answered; the payment was found on the document afterwards."]);
  }
  return { status: "ambiguous", candidates: [`${target.number}: paid ${paid}, was ${target.paidBefore} before`] };
}

async function finishPayment(ctx: CommitContext, draft: Draft, warnings: string[]): Promise<CommitOutcome> {
  const target = draft.target!;
  draft.status = "committed";
  draft.result = { mkId: target.mkId, number: target.number };
  let paidNow: number | undefined;
  try {
    const doc = await readWithPayments(ctx.client, target.docType, target.mkId);
    paidNow = num(doc.sum_paid) ?? 0;
    const expected = round2(target.paidBefore! + target.paidChange!);
    if (Math.abs(paidNow - expected) > 0.005) {
      warnings.push(`CHECK IN METAKOCKA: ${target.number} now shows ${paidNow} paid, expected ${expected}.`);
    }
  } catch (error) {
    warnings.push(`The payment was saved, but reading ${target.number} back failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await ctx.journal({ draft_id: draft.id, doc_type: draft.docType, installation: ctx.installation, event: "committed", mk_id: target.mkId, number: target.number, warnings });
  return {
    status: "created",
    number: target.number,
    mk_id: target.mkId,
    total: draft.totals.gross,
    currency: draft.totals.currency,
    ...(paidNow !== undefined ? { paid_now: paidNow } : {}),
    warnings,
  };
}

function unknownMessage(reason: string): string {
  return (
    `It is not known whether the payment was saved (${reason}). Do NOT draft it again. ` +
    "Call commit_document with the same draft_id: it first checks the document's paid amount."
  );
}
