/**
 * Credit notes (dobropis) to a sales invoice, as Metakocka knows them:
 * - goods: returned goods, lines as on the invoice (all of them, or some with smaller quantities);
 * - financial: a discount or correction afterwards, on service products;
 * - standalone: not linked to an invoice.
 * Saved not issued, like invoices. A linked credit note can't credit more than its invoice.
 */
import { findDocumentIdByNumber, getDocument, searchAllDocuments, type MkRecord } from "../api.js";
import { addDays, isIsoDate, toMkDate } from "../dates.js";
import { asArray, num, round2, str } from "../util.js";
import { loadCatalog, type CatalogProduct } from "./catalog.js";
import {
  catalogZeroTax,
  CHANGE_LOG_PREFIX,
  currencyCode,
  DraftError,
  linesAndTotals,
  oneLine,
  priceLine,
  productLine,
  productListPayload,
  resolveAddress,
  resolvePartner,
  totalsOf,
  type BuildContext,
  type LineInput,
} from "./document.js";
import type { Draft, DraftLine } from "./drafts.js";
import { purchaseProduct, taxCodeFor } from "./purchase.js";

export interface CreditNoteInput {
  credit_type?: "goods" | "financial" | "standalone";
  /** Number of the sales invoice it credits (goods and financial). */
  from_invoice?: string;
  /** Standalone: the partner. */
  partner_id?: string;
  address_id?: string;
  /** goods: which invoice lines and how much (default: all of them); financial / standalone: the lines. */
  lines?: LineInput[];
  due_days?: number;
  due_date?: string;
  note?: string;
  /** Standalone credit notes: ISO currency (default EUR); linked ones take the invoice's. */
  currency?: string;
  /** sales (dobropis we issue, default) or purchase (prejeti dobropis from a supplier). */
  side?: "sales" | "purchase";
  /** Purchase: the number printed on the supplier's credit note. */
  supplier_number?: string;
  /** Purchase: the date on the supplier's credit note (default today). */
  credit_note_date?: string;
  /** Purchase: the total with VAT as printed on it, checked against the lines. */
  credit_note_total?: number;
  language?: "sl" | "en";
}

