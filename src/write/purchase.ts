/**
 * Builds a received (purchase) invoice draft from the supplier's invoice:
 * its number, dates, lines and total are copied from the document the user
 * has, so the server checks them against each other instead of taking
 * prices from Metakocka's catalogue. Lines are products marked for
 * purchasing; the VAT rate on each line is mapped to Metakocka's tax code.
 * Metakocka's API takes no negative lines: those are left out, named in a
 * note on the invoice and in the summary, for the user to add in Metakocka.
 * Metakocka doesn't refuse a supplier's invoice number twice, so the server
 * does. Saving it also makes the stock receipt (prevzemnica), as in
 * Metakocka's own form. Nothing is written here.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { searchAllDocuments, type MkRecord } from "../api.js";
import { addDays, daysBetween, fromMkDate, isIsoDate, toMkDate } from "../dates.js";
import { asArray, num, round2, str } from "../util.js";
import { loadCatalog, type CatalogProduct } from "./catalog.js";
import {
  CHANGE_LOG_PREFIX,
  DraftError,
  linesAndTotals,
  money,
  oneLine,
  priceLine,
  resolveAddress,
  resolvePartner,
  totalsOf,
  type BuildContext,
} from "./document.js";
import type { Draft, DraftLine } from "./drafts.js";

export type PurchaseType = "purchase_bill_domestic" | "purchase_bill_foreign";

export interface PurchaseLineInput {
  product_id?: string;
  code?: string;
  quantity?: number;
  /** Net unit price as on the supplier's invoice; negative for a credit line, which is left out. */
  price?: number;
  discount_percent?: number;
  /** VAT rate on the supplier's invoice, e.g. 22, 9.5 or 0. */
  vat_percent?: number;
  /** The line's text on the supplier's invoice (e.g. a period or domain name). */
  description?: string;
}

export interface PurchaseInput {
  doc_type: PurchaseType;
  partner_id?: string;
  address_id?: string;
  supplier_invoice_number?: string;
  invoice_date?: string;
  received_date?: string;
  due_date?: string;
  due_days?: number;
  service_from?: string;
  service_to?: string;
  lines?: PurchaseLineInput[];
  /** Total with VAT as on the supplier's invoice, including any credit lines. */
  invoice_total?: number;
  note?: string;
  /** Local path of the supplier's invoice (PDF or image), attached once saved. */
  attachment_path?: string;
  language?: "sl" | "en";
}

export interface PurchaseInfo {
  supplier_invoice_number: string;
  invoice_date: string;
  received_date: string;
  due_date: string;
  due_from: string;
  left_out?: { description: string; net: number; total: number }[];
  attachment?: string;
}

const HISTORY_MAX = 500;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_TYPES = new Set([".pdf", ".png", ".jpg", ".jpeg", ".xml"]);

