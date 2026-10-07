/**
 * Changes to documents that already exist (update_document): a sales order's
 * status, tracking code, delivery type and shipping date, or invoicing it; an
 * invoice's status; a warehouse document's title, status or note; confirming
 * a transfer between warehouses. Only the fields Metakocka's API allows. The
 * document is read before (to show what changes) and after (to check).
 */
import { findDocumentIdByNumber, getDocument, searchDocuments, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { fromMkDate, isIsoDate, toMkDate } from "../dates.js";
import type { DocType } from "../doc-types.js";
import { bool, str } from "../util.js";
import type { ChangeCheck } from "./change.js";
import { DraftError, oneLine, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";
import { WAREHOUSE_TYPES, type WritableDocType } from "./settings.js";

export const ORDER_UPDATE_TYPES = ["sales_order"] as const;
export const INVOICE_UPDATE_TYPES = [
  "sales_bill_domestic",
  "sales_bill_foreign",
  "sales_bill_retail",
  "sales_bill_prepaid",
  "sales_bill_credit_note",
  "purchase_bill_domestic",
  "purchase_bill_foreign",
] as const;
export const WAREHOUSE_UPDATE_TYPES = [...WAREHOUSE_TYPES, "transfer_order"] as const;
export type UpdatableType = (typeof ORDER_UPDATE_TYPES)[number] | (typeof INVOICE_UPDATE_TYPES)[number] | (typeof WAREHOUSE_UPDATE_TYPES)[number];

/** Which change type (permission) covers a document type. */
export function updateKind(docType: UpdatableType): Extract<WritableDocType, "order_update" | "invoice_update" | "warehouse_update"> {
  if ((ORDER_UPDATE_TYPES as readonly string[]).includes(docType)) return "order_update";
  if ((INVOICE_UPDATE_TYPES as readonly string[]).includes(docType)) return "invoice_update";
  return "warehouse_update";
}

export interface UpdateInput {
  doc_type: UpdatableType;
  number?: string;
  id?: string;
  /** Status as in Metakocka's register for this kind of document; "" clears an invoice's status. */
  status?: string;
  /** Sales orders. */
  tracking_code?: string;
  delivery_type?: string;
  shipped_date?: string;
  create_invoice?: boolean;
  /** Sales orders and warehouse documents. */
  note?: string;
  /** Warehouse documents. */
  title?: string;
  buyer_order?: string;
  /** Transfers between warehouses. */
  confirm_transfer?: boolean;
  language?: "sl" | "en";
}

/** Fields each kind of document takes, and Metakocka's name for each. */
const FIELDS: Record<"order" | "invoice" | "warehouse" | "transfer", Partial<Record<keyof UpdateInput, string>>> = {
  order: { status: "status_code", tracking_code: "tracking_code", delivery_type: "delivery_type", shipped_date: "shipped_date", create_invoice: "create_invoice", note: "notes" },
  invoice: { status: "status_code" },
  warehouse: { title: "title", status: "status_code", note: "notes", buyer_order: "buyer_order", delivery_type: "delivery_type" },
  transfer: { confirm_transfer: "confirmed" },
};

const groupOf = (t: UpdatableType) =>
  t === "sales_order" ? "order" : t === "transfer_order" ? "transfer" : (INVOICE_UPDATE_TYPES as readonly string[]).includes(t) ? "invoice" : "warehouse";

/** update_document knows the transfer order as warehouse_transfer_order. */
const apiDocType = (t: UpdatableType) => (t === "transfer_order" ? "warehouse_transfer_order" : t);

export async function buildUpdateDraft(ctx: BuildContext, input: UpdateInput): Promise<{ draft: Draft; warnings: string[] }> {
  const group = groupOf(input.doc_type);
  const warningsBefore: string[] = [];
  const allowed = FIELDS[group];
  const given = (Object.keys(input) as (keyof UpdateInput)[]).filter((k) => !["doc_type", "number", "id", "language"].includes(k) && input[k] !== undefined);
  const misplaced = given.filter((k) => !allowed[k]);
  if (misplaced.length) {
    throw new DraftError(`${misplaced.join(", ")}: can't be changed on ${input.doc_type} through Metakocka's API. It takes: ${Object.keys(allowed).join(", ")}.`);
  }
  if (!given.length) throw new DraftError(`Nothing to change. ${input.doc_type} takes: ${Object.keys(allowed).join(", ")}.`);
  if (input.shipped_date !== undefined && !isIsoDate(input.shipped_date)) throw new DraftError("shipped_date must be a date as YYYY-MM-DD.");
  if (input.shipped_date && input.shipped_date > ctx.today) throw new DraftError("shipped_date is in the future.");
  if (input.tracking_code !== undefined && group === "order") {
    // Metakocka: "No invoice for given sales order. Tracking code cannot be add."
    warningsBefore.push("Metakocka takes a tracking code only once the order has an invoice.");
  }
  if (input.create_invoice === false) throw new DraftError("create_invoice can only be true (make the invoice).");
  if (input.confirm_transfer === false) throw new DraftError("confirm_transfer can only be true.");

  if (!input.number && !input.id) throw new DraftError("Give the document's number (as in Metakocka) or id.");
  const id = input.id ?? (await findDocumentIdByNumber(ctx.client, input.doc_type as DocType, input.number!));
  if (!id) throw new DraftError(`No ${input.doc_type} with number ${input.number} in Metakocka. Find it with search_documents.`);
  const doc = await getDocument(ctx.client, input.doc_type as DocType, id);
  const number = str(doc.count_code) ?? input.number;

  const warnings: string[] = [...warningsBefore];
  const changes: { field: string; label: string; from?: string; to: string }[] = [];
  const payload: MkRecord = { doc_type: apiDocType(input.doc_type), mk_id: id };
  for (const key of given) {
    const apiName = allowed[key]!;
    const value = input[key];
    const sent = key === "shipped_date" ? toMkDate(value as string) : typeof value === "boolean" ? String(value) : String(value).trim();
    const before = key === "shipped_date" ? fromMkDate(doc.shipped_date) : key === "confirm_transfer" ? (bool(doc.confirmed) ? "true" : undefined) : str(doc[apiName]);
    const shown = key === "shipped_date" ? (value as string) : String(value);
    if (key !== "create_invoice" && before !== undefined && before.toLowerCase() === shown.toLowerCase()) {
      warnings.push(`${key} is already ${before}; left as it is.`);
      continue;
    }
    payload[apiName] = sent;
    changes.push({ field: apiName, label: key, from: before, to: shown });
  }
  if (!changes.length) throw new DraftError(`${number} already has all of that; nothing to change.`);
  // Shipped orders need their date (Metakocka's note).
  if (payload.status_code && /^(shipped|odpremljen)/i.test(String(payload.status_code)) && group === "order" && !payload.shipped_date && !doc.shipped_date) {
    warnings.push("Shipped orders should have a shipped_date; add it to this change.");
  }
  if (payload.status_code !== undefined && payload.status_code !== "" && group !== "transfer") {
    const known = await knownStatuses(ctx.client, input.doc_type);
    const status = String(payload.status_code);
    if (known.length && !known.some((s) => s.toLowerCase() === status.toLowerCase())) {
      warnings.push(`No other ${input.doc_type} has the status "${status}"; statuses in use: ${known.join(", ")}. Metakocka refuses a status that isn't in its register.`);
    }
  }
  if (input.create_invoice) {
    warnings.push(
      "create_invoice lets Metakocka make the invoice by the company's own order settings, not by this server's checks: the invoice " +
        "type, numbering and a packing list follow those settings (in a test it made a foreign invoice for a domestic partner, " +
        "with a packing list). To control the invoice, use draft_document with from_order instead. Check it in Metakocka afterwards.",
    );
  }

  const partner = (doc.partner ?? {}) as MkRecord;
  const language = input.language ?? "sl";
  const sl = language === "sl";
  const draft = ctx.drafts.add({
    docType: updateKind(input.doc_type),
    language,
    partner: { id: str(partner.mk_id) ?? "", name: str(partner.customer), taxId: str(partner.tax_id_number), addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: str(doc.currency_code) ?? "EUR" },
    payload,
    summary: "",
    target: { docType: input.doc_type, mkId: id, number },
    change: {
      endpoint: "update_document",
      // Making the invoice can't be read back from the order; then only the user can check.
      ...(changes.some((c) => c.label !== "create_invoice") ? { check: (client: MetakockaClient) => checkUpdate(client, input.doc_type, id, changes) } : {}),
      manualCheck: `look in Metakocka whether ${number} has an invoice now`,
    },
  });
  const label = (c: (typeof changes)[number]) =>
    c.label === "create_invoice"
      ? sl ? "ustvari račun iz naročila" : "make the invoice from the order"
      : c.label === "confirm_transfer"
        ? sl ? "potrdi prenos" : "confirm the transfer"
        : `${c.label}: ${c.from === undefined ? (sl ? "(prazno)" : "(empty)") : oneLine(c.from)} → ${c.to === "" ? (sl ? "(prazno)" : "(empty)") : oneLine(c.to)}`;
  draft.summary = [
    `${sl ? "Spremeni" : "Change"} ${input.doc_type} ${number}${str(partner.customer) ? ` (${str(partner.customer)})` : ""}`,
    ...changes.map((c) => `  ${label(c)}`),
    ...(ctx.installation ? ["", `Metakocka: ${ctx.installation}`] : []),
  ].join("\n");
  return { draft, warnings };
}

/** Statuses on the latest documents of a type: the API has no list of the register. */
async function knownStatuses(client: MetakockaClient, docType: UpdatableType): Promise<string[]> {
  const { documents } = await searchDocuments(client, { docType: docType as DocType, limit: 100 });
  return [...new Set(documents.map((d) => str(d.status_code)).filter((s): s is string => !!s))];
}

/** Read the document back: every changed field must have its new value (create_invoice can't be read back). */
async function checkUpdate(client: MetakockaClient, docType: UpdatableType, id: string, changes: { field: string; label: string; to: string }[]): Promise<ChangeCheck> {
  const doc = await getDocument(client, docType as DocType, id);
  const readable = changes.filter((c) => c.label !== "create_invoice");
  const differing = readable.filter((c) => {
    const now = c.label === "shipped_date" ? fromMkDate(doc.shipped_date) : c.label === "confirm_transfer" ? (bool(doc.confirmed) ? "true" : "false") : str(doc[c.field]) ?? "";
    return (now ?? "").toLowerCase() !== c.to.toLowerCase();
  });
  if (differing.length === readable.length) return { done: false };
  return {
    done: true,
    warnings: differing.length ? [`CHECK IN METAKOCKA: ${differing.map((c) => c.label).join(", ")} didn't change.`] : [],
  };
}