export async function buildCreditNoteDraft(ctx: BuildContext, input: CreditNoteInput): Promise<{ draft: Draft; warnings: string[] }> {
  const type = input.credit_type;
  if (!type) throw new DraftError("Give credit_type: goods (returned goods), financial (a discount or correction) or standalone.");
  const warnings: string[] = [];
  const purchase = input.side === "purchase";
  if (!purchase) {
    for (const k of ["supplier_number", "credit_note_date", "credit_note_total"] as const) if (input[k] !== undefined) throw new DraftError(`${k} is only for side purchase.`);
  }
  const supplierNumber = input.supplier_number?.trim();
  if (purchase && !supplierNumber) throw new DraftError("Give supplier_number: the number printed on the supplier's credit note.");
  if (input.credit_note_date !== undefined && !isIsoDate(input.credit_note_date)) throw new DraftError("credit_note_date must be a date as YYYY-MM-DD.");
  const docDate = input.credit_note_date ?? ctx.today;
  if (docDate > ctx.today) throw new DraftError("credit_note_date is in the future.");
  const docType = purchase ? "purchase_bill_credit_note" : "sales_bill_credit_note";

  let invoice: MkRecord | undefined;
  if (type !== "standalone") {
    if (!input.from_invoice) throw new DraftError("Give from_invoice: the number of the invoice this credits.");
    if (input.partner_id) throw new DraftError("A credit note to an invoice takes the invoice's partner; leave partner_id out.");
    const invoiceTypes = purchase ? (["purchase_bill_domestic", "purchase_bill_foreign"] as const) : (["sales_bill_domestic", "sales_bill_foreign"] as const);
    for (const t of invoiceTypes) {
      const id = await findDocumentIdByNumber(ctx.client, t, input.from_invoice);
      if (id) {
        invoice = await getDocument(ctx.client, t, id);
        break;
      }
    }
    if (!invoice) throw new DraftError(`No ${purchase ? "received" : "sales"} invoice ${input.from_invoice} in Metakocka.`);
  } else if (input.from_invoice) {
    throw new DraftError("A standalone credit note isn't linked to an invoice; use credit_type goods or financial for that.");
  }

  const partnerId = invoice ? str((invoice.partner as MkRecord | undefined)?.mk_id) : input.partner_id;
  if (!partnerId) throw new DraftError("Give partner_id (from search_partners).");
  const partner = await resolvePartner(ctx.client, partnerId, { foreign: "allow", what: "Credit notes", discounts: "ignore" });
  const address = resolveAddress(partner, input.address_id ?? (invoice ? str((invoice.partner as MkRecord).mk_address_id) : undefined));

  const currency = invoice ? str(invoice.currency_code) ?? "EUR" : currencyCode(input.currency);
  if (invoice && input.currency && currencyCode(input.currency) !== currency) throw new DraftError(`Invoice ${input.from_invoice} is in ${currency}; the credit note takes its currency.`);
  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  let lines: DraftLine[];
  if (type === "goods") {
    lines = goodsLines(catalog, invoice!, input.from_invoice!, input.lines);
  } else {
    if (!input.lines?.length) throw new DraftError(`A ${type} credit note needs its lines.`);
    // A supplier's credit note is copied as printed: purchasing products, their price and VAT rate.
    const history = purchase
      ? (await searchAllDocuments(ctx.client, { docType: "purchase_bill_domestic", filters: [{ type: "partner_mk_id", value: partner.id }] }, 200)).documents
      : [];
    lines = input.lines.map((l, i) => {
      const n = i + 1;
      let line: DraftLine;
      if (purchase) {
        const product = purchaseProduct(catalog, l, n);
        if (!(l.quantity! > 0)) throw new DraftError(`Line ${n}: quantity must be more than 0.`);
        if (l.price === undefined || l.price < 0) throw new DraftError(`Line ${n}: give the net unit price as on the supplier's credit note.`);
        if (l.vat_percent === undefined) throw new DraftError(`Line ${n}: give vat_percent as on the supplier's credit note.`);
        line = priceLine({ product, quantity: l.quantity!, price: l.price, discountPercent: l.discount_percent ?? 0, taxCode: taxCodeFor(catalog, history, product, l.vat_percent, n), taxRatePercent: l.vat_percent });
      } else {
        line = productLine(catalog, l, i, { currency, foreignTax: partner.foreign && l.vat_percent === undefined ? catalogZeroTax(catalog) ?? "unknown" : undefined });
      }
      if (type === "financial" && !catalog.get(line.productId)?.service) {
        throw new DraftError(`Line ${i + 1}: ${line.name} is goods; a financial credit note takes only services (for returned goods use credit_type goods).`);
      }
      return line;
    });
  }
  const totals = totalsOf(lines, currency);
  if (input.credit_note_total !== undefined && Math.abs(Math.abs(input.credit_note_total) - totals.gross) > 0.005) {
    throw new DraftError(`The lines add up to ${totals.gross.toFixed(2)} with VAT, but credit_note_total is ${Math.abs(input.credit_note_total).toFixed(2)}. Check them against the supplier's credit note.`);
  }
  if (purchase && type === "goods" && lines.some((l) => !catalog.get(l.productId)?.service)) {
    warnings.push("Saving it also makes a goods received note (prevzemnica) for the returned goods, as Metakocka does for received invoices.");
  }
  if (purchase) {
    const norm = (v: string | undefined) => v?.trim().toLowerCase().replace(/\s+/g, "");
    const { documents } = await searchAllDocuments(ctx.client, { docType: "purchase_bill_credit_note", filters: [{ type: "partner_mk_id", value: partner.id }] }, 500);
    if (documents.some((d) => norm(str(d.count_code)) === norm(supplierNumber))) {
      throw new DraftError(`Credit note ${supplierNumber} from ${partner.name} is already in Metakocka. Nothing to do; don't enter it again.`);
    }
  }
  if (invoice) {
    const invoiceTotal = Math.abs(num(invoice.sum_all) ?? Number.POSITIVE_INFINITY);
    if (totals.gross > invoiceTotal + 0.005) throw new DraftError(`The credit note (${totals.gross}) is more than invoice ${input.from_invoice} (${invoiceTotal}).`);
    if (Math.abs(totals.gross - invoiceTotal) <= 0.005) warnings.push(`This credits invoice ${input.from_invoice} in full.`);
  }

  if (input.due_date !== undefined && !isIsoDate(input.due_date)) throw new DraftError("due_date must be a date as YYYY-MM-DD.");
  const dueDate = input.due_date ?? addDays(docDate, input.due_days ?? 0);

  const payload: MkRecord = {
    doc_type: docType,
    ...(purchase ? { count_code: supplierNumber, receive_date: toMkDate(ctx.today) } : {}),
    doc_date: toMkDate(docDate),
    service_to_date: toMkDate(docDate),
    duo_payment: toMkDate(dueDate),
    credit_note_type: type,
    ...(invoice ? { credit_note_bill: str(invoice.count_code) } : {}),
    partner: { mk_id: partner.id, mk_address_id: address.id },
    currency_code: currency,
    ...(input.note ? { notes: input.note } : {}),
    product_list: productListPayload(lines),
  };
  const sl = (input.language ?? "sl") === "sl";
  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const draft = ctx.drafts.add({ docType, language: sl ? "sl" : "en", partner: partnerRef, docDate, lines, totals, payload, summary: "" });
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  const kind = { goods: sl ? "vračilo blaga" : "returned goods", financial: sl ? "finančni" : "financial", standalone: sl ? "samostojen" : "standalone" }[type];
  draft.summary = [
    purchase
      ? `${sl ? "Vnesi PREJETI DOBROPIS" : "Enter a RECEIVED CREDIT NOTE"} ${supplierNumber} — ${kind} — ${sl ? "od" : "from"} ${partner.name}${partner.taxId ? ` (${partner.taxId})` : ""}`
      : `${sl ? "Ustvari DOBROPIS (neizdan)" : "Create a CREDIT NOTE (not issued)"} — ${kind} — ${sl ? "za" : "for"} ${partner.name}${partner.taxId ? ` (${partner.taxId})` : ""}`,
    address.text,
    ...(invoice ? [`${sl ? "K računu" : "To invoice"}: ${str(invoice.count_code)}`] : []),
    ...(input.note ? [`${sl ? "Opomba" : "Note"}: ${oneLine(input.note)}`] : []),
    "",
    ...linesAndTotals(draft),
    "",
    [`${sl ? "Datum" : "Dated"} ${docDate}`, `${sl ? "rok" : "due"} ${dueDate}`, ...(ctx.installation ? [`Metakocka: ${ctx.installation}`] : [])].join(" · "),
  ].join("\n");
  return { draft, warnings };
}