export async function buildPurchaseDraft(
  ctx: BuildContext & { localFiles: boolean },
  input: PurchaseInput,
): Promise<{ draft: Draft; warnings: string[]; info: PurchaseInfo }> {
  const warnings: string[] = [];
  const foreignInvoice = input.doc_type === "purchase_bill_foreign";
  const number = input.supplier_invoice_number?.trim();
  if (!number) throw new DraftError("Give supplier_invoice_number: the invoice number as printed on the supplier's invoice.");
  if (!input.invoice_date) throw new DraftError("Give invoice_date: the date on the supplier's invoice (YYYY-MM-DD).");
  if (input.invoice_total === undefined) throw new DraftError("Give invoice_total: the total with VAT as printed on the supplier's invoice.");
  for (const [name, value] of [
    ["invoice_date", input.invoice_date],
    ["received_date", input.received_date],
    ["due_date", input.due_date],
    ["service_from", input.service_from],
    ["service_to", input.service_to],
  ] as const) {
    if (value !== undefined && !isIsoDate(value)) throw new DraftError(`${name} must be a date as YYYY-MM-DD.`);
  }
  const invoiceDate = input.invoice_date;
  if (invoiceDate > ctx.today) throw new DraftError("invoice_date is in the future.");
  const receivedDate = input.received_date ?? invoiceDate;
  if (input.service_from && input.service_to && input.service_from > input.service_to) throw new DraftError("service_from is after service_to.");

  if (!input.partner_id) throw new DraftError("Give partner_id: the supplier's id from search_partners.");
  const partner = await resolvePartner(ctx.client, input.partner_id, { foreign: "allow", what: "Purchase invoices", discounts: "ignore" });
  if (partner.foreign !== foreignInvoice) {
    throw new DraftError(
      partner.foreign
        ? `${partner.name} is a foreign partner: use doc_type purchase_bill_foreign.`
        : `${partner.name} is a domestic partner: use doc_type purchase_bill_domestic.`,
    );
  }
  const address = resolveAddress(partner, input.address_id);

  // The supplier's earlier invoices of this type, newest first.
  const history = (
    await searchAllDocuments(ctx.client, { docType: input.doc_type, filters: [{ type: "partner_mk_id", value: partner.id }] }, HISTORY_MAX)
  ).documents
    .filter((d) => str((d.partner as MkRecord | undefined)?.mk_id) === partner.id)
    .sort((a, b) => (fromMkDate(b.doc_date) ?? "").localeCompare(fromMkDate(a.doc_date) ?? "") || (str(b.mk_id) ?? "").localeCompare(str(a.mk_id) ?? ""));

  // Metakocka saves the same supplier's number twice without a word.
  const norm = (s: string | undefined) => s?.trim().toLowerCase().replace(/\s+/g, "");
  const entered =
    history.some((d) => norm(str(d.count_code)) === norm(number)) ||
    ctx.drafts.committed().some((d) => d.partner.id === partner.id && norm(str(d.payload.count_code)) === norm(number));
  if (entered) throw new DraftError(`Invoice ${number} from ${partner.name} is already in Metakocka. Nothing to do; don't enter it again.`);

  // Lines: products for purchasing, priced as on the invoice; negative lines are left out.
  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  if (!input.lines?.length) throw new DraftError("A purchase invoice needs at least one line.");
  const lines: DraftLine[] = [];
  const descriptions: (string | undefined)[] = [];
  const leftOut: { description: string; net: number; total: number }[] = [];
  for (const [i, line] of input.lines.entries()) {
    const n = i + 1;
    const product = purchaseProduct(catalog, line, n);
    if (line.vat_percent === undefined) throw new DraftError(`Line ${n}: give vat_percent as on the supplier's invoice (e.g. 22, 9.5 or 0).`);
    const quantity = line.quantity;
    if (quantity === undefined || !(quantity > 0)) throw new DraftError(`Line ${n}: quantity must be more than 0; give a credit as a negative price.`);
    if (line.price === undefined) throw new DraftError(`Line ${n}: give the net unit price as on the supplier's invoice.`);
    const taxCode = taxCodeFor(catalog, history, product, line.vat_percent, n);
    const priced = priceLine({ product, quantity, price: line.price, discountPercent: line.discount_percent ?? 0, taxCode, taxRatePercent: line.vat_percent });
    if (line.price < 0) {
      const text = line.description?.trim();
      leftOut.push({ description: text ? `${text} (${product.name})` : product.name, net: priced.net, total: priced.gross });
    } else {
      lines.push(priced);
      descriptions.push(line.description?.trim() || undefined);
    }
  }
  if (!lines.length) throw new DraftError("Every line is negative; enter this invoice in Metakocka.");
  const totals = totalsOf(lines);

  // The total on the supplier's invoice must come out of the lines to the cent.
  const computed = round2(totals.gross + leftOut.reduce((s, l) => s + l.total, 0));
  if (Math.abs(computed - input.invoice_total) > 0.005) {
    throw new DraftError(
      `The lines add up to ${computed.toFixed(2)} with VAT, but invoice_total is ${input.invoice_total.toFixed(2)}. ` +
        "Check quantities, prices, discounts and VAT rates against the supplier's invoice; nothing was drafted.",
    );
  }

  // Payment term: given, the partner's in Metakocka, or the one its last invoice had.
  let dueDate: string;
  let dueFrom: string;
  const addressDays = num(address.record.payment_due_days);
  const last = history.find((d) => fromMkDate(d.doc_date) && fromMkDate(d.duo_payment));
  if (input.due_date) {
    if (input.due_date < invoiceDate) throw new DraftError("due_date is before invoice_date.");
    [dueDate, dueFrom] = [input.due_date, "given"];
  } else if (input.due_days !== undefined) {
    [dueDate, dueFrom] = [addDays(invoiceDate, input.due_days), "given"];
  } else if (addressDays !== undefined && addressDays >= 0) {
    [dueDate, dueFrom] = [addDays(invoiceDate, addressDays), "partner's payment term in Metakocka"];
  } else if (last) {
    const days = Math.max(daysBetween(fromMkDate(last.doc_date)!, fromMkDate(last.duo_payment)!), 0);
    [dueDate, dueFrom] = [addDays(invoiceDate, days), `${days === 1 ? "1 day" : `${days} days`}, as on the supplier's last invoice ${str(last.count_code)}`];
  } else {
    throw new DraftError("Give due_date as on the supplier's invoice: this supplier has no payment term in Metakocka and no earlier invoice.");
  }

  const attachment = input.attachment_path ? await readAttachment(input.attachment_path, ctx.localFiles) : undefined;

  const sl = (input.language ?? "sl") === "sl";
  const leftOutNote = leftOut.length
    ? (sl ? "Ročno dodaj vrstice, ki jih API ne sprejme: " : "Add by hand the lines the API doesn't take: ") +
      leftOut.map((l) => `${oneLine(l.description)} ${money(l.total, sl ? "sl" : "en")}`).join("; ")
    : undefined;
  const note = [input.note?.trim(), leftOutNote].filter(Boolean).join("\n") || undefined;
  if (leftOut.length) warnings.push(`${leftOut.length} negative line(s) are left out: add them in Metakocka after saving. ${leftOutNote}`);

  const payload: MkRecord = {
    doc_type: input.doc_type,
    count_code: number,
    doc_date: toMkDate(invoiceDate),
    receive_date: toMkDate(receivedDate),
    duo_payment: toMkDate(dueDate),
    ...(input.service_from ? { service_from_date: toMkDate(input.service_from) } : {}),
    ...(input.service_to ? { service_to_date: toMkDate(input.service_to) } : {}),
    partner: { mk_id: partner.id, mk_address_id: address.id },
    currency_code: "EUR",
    ...(note ? { notes: note } : {}),
    product_list: lines.map((l, i) => ({
      mk_id: l.productId,
      ...(l.code ? { code: l.code } : {}),
      ...(l.countCode ? { count_code: l.countCode } : {}),
      amount: String(l.quantity),
      price: String(l.price),
      discount: String(l.discountPercent),
      tax: l.taxCode,
      ...(descriptions[i] ? { doc_desc: descriptions[i] } : {}),
    })),
  };

  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const draft = ctx.drafts.add({
    docType: input.doc_type,
    language: sl ? "sl" : "en",
    partner: partnerRef,
    docDate: invoiceDate,
    lines,
    totals,
    payload,
    summary: "",
    ...(attachment ? { attachment } : {}),
  });
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  const info: PurchaseInfo = {
    supplier_invoice_number: number,
    invoice_date: invoiceDate,
    received_date: receivedDate,
    due_date: dueDate,
    due_from: dueFrom,
    ...(leftOut.length ? { left_out: leftOut } : {}),
    ...(attachment ? { attachment: attachment.fileName } : {}),
  };
  draft.summary = summarize(draft, { ...info, descriptions, note: input.note?.trim(), leftOut, service_from: input.service_from, service_to: input.service_to }, ctx.installation);
  return { draft, warnings, info };
}

