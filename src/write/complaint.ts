/**
 * Complaints (reklamacije): a new reclamation, return or replacement for a
 * sales order (create_complaint), or a complaint's new status, note or
 * return tracking code (update_complaint). Products are checked against the
 * order: only what was ordered, at most as much as was ordered.
 */
import { findDocumentIdByNumber, getDocument, searchDocuments, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { asArray, num, str } from "../util.js";
import type { ChangeCheck } from "./change.js";
import { DraftError, money, oneLine, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";

export const CLAIM_TYPES = ["reclamation", "return", "replacement"] as const;

export interface ComplaintLineInput {
  product_id?: string;
  code?: string;
  quantity?: number;
  reason?: string;
  description?: string;
  /** Replacement products: gross unit price. */
  price_with_tax?: number;
}

export interface ComplaintInput {
  /** create a new one, or update an existing one. */
  action?: "create" | "update";
  claim_type?: (typeof CLAIM_TYPES)[number];
  /** create: the sales order's number. */
  order_number?: string;
  products?: ComplaintLineInput[];
  replacement_products?: ComplaintLineInput[];
  reason?: string;
  description?: string;
  /** Account for a refund. */
  iban?: string;
  return_tracking_code?: string;
  /** update: the complaint's number, its new status and a note. */
  complaint_number?: string;
  status?: string;
  note?: string;
  language?: "sl" | "en";
}

const CLAIM_NAMES = { reclamation: ["REKLAMACIJO", "a RECLAMATION"], return: ["VRAČILO", "a RETURN"], replacement: ["ZAMENJAVO", "a REPLACEMENT"] } as const;

export async function buildComplaintDraft(ctx: BuildContext & { userEmail?: string }, input: ComplaintInput): Promise<{ draft: Draft; warnings: string[] }> {
  const sl = (input.language ?? "sl") === "sl";
  if (input.action === "update") return buildComplaintUpdate(ctx, input, sl);
  if (input.action !== "create") throw new DraftError("Give action: create or update.");
  if (!input.claim_type) throw new DraftError("Give claim_type: reclamation, return or replacement.");
  for (const k of ["complaint_number", "note"] as const) if (input[k] !== undefined) throw new DraftError(`${k} is only for action update.`);
  if (!input.order_number) throw new DraftError("Give order_number: the sales order the complaint is about.");
  const orderId = await findDocumentIdByNumber(ctx.client, "sales_order", input.order_number);
  if (!orderId) throw new DraftError(`No sales order ${input.order_number} in Metakocka.`);
  const order = await getDocument(ctx.client, "sales_order", orderId);
  const ordered = asArray<MkRecord>(order.product_list);
  if (!input.products?.length) throw new DraftError("Give the products the complaint is about, with quantities.");
  if (input.claim_type === "replacement" && !input.replacement_products?.length) throw new DraftError("A replacement needs replacement_products (with price_with_tax).");
  if (input.claim_type !== "replacement" && input.replacement_products?.length) throw new DraftError("replacement_products are only for claim_type replacement.");

  const line = (l: ComplaintLineInput, i: number, replacement: boolean): Record<string, string | undefined> => {
    const n = i + 1;
    if (!(l.quantity! > 0)) throw new DraftError(`${replacement ? "Replacement line" : "Line"} ${n}: quantity must be more than 0.`);
    if (replacement) {
      if (l.price_with_tax === undefined || l.price_with_tax < 0) throw new DraftError(`Replacement line ${n}: give price_with_tax.`);
      if (!l.product_id && !l.code) throw new DraftError(`Replacement line ${n}: give product_id or code.`);
      return { ...(l.product_id ? { mk_id: l.product_id } : { code: l.code }), amount: String(l.quantity), price_with_tax: String(l.price_with_tax) };
    }
    const o = ordered.find((x) => (l.product_id && str(x.mk_id) === l.product_id) || (l.code && str(x.code) === l.code));
    if (!o) throw new DraftError(`Line ${n}: ${l.product_id ?? l.code} is not on order ${input.order_number}.`);
    if (l.quantity! > (num(o.amount) ?? 0)) throw new DraftError(`Line ${n}: only ${str(o.amount)} of ${str(o.name) ?? str(o.code)} were ordered.`);
    return {
      ...(str(o.mk_id) ? { mk_id: str(o.mk_id) } : {}),
      code: str(o.code),
      amount: String(l.quantity),
      ...(l.reason ? { complaint_reason: l.reason } : {}),
      ...(l.description ? { complaint_description: l.description } : {}),
      name: str(o.name) ?? str(o.code),
    };
  };
  const products = input.products.map((l, i) => line(l, i, false));
  const replacements = (input.replacement_products ?? []).map((l, i) => line(l, i, true));

  const payload: MkRecord = {
    ...(ctx.userEmail ? { api_user_email: ctx.userEmail } : {}),
    claim_type: input.claim_type,
    sales_order_count_code: str(order.count_code) ?? input.order_number,
    ...(input.status ? { claim_status: input.status } : {}),
    ...(input.reason ? { claim_reason: input.reason } : {}),
    ...(input.description ? { claim_description: input.description } : {}),
    ...(input.return_tracking_code ? { return_tracking_code: input.return_tracking_code } : {}),
    ...(input.iban ? { partner: { iban: input.iban.replace(/\s+/g, "") } } : {}),
    complaint_products: products.map(({ name: _n, ...p }) => p),
    ...(replacements.length ? { replacement_products: replacements } : {}),
  };
  const warnings = ctx.userEmail ? [] : ["METAKOCKA_USER_EMAIL is not set; Metakocka may refuse a complaint without the e-mail of the user creating it."];
  const partner = (order.partner ?? {}) as MkRecord;
  const before = await complaintCount(ctx.client, str(order.count_code));
  const [nameSl, nameEn] = CLAIM_NAMES[input.claim_type];
  const draft = ctx.drafts.add({
    docType: "complaint",
    language: sl ? "sl" : "en",
    partner: { id: str(partner.mk_id) ?? "", name: str(partner.customer), addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload,
    summary: "",
    target: { docType: "sales_order", mkId: orderId, number: str(order.count_code) },
    change: {
      endpoint: "../create_complaint",
      // A new complaint shows among the order's complaints.
      ...(before !== undefined ? { check: async (client: MetakockaClient) => ({ done: ((await complaintCount(client, str(order.count_code))) ?? 0) > before }) } : {}),
      manualCheck: `look in Metakocka whether order ${str(order.count_code)} has the new complaint`,
    },
  });
  draft.summary = [
    `${sl ? `Ustvari ${nameSl}` : `Create ${nameEn}`} ${sl ? "za naročilo" : "for order"} ${str(order.count_code)} (${str(partner.customer) ?? "?"})`,
    ...(input.reason ? [`${sl ? "Razlog" : "Reason"}: ${input.reason}`] : []),
    ...(input.description ? [`${sl ? "Opis" : "Description"}: ${oneLine(input.description)}`] : []),
    `${sl ? "Izdelki" : "Products"}:`,
    ...products.map((p, i) => `  ${i + 1}. ${p.amount} × ${p.name}${p.complaint_reason ? ` — ${p.complaint_reason}` : ""}`),
    ...(replacements.length
      ? [`${sl ? "Zamenjava" : "Replacement"}:`, ...replacements.map((p, i) => `  ${i + 1}. ${p.amount} × ${p.mk_id ?? p.code} à ${money(Number(p.price_with_tax), sl ? "sl" : "en")}`)]
      : []),
    ...(input.iban ? [`IBAN: ${input.iban}`] : []),
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings };
}

/** How many complaints an order has, from the complaint search (undefined when the search can't tell). */
async function complaintCount(client: MetakockaClient, orderNumber: string | undefined): Promise<number | undefined> {
  if (!orderNumber) return undefined;
  try {
    const { documents } = await searchDocuments(client, { docType: "complaint", query: orderNumber, limit: 100 });
    // The search is free text; keep only complaints that name the order.
    return documents.filter((d) => JSON.stringify(d).includes(`"${orderNumber}"`)).length;
  } catch {
    return undefined;
  }
}

async function buildComplaintUpdate(ctx: BuildContext, input: ComplaintInput, sl: boolean): Promise<{ draft: Draft; warnings: string[] }> {
  for (const k of ["order_number", "products", "replacement_products", "reason", "description", "iban"] as const) {
    if (input[k] !== undefined) throw new DraftError(`${k} is only for action create; update takes status, note and return_tracking_code.`);
  }
  if (!input.complaint_number) throw new DraftError("Give complaint_number: the complaint's number in Metakocka.");
  if (!input.status) throw new DraftError("Give status: the complaint's status (Metakocka requires it on every update), e.g. draft, progress, completed.");
  const id = await findDocumentIdByNumber(ctx.client, "complaint", input.complaint_number);
  if (!id) throw new DraftError(`No complaint ${input.complaint_number} in Metakocka.`);
  const complaint = await getDocument(ctx.client, "complaint", id);
  const claimType = input.claim_type ?? str(complaint.claim_type);
  if (!claimType) throw new DraftError("Give claim_type: Metakocka needs it on every update.");
  const statusBefore = str(complaint.claim_status) ?? str(complaint.status_code);
  const payload: MkRecord = {
    claim_id: id,
    claim_type: claimType,
    claim_status: input.status,
    ...(input.note ? { claim_note: input.note } : {}),
    ...(input.return_tracking_code ? { return_tracking_code: input.return_tracking_code } : {}),
  };
  const draft = ctx.drafts.add({
    docType: "complaint",
    language: sl ? "sl" : "en",
    partner: { id: "", addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload,
    summary: "",
    target: { docType: "complaint", mkId: id, number: input.complaint_number },
    change: {
      endpoint: "../update_complaint",
      check: async (client): Promise<ChangeCheck> => {
        const now = await getDocument(client, "complaint", id);
        const status = str(now.claim_status) ?? str(now.status_code);
        return { done: status?.toLowerCase() === input.status!.toLowerCase() || (statusBefore?.toLowerCase() !== status?.toLowerCase() && status !== undefined) };
      },
    },
  });
  draft.summary = [
    `${sl ? "Spremeni REKLAMACIJO" : "Change COMPLAINT"} ${input.complaint_number}`,
    `  status: ${statusBefore ?? (sl ? "(prazno)" : "(empty)")} → ${input.status}`,
    ...(input.note ? [`  ${sl ? "opomba" : "note"}: ${oneLine(input.note)}`] : []),
    ...(input.return_tracking_code ? [`  return_tracking_code: ${input.return_tracking_code}`] : []),
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings: [] };
}