/** Returned goods: the invoice's lines as they are, all or the ones given with at most the invoiced quantity. */
function goodsLines(catalog: Map<string, CatalogProduct>, invoice: MkRecord, number: string, wanted: LineInput[] | undefined): DraftLine[] {
  const rates = new Map<string, number>();
  for (const p of catalog.values()) if (p.taxCode && p.taxRatePercent !== undefined) rates.set(p.taxCode, p.taxRatePercent);
  const invoiced = asArray<MkRecord>(invoice.product_list);
  const asLine = (l: MkRecord, quantity: number, n: number) => {
    const product = catalog.get(str(l.mk_id) ?? "");
    if (!product) throw new DraftError(`Invoice ${number}, line ${n} (${str(l.name) ?? "?"}) is not a product from the catalogue.`);
    const taxCode = str(l.tax) ?? "";
    const rate = rates.get(taxCode);
    if (rate === undefined) throw new DraftError(`Invoice ${number}, line ${n}: the rate of tax code ${taxCode || "(none)"} is unknown.`);
    return priceLine({ product, quantity, price: num(l.price) ?? 0, discountPercent: num(l.discount) ?? 0, taxCode, taxRatePercent: rate });
  };
  if (!wanted?.length) return invoiced.map((l, i) => asLine(l, num(l.amount) ?? 0, i + 1));
  return wanted.map((w, i) => {
    if (w.price !== undefined || w.discount_percent !== undefined) throw new DraftError(`Line ${i + 1}: returned goods are credited at the invoice's price; give only product and quantity.`);
    const index = invoiced.findIndex((l) => (w.product_id && str(l.mk_id) === w.product_id) || (w.code && str(l.code) === w.code));
    if (index < 0) throw new DraftError(`Line ${i + 1}: ${w.product_id ?? w.code} is not on invoice ${number}.`);
    const max = num(invoiced[index]!.amount) ?? 0;
    const quantity = w.quantity ?? max;
    if (!(quantity > 0) || quantity > max) throw new DraftError(`Line ${i + 1}: the quantity must be more than 0 and at most ${max}, as invoiced.`);
    return asLine(invoiced[index]!, round2(quantity), index + 1);
  });
}