function purchaseProduct(catalog: Map<string, CatalogProduct>, line: PurchaseLineInput, n: number): CatalogProduct {
  let product: CatalogProduct | undefined;
  if (line.product_id) product = catalog.get(line.product_id);
  else if (line.code) {
    const matches = [...catalog.values()].filter((p) => p.code === line.code);
    if (matches.length > 1) throw new DraftError(`Line ${n}: several products have the code ${line.code}; use product_id.`);
    product = matches[0];
  } else {
    throw new DraftError(
      `Line ${n}: give product_id (or code) of the product this cost is booked to. Metakocka's API takes only products; ` +
        "look at the supplier's earlier invoices (search_documents) for the product it is usually booked to.",
    );
  }
  if (!product) {
    throw new DraftError(`Line ${n}: no product ${line.product_id ?? line.code}. This tool never creates products — add it in Metakocka first.`);
  }
  if (!product.active) throw new DraftError(`Line ${n}: ${product.name} is not active in Metakocka.`);
  if (!product.purchasing) throw new DraftError(`Line ${n}: ${product.name} is not marked for purchasing in Metakocka.`);
  return product;
}

/**
 * The tax code for a VAT rate: the one this supplier's last invoice used for this product when the
 * catalogue gives it that rate, else the only code with that rate in the catalogue.
 */
