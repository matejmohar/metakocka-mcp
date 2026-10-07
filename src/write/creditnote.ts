/**
 * Credit notes (dobropis) to a sales invoice, as Metakocka knows them:
 * - goods: returned goods, lines as on the invoice (all of them, or some with smaller quantities);
 * - financial: a discount or correction afterwards, on service products;
 * - standalone: not linked to an invoice.
 * Saved not issued, like invoices. A linked credit note can't credit more than its invoice.
 */
import { findDocumentIdByNumber, getDocument, type MkRecord } from "../api.js";
import { addDays, isIsoDate, toMkDate } from "../dates.js";
import { asArray, num, round2, str } from "../util.js";
import { loadCatalog, type CatalogProduct } from "./catalog.js";
import {
  CHANGE_LOG_PREFIX,
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
  language?: "sl" | "en";
}

export async function buildCreditNoteDraft(ctx: BuildContext, input: CreditNoteInput): Promise<{ draft: Draft; warnings: string[] }> {
  const type = input.credit_type;
  if (!type) throw new DraftError("Give credit_type: goods (returned goods), financial (a discount or correction) or standalone.");
  const warnings: string[] = [];

  let invoice: MkRecord | undefined;
  if (type !== "standalone") {
    if (!input.from_invoice) throw new DraftError("Give from_invoice: the number of the invoice this credits.");
    if (input.partner_id) throw new DraftError("A credit note to an invoice takes the invoice's partner; leave partner_id out.");
    for (const docType of ["sales_bill_domestic", "sales_bill_foreign"] as const) {
      const id = await findDocumentIdByNumber(ctx.client, docType, input.from_invoice);
      if (id) {
        invoice = await getDocument(ctx.client, docType, id);
        break;
      }
    }
    if (!invoice) throw new DraftError(`No sales invoice ${input.from_invoice} in Metakocka.`);
    if ((str(invoice.currency_code) ?? "EUR") !== "EUR") throw new DraftError(`Invoice ${input.from_invoice} is in ${str(invoice.currency_code)}; only EUR is supported.`);
  } else if (input.from_invoice) {
    throw new DraftError("A standalone credit note isn't linked to an invoice; use credit_type goods or financial for that.");
  }

  const partnerId = invoice ? str((invoice.partner as MkRecord | undefined)?.mk_id) : input.partner_id;
  if (!partnerId) throw new DraftError("Give partner_id (from search_partners).");
  const partner = await resolvePartner(ctx.client, partnerId, { foreign: "allow", what: "Credit notes", discounts: "ignore" });
  const address = resolveAddress(partner, input.address_id ?? (invoice ? str((invoice.partner as MkRecord).mk_address_id) : undefined));

  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  let lines: DraftLine[];
  if (type === "goods") {
    lines = goodsLines(catalog, invoice!, input.from_invoice!, input.lines);
  } else {
    if (!input.lines?.length) throw new DraftError(`A ${type} credit note needs its lines.`);
    lines = input.lines.map((l, i) => {
      const line = productLine(catalog, l, i);
      if (type === "financial" && !catalog.get(line.productId)?.service) {
        throw new DraftError(`Line ${i + 1}: ${line.name} is goods; a financial credit note takes only services (for returned goods use credit_type goods).`);
      }
      return line;
    });
  }
  const totals = totalsOf(lines);
  if (invoice) {
    const invoiceTotal = Math.abs(num(invoice.sum_all) ?? Number.POSITIVE_INFINITY);
    if (totals.gross > invoiceTotal + 0.005) throw new DraftError(`The credit note (${totals.gross}) is more than invoice ${input.from_invoice} (${invoiceTotal}).`);
    if (Math.abs(totals.gross - invoiceTotal) <= 0.005) warnings.push(`This credits invoice ${input.from_invoice} in full.`);
  }

  if (input.due_date !== undefined && !isIsoDate(input.due_date)) throw new DraftError("due_date must be a date as YYYY-MM-DD.");
  const dueDate = input.due_date ?? addDays(ctx.today, input.due_days ?? 0);

  const payload: MkRecord = {
    doc_type: "sales_bill_credit_note",
    doc_date: toMkDate(ctx.today),
    service_to_date: toMkDate(ctx.today),
    duo_payment: toMkDate(dueDate),
    credit_note_type: type,
    ...(invoice ? { credit_note_bill: str(invoice.count_code) } : {}),
    partner: { mk_id: partner.id, mk_address_id: address.id },
    currency_code: "EUR",
    ...(input.note ? { notes: input.note } : {}),
    product_list: productListPayload(lines),
  };
  const sl = (input.language ?? "sl") === "sl";
  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const draft = ctx.drafts.add({ docType: "sales_bill_credit_note", language: sl ? "sl" : "en", partner: partnerRef, docDate: ctx.today, lines, totals, payload, summary: "" });
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  const kind = { goods: sl ? "vračilo blaga" : "returned goods", financial: sl ? "finančni" : "financial", standalone: sl ? "samostojen" : "standalone" }[type];
  draft.summary = [
    `${sl ? "Ustvari DOBROPIS (neizdan)" : "Create a CREDIT NOTE (not issued)"} — ${kind} — ${sl ? "za" : "for"} ${partner.name}${partner.taxId ? ` (${partner.taxId})` : ""}`,
    address.text,
    ...(invoice ? [`${sl ? "K računu" : "To invoice"}: ${str(invoice.count_code)}`] : []),
    ...(input.note ? [`${sl ? "Opomba" : "Note"}: ${oneLine(input.note)}`] : []),
    "",
    ...linesAndTotals(draft),
    "",
    [`${sl ? "Datum" : "Dated"} ${ctx.today}`, `${sl ? "rok" : "due"} ${dueDate}`, ...(ctx.installation ? [`Metakocka: ${ctx.installation}`] : [])].join(" · "),
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
