/**
 * Builds a sales invoice (račun) draft: domestic or foreign, from products or
 * from an existing offer or sales order. Metakocka saves an invoice from the API as not yet
 * issued (no publish_ts); the user issues (prints) it in Metakocka. It moves
 * no stock. What Metakocka requires and doesn't fill in itself comes from
 * the partner: the payment term from its address or its last invoice, and on
 * foreign invoices the VAT note from its last foreign invoice. Nothing is
 * written here.
 */
import { findDocumentIdByNumber, getDocument, searchAllDocuments, type MkRecord } from "../api.js";
import { addDays, daysBetween, fromMkDate, isIsoDate, toMkDate } from "../dates.js";
import { asArray, num, str } from "../util.js";
import { loadCatalog, type CatalogProduct } from "./catalog.js";
import {
  CHANGE_LOG_PREFIX,
  DraftError,
  duplicateWarning,
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
  type TaxFallback,
} from "./document.js";
import type { Draft, DraftLine } from "./drafts.js";

export type InvoiceType = "sales_bill_domestic" | "sales_bill_foreign";

export interface InvoiceInput {
  doc_type: InvoiceType;
  /** Optional when the invoice is made from an offer or order: its partner. */
  partner_id?: string;
  address_id?: string;
  lines?: LineInput[];
  /** Number of an offer (e.g. "4/2026") whose lines the invoice takes and which it is linked to. */
  from_offer?: string;
  /** Number of a sales order, the same way. */
  from_order?: string;
  /** Service period (datum opravljene storitve); service_to defaults to the invoice date. */
  service_from?: string;
  service_to?: string;
  due_date?: string;
  due_days?: number;
  title?: string;
  note?: string;
  language?: "sl" | "en";
}

/** What the draft took from elsewhere, for the tool's answer. */
export interface InvoiceInfo {
  due_date: string;
  due_from: string;
  service_from?: string;
  service_to: string;
  from_offer?: string;
  from_order?: string;
}

/** How many of the partner's invoices are read for its payment term, VAT note and already-invoiced offers. */
const HISTORY_MAX = 500;