function taxCodeFor(catalog: Map<string, CatalogProduct>, history: MkRecord[], product: CatalogProduct, rate: number, n: number): string {
  const codes = new Set<string>();
  for (const p of catalog.values()) if (p.taxCode && p.taxRatePercent === rate) codes.add(p.taxCode);
  for (const d of history) {
    const used = asArray<MkRecord>(d.product_list).find((l) => str(l.mk_id) === product.id && codes.has(str(l.tax) ?? ""));
    if (used) return str(used.tax)!;
  }
  if (codes.size === 1) return [...codes][0]!;
  throw new DraftError(
    codes.size
      ? `Line ${n}: several tax codes have ${rate} % VAT (${[...codes].join(", ")}), and this supplier's earlier invoices don't show which one. Enter it in Metakocka.`
      : `Line ${n}: no tax code with ${rate} % VAT is used in the catalogue's price lists. Enter it in Metakocka.`,
  );
}

async function readAttachment(path: string, localFiles: boolean): Promise<NonNullable<Draft["attachment"]>> {
  if (!localFiles) throw new DraftError("Attaching files is only possible when the server runs on the user's computer (not in HTTP mode).");
  if (!isAbsolute(path)) throw new DraftError("attachment_path must be an absolute path to the file.");
  const ext = extname(path).toLowerCase();
  if (!ATTACHMENT_TYPES.has(ext)) throw new DraftError(`attachment_path: only ${[...ATTACHMENT_TYPES].join(", ")} files can be attached.`);
  let size: number;
  try {
    const s = await stat(path);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    throw new DraftError(`attachment_path: can't read ${path}.`);
  }
  if (size > ATTACHMENT_MAX_BYTES) throw new DraftError(`attachment_path: the file is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`);
  const data = await readFile(path);
  return { fileName: basename(path), dataB64: data.toString("base64"), bytes: data.length };
}

function summarize(
  d: Draft,
  extra: PurchaseInfo & {
    descriptions: (string | undefined)[];
    note?: string;
    leftOut: { description: string; total: number }[];
    service_from?: string;
    service_to?: string;
  },
  installation: string | undefined,
): string {
  const foreign = d.docType === "purchase_bill_foreign";
  const sl = d.language === "sl";
  const t = sl
    ? {
        head: foreign ? "Vnesi TUJI PREJETI RAČUN" : "Vnesi PREJETI RAČUN",
        from: "od",
        note: "Opomba",
        date: "Datum računa",
        received: "prejeto",
        service: "storitev",
        due: "rok plačila",
        leftOut: "⚠ NI VNESENO — dodaj ročno v Metakocki (navedeno tudi v opombi računa)",
        file: "Priloga",
      }
    : {
        head: foreign ? "Enter a FOREIGN RECEIVED INVOICE" : "Enter a RECEIVED INVOICE",
        from: "from",
        note: "Note",
        date: "Invoice date",
        received: "received",
        service: "service",
        due: "due",
        leftOut: "⚠ LEFT OUT — add by hand in Metakocka (also in the invoice note)",
        file: "Attachment",
      };
  // Lines with the supplier's description.
  const withDesc = { ...d, lines: d.lines.map((l, i) => ({ ...l, name: extra.descriptions[i] ? `${l.name} (${oneLine(extra.descriptions[i]!)})` : l.name })) };
  const service = extra.service_from && extra.service_to && extra.service_from !== extra.service_to ? `${extra.service_from} – ${extra.service_to}` : (extra.service_to ?? extra.service_from);
  return [
    `${t.head} ${extra.supplier_invoice_number} ${t.from} ${d.partner.name}${d.partner.taxId ? ` (${d.partner.taxId})` : ""}`,
    d.partner.address,
    ...(extra.note ? [`${t.note}: ${oneLine(extra.note)}`] : []),
    "",
    ...linesAndTotals(withDesc),
    ...(extra.leftOut.length
      ? ["", `${t.leftOut}:`, ...extra.leftOut.map((l) => `  − ${oneLine(l.description)} ${money(l.total, d.language)}`)]
      : []),
    "",
    [
      `${t.date} ${extra.invoice_date}`,
      `${t.received} ${extra.received_date}`,
      ...(service ? [`${t.service} ${service}`] : []),
      `${t.due} ${extra.due_date}`,
      ...(installation ? [`Metakocka: ${installation}`] : []),
    ].join(" · "),
    ...(extra.attachment ? [`${t.file}: ${extra.attachment}`] : []),
  ].join("\n");
}