export async function buildInvoiceDraft(
  ctx: BuildContext,
  input: InvoiceInput,
): Promise<{ draft: Draft; warnings: string[]; info: InvoiceInfo }> {
  const warnings: string[] = [];
  const foreignInvoice = input.doc_type === "sales_bill_foreign";

  if (input.from_offer && input.from_order) throw new DraftError("Give either from_offer or from_order, not both.");
  const sourceNumber = input.from_offer ?? input.from_order;
  if (sourceNumber && input.lines?.length) throw new DraftError(`Give either lines or ${input.from_offer ? "from_offer" : "from_order"}, not both.`);
  const source = input.from_offer
    ? await loadSource(ctx, "sales_offer", input.from_offer)
    : input.from_order
      ? await loadSource(ctx, "sales_order", input.from_order)
      : undefined;
  const sourceLabel = input.from_offer ? `Offer ${input.from_offer}` : `Sales order ${input.from_order}`;
  // The rest of this function calls the source document "offer", whichever kind it is.
  const offer = source;
  const offerPartnerId = offer ? str((offer.partner as MkRecord | undefined)?.mk_id) : undefined;
  if (offer && input.partner_id && offerPartnerId !== input.partner_id) {
    throw new DraftError(`${sourceLabel} is for another partner (${str((offer.partner as MkRecord).customer) ?? offerPartnerId}).`);
  }
  const partnerId = input.partner_id ?? offerPartnerId;
  if (!partnerId) throw new DraftError("Give partner_id (from search_partners).");

  const partner = await resolvePartner(ctx.client, partnerId, { foreign: "allow", what: "Invoices" });
  if (partner.foreign !== foreignInvoice) {
    throw new DraftError(
      partner.foreign
        ? `${partner.name} is a foreign partner: use doc_type sales_bill_foreign.`
        : `${partner.name} is a domestic partner: use doc_type sales_bill_domestic.`,
    );
  }
  const address = resolveAddress(partner, input.address_id ?? (offer ? str((offer.partner as MkRecord).mk_address_id) : undefined));

  // The partner's earlier invoices of this type, newest first; read only when something is taken from them.
  let history: MkRecord[] | undefined;
  const partnerInvoices = async () => {
    if (!history) {
      const { documents } = await searchAllDocuments(
        ctx.client,
        { docType: input.doc_type, filters: [{ type: "partner_mk_id", value: partner.id }] },
        HISTORY_MAX,
      );
      history = documents
        .filter((d) => str((d.partner as MkRecord | undefined)?.mk_id) === partner.id)
        .sort((a, b) => (fromMkDate(b.doc_date) ?? "").localeCompare(fromMkDate(a.doc_date) ?? "") || (str(b.mk_id) ?? "").localeCompare(str(a.mk_id) ?? ""));
    }
    return history;
  };

  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  let lines: DraftLine[];
  if (offer) {
    lines = offerLines(catalog, offer, sourceLabel);
    const links = input.from_offer ? "offer_list" : "sales_order_list";
    const invoiced = (await partnerInvoices()).find((d) =>
      asArray<MkRecord>(d[links]).some((o) => str(o.mk_id) === str(offer.mk_id) || str(o.count_code) === str(offer.count_code)),
    );
    if (invoiced) warnings.push(`${sourceLabel} already has an invoice: ${str(invoiced.count_code) ?? str(invoiced.mk_id)}.`);
  } else {
    if (!input.lines?.length) throw new DraftError("An invoice needs at least one product line, or from_offer / from_order.");
    const fallback = foreignInvoice ? await zeroTax(catalog, partnerInvoices) : undefined;
    lines = input.lines.map((line, i) => productLine(catalog, line, i, fallback));
  }
  if (foreignInvoice) {
    lines.forEach((l, i) => {
      if (l.taxRatePercent !== 0) {
        throw new DraftError(
          `Line ${i + 1}: ${l.name} has ${l.taxRatePercent} % VAT (${l.taxCode}). Foreign invoices here only take lines without VAT ` +
            "(e.g. reverse charge); create an invoice with VAT in Metakocka.",
        );
      }
    });
  }
  const totals = totalsOf(lines);

  // Service period.
  for (const [name, value] of [["service_from", input.service_from], ["service_to", input.service_to], ["due_date", input.due_date]] as const) {
    if (value !== undefined && !isIsoDate(value)) throw new DraftError(`${name} must be a date as YYYY-MM-DD.`);
  }
  const serviceTo = input.service_to ?? ctx.today;
  if (input.service_from && input.service_from > serviceTo) throw new DraftError("service_from is after service_to.");

  // Payment term: given, the partner's in Metakocka, or the one its last invoice had.
  let dueDate: string;
  let dueFrom: string;
  const addressDays = num(address.record.payment_due_days);
  if (input.due_date) {
    if (input.due_date < ctx.today) throw new DraftError("due_date is before the invoice date.");
    [dueDate, dueFrom] = [input.due_date, "given"];
  } else if (input.due_days !== undefined) {
    [dueDate, dueFrom] = [addDays(ctx.today, input.due_days), "given"];
  } else if (addressDays !== undefined && addressDays >= 0) {
    [dueDate, dueFrom] = [addDays(ctx.today, addressDays), "partner's payment term in Metakocka"];
  } else {
    const last = (await partnerInvoices()).find((d) => fromMkDate(d.doc_date) && fromMkDate(d.duo_payment));
    const days = last ? daysBetween(fromMkDate(last.doc_date)!, fromMkDate(last.duo_payment)!) : undefined;
    if (days === undefined || days < 0) {
      throw new DraftError(
        `${partner.name} has no payment term in Metakocka and no earlier invoice to take one from. ` +
          "Ask the user for the payment term and pass due_days (or due_date).",
      );
    }
    [dueDate, dueFrom] = [addDays(ctx.today, days), `${days === 1 ? "1 day" : `${days} days`}, as on the partner's last invoice ${str(last!.count_code)}`];
  }

  // Note: given, or on a foreign invoice the VAT note of the partner's last foreign invoice.
  let note = input.note?.trim() || undefined;
  if (input.note === undefined && foreignInvoice) {
    const last = (await partnerInvoices()).find((d) => str(d.notes)?.trim());
    if (!last) {
      throw new DraftError(
        `A foreign invoice needs the VAT note (e.g. reverse charge), and ${partner.name} has no earlier foreign invoice to take it from. ` +
          'Ask the user for the note and pass it as note (or note "" for none).',
      );
    }
    note = str(last.notes)!.trim();
    warnings.push(`The note is copied from the partner's last foreign invoice ${str(last.count_code)}.`);
  }

  const payload: MkRecord = {
    doc_type: input.doc_type,
    doc_date: toMkDate(ctx.today),
    ...(input.service_from ? { service_from_date: toMkDate(input.service_from) } : {}),
    service_to_date: toMkDate(serviceTo),
    duo_payment: toMkDate(dueDate),
    partner: { mk_id: partner.id, mk_address_id: address.id },
    currency_code: "EUR",
    ...(input.title ? { title: input.title } : {}),
    ...(note ? { notes: note } : {}),
    ...(offer ? { [input.from_offer ? "offer_list" : "sales_order_list"]: [{ count_code: str(offer.count_code) }] } : {}),
    product_list: productListPayload(lines),
  };

  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const same = duplicateWarning(ctx.drafts, { docType: input.doc_type, partner: partnerRef, docDate: ctx.today, totals }, "An invoice");
  if (same) warnings.push(same);

  const draft = ctx.drafts.add({
    docType: input.doc_type,
    language: input.language ?? "sl",
    partner: partnerRef,
    docDate: ctx.today,
    lines,
    totals,
    payload,
    summary: "",
  });
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  const info: InvoiceInfo = {
    due_date: dueDate,
    due_from: dueFrom,
    service_from: input.service_from,
    service_to: serviceTo,
    from_offer: input.from_offer && offer ? str(offer.count_code) : undefined,
    from_order: input.from_order && offer ? str(offer.count_code) : undefined,
  };
  draft.summary = summarize(draft, { ...info, title: input.title, note }, ctx.installation);
  return { draft, warnings, info };
}

/** The offer or sales order an invoice is made from. */
async function loadSource(ctx: BuildContext, docType: "sales_offer" | "sales_order", number: string): Promise<MkRecord> {
  const what = docType === "sales_offer" ? "offer" : "sales order";
  const id = await findDocumentIdByNumber(ctx.client, docType, number);
  if (!id) throw new DraftError(`No ${what} ${number} in Metakocka. Find it with search_documents (doc_type ${docType}) and use its number.`);
  const doc = await getDocument(ctx.client, docType, id);
  if ((str(doc.currency_code) ?? "EUR") !== "EUR") throw new DraftError(`The ${what} ${number} is in ${str(doc.currency_code)}; only EUR is supported.`);
  return doc;
}

/** The offer's (or order's) lines as they are on it: product, quantity, price, discount and tax code. `number` names it, e.g. "Offer 4/2026". */
function offerLines(catalog: Map<string, CatalogProduct>, offer: MkRecord, number: string): DraftLine[] {
  const rates = new Map<string, number>();
  for (const p of catalog.values()) if (p.taxCode && p.taxRatePercent !== undefined) rates.set(p.taxCode, p.taxRatePercent);
  const lines = asArray<MkRecord>(offer.product_list);
  if (!lines.length) throw new DraftError(`${number} has no lines.`);
  return lines.map((l, i) => {
    const n = i + 1;
    const product = catalog.get(str(l.mk_id) ?? "");
    if (!product) {
      throw new DraftError(
        `${number}, line ${n} (${str(l.name) ?? "?"}) is not a product from the catalogue, and Metakocka's API takes only products. ` +
          "Make the invoice from products instead (lines), or in Metakocka.",
      );
    }
    if (!product.active) throw new DraftError(`${number}, line ${n}: ${product.name} is not active in Metakocka any more.`);
    const taxCode = str(l.tax);
    const taxRatePercent = taxCode === undefined ? undefined : rates.get(taxCode);
    if (!taxCode || taxRatePercent === undefined) {
      throw new DraftError(`${number}, line ${n}: tax code ${taxCode ?? "(none)"} is not used by any product's price list, so its rate is unknown.`);
    }
    const quantity = num(l.amount);
    const price = num(l.price);
    if (!quantity || quantity <= 0 || price === undefined) throw new DraftError(`${number}, line ${n}: quantity or price is missing.`);
    return priceLine({ product, quantity, price, discountPercent: num(l.discount) ?? 0, taxCode, taxRatePercent });
  });
}

/**
 * The 0 % tax code for products without one of their own on a foreign invoice: the only 0 % code in the
 * catalogue, or else the one code on the partner's last foreign invoice without VAT.
 */
async function zeroTax(catalog: Map<string, CatalogProduct>, partnerInvoices: () => Promise<MkRecord[]>): Promise<TaxFallback | undefined> {
  const zero = new Set([...catalog.values()].filter((p) => p.taxCode && p.taxRatePercent === 0).map((p) => p.taxCode!));
  if (zero.size === 1) return { code: [...zero][0]!, ratePercent: 0 };
  if (zero.size > 1) return undefined;
  for (const d of await partnerInvoices()) {
    const codes = new Set(asArray<MkRecord>(d.product_list).map((l) => str(l.tax)));
    if (num(d.sum_all) !== undefined && num(d.sum_all) === num(d.sum_basic) && codes.size === 1 && [...codes][0]) {
      return { code: [...codes][0]!, ratePercent: 0 };
    }
  }
  return undefined;
}

/** What the user confirms; see the offer's summarize. */
function summarize(
  d: Draft,
  extra: InvoiceInfo & { title?: string; note?: string },
  installation: string | undefined,
): string {
  const foreign = d.docType === "sales_bill_foreign";
  const t =
    d.language === "sl"
      ? {
          head: foreign ? "Ustvari TUJI RAČUN (neizdan) za" : "Ustvari RAČUN (neizdan) za",
          offer: "Iz ponudbe",
          order: "Iz prodajnega naročila",
          title: "Naziv",
          note: "Opomba",
          date: "Datum",
          service: "storitev",
          due: "rok plačila",
        }
      : {
          head: foreign ? "Create a FOREIGN INVOICE (not issued) for" : "Create an INVOICE (not issued) for",
          offer: "From offer",
          order: "From sales order",
          title: "Title",
          note: "Note",
          date: "Dated",
          service: "service",
          due: "due",
        };
  const service = extra.service_from && extra.service_from !== extra.service_to ? `${extra.service_from} – ${extra.service_to}` : extra.service_to;
  return [
    `${t.head} ${d.partner.name}${d.partner.taxId ? ` (${d.partner.taxId})` : ""}`,
    d.partner.address,
    ...(extra.from_offer ? [`${t.offer}: ${extra.from_offer}`] : []),
    ...(extra.from_order ? [`${t.order}: ${extra.from_order}`] : []),
    ...(extra.title ? [`${t.title}: ${extra.title}`] : []),
    ...(extra.note ? [`${t.note}: ${oneLine(extra.note)}`] : []),
    "",
    ...linesAndTotals(d),
    "",
    [`${t.date} ${d.docDate}`, `${t.service} ${service}`, `${t.due} ${extra.due_date}`, ...(installation ? [`Metakocka: ${installation}`] : [])].join(" · "),
  ].join("\n");
}
