/**
 * Changes to an existing offer (ponudba): its lines, title, note and validity.
 * Metakocka's update_document can't change an offer; put_document with the
 * offer's mk_id saves the whole offer again: every line is deleted and added
 * from the request, and header fields left out are cleared
 * (docs/documents_concept.md, "1.4 update_document specific"; confirmed on a
 * live offer on 2026-10-28). So the draft sends every field the offer has,
 * and the full new list of lines; a line kept from the offer (keep_line)
 * keeps its product, price, discount, tax and text unless the input changes
 * them. The offer is read again right before saving and the change is
 * refused when it changed since the draft.
 */
import { findDocumentIdByNumber, getDocument, searchDocuments, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { fromMkDate } from "../dates.js";
import { asArray, num, round2, str } from "../util.js";
import { loadCatalog, type CatalogProduct } from "./catalog.js";
import type { ChangeCheck } from "./change.js";
import { verifyStored } from "./commit.js";
import {
  CHANGE_LOG_PREFIX,
  DESCRIPTION_MAX,
  DraftError,
  FREE_TEXT_NAME_MAX,
  headerLine,
  money,
  oneLine,
  priceLine,
  productListPayload,
  salesLines,
  taxCodeForRate,
  totalsOf,
  withHeaders,
  type BuildContext,
  type LineInput,
} from "./document.js";
import type { Draft, DraftLine, DraftTotals } from "./drafts.js";

export interface OfferLineInput extends LineInput {
  /** Keep this line of the offer (1 = its first line, section headers counted), changed only by the other fields given. */
  keep_line?: number;
}

export interface OfferEditInput {
  number?: string;
  id?: string;
  /** The offer's full new list of lines; without it the lines stay as they are. */
  lines?: OfferLineInput[];
  /** "" clears it. */
  title?: string;
  /** "" clears it. */
  note?: string;
  valid_days?: number;
  language?: "sl" | "en";
}

/**
 * Header fields put_document takes on an offer (docs/documents_put_document_offer.md, plus the sales order
 * fields Metakocka also keeps on offers): sent back as the offer has them, so the rewrite keeps them.
 */
const KEPT_FIELDS = [
  "doc_date",
  "currency_code",
  "valid_days",
  "title",
  "notes",
  "status_code",
  "sales_pricelist_code",
  "purchase_pricelist_code",
  "prepayment_value",
  "discount_value",
  "duo_payment",
  "pariteta",
  "method_of_payment",
  "inquiry_num",
  "delivery_type",
  "buyer_order",
  "warehouse",
  "doc_created_email",
] as const;

/** What get_document returns that Metakocka works out itself, or that the draft sends its own way. */
const DERIVED_FIELDS = new Set([
  "mk_id",
  "doc_type",
  "opr_code",
  "opr_desc",
  "opr_time_ms",
  "opr_time_no_lock_ms",
  "count_code",
  "valid_to",
  "status_desc",
  "publish_ts",
  "last_change_user",
  "fulfillment_user",
  "partner",
  "receiver",
  "product_list",
]);

/** A line of the offer as it is now. */
interface OldLine {
  /** 1-based, section headers counted. */
  n: number;
  kind: "product" | "free" | "header";
  record: MkRecord;
  text: string;
  quantity: number;
  price: number;
  discountPercent: number;
  taxCode: string;
  net: number;
}

export async function buildOfferEditDraft(ctx: BuildContext, input: OfferEditInput): Promise<{ draft: Draft; warnings: string[] }> {
  if (!input.number && !input.id) throw new DraftError("Give the offer's number (as in Metakocka) or id.");
  if (input.lines === undefined && input.title === undefined && input.note === undefined && input.valid_days === undefined) {
    throw new DraftError("Nothing to change. An offer takes: lines (the full new list), title, note, valid_days.");
  }
  const id = input.id ?? (await findOfferId(ctx.client, input.number!));
  const doc = await getDocument(ctx.client, "sales_offer", id);
  const number = str(doc.count_code) ?? input.number ?? id;
  const sl = (input.language ?? "sl") === "sl";
  const warnings: string[] = [];

  const unknown = Object.keys(doc).filter((k) => !DERIVED_FIELDS.has(k) && !k.startsWith("sum_") && !(KEPT_FIELDS as readonly string[]).includes(k));
  if (unknown.length) {
    throw new DraftError(
      `Offer ${number} has ${unknown.join(", ")}, which Metakocka's API can't save back: rewriting the offer would lose it. Change this offer in Metakocka.`,
    );
  }
  const partner = (doc.partner ?? {}) as MkRecord;
  const partnerId = str(partner.mk_id);
  const addressId = str(partner.mk_address_id);
  if (!partnerId || !addressId) throw new DraftError(`Offer ${number} has no partner with an address id; change it in Metakocka.`);

  const currency = str(doc.currency_code) ?? "EUR";
  const oldLines = asArray<MkRecord>(doc.product_list).map(readLine);
  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  const lines = input.lines ? newLines(catalog, oldLines, input.lines, currency) : oldLines.map((o) => keptLine(catalog, o, { keep_line: o.n }, o.n));
  const totals = totalsOf(lines, currency);

  // The header: everything the offer has, with the changes.
  const header: MkRecord = {};
  for (const k of KEPT_FIELDS) if (str(doc[k]) !== undefined) header[k] = doc[k];
  const fields: { label: string; from?: string; to: string }[] = [];
  const set = (apiName: string, label: string, value: string | undefined) => {
    if (value === undefined) return;
    const before = str(doc[apiName]) ?? "";
    if (before === value) {
      warnings.push(`${label} is already ${value === "" ? "empty" : `"${oneLine(value)}"`}; left as it is.`);
      return;
    }
    if (value === "") delete header[apiName];
    else header[apiName] = value;
    fields.push({ label, from: before, to: value });
  };
  if (input.title !== undefined && input.title.trim().length > 100) throw new DraftError("The title is longer than 100 characters.");
  set("title", sl ? "Naziv" : "Title", input.title?.trim());
  set("notes", sl ? "Opomba" : "Note", input.note?.trim());
  if (input.valid_days !== undefined && (!Number.isInteger(input.valid_days) || input.valid_days < 1 || input.valid_days > 365)) {
    throw new DraftError("valid_days must be a whole number of days from 1 to 365.");
  }
  set("valid_days", sl ? "Velja dni" : "Valid days", input.valid_days === undefined ? undefined : String(input.valid_days));

  const diff = lineDiff(oldLines, lines, input.lines, sl ? "sl" : "en", currency);
  if (!fields.length && !diff.changed) throw new DraftError(`Offer ${number} already has all of that; nothing to change.`);

  const payload: MkRecord = {
    doc_type: "sales_offer",
    mk_id: id,
    ...header,
    partner: { mk_id: partnerId, mk_address_id: addressId },
    ...(doc.receiver ? { receiver: doc.receiver } : {}),
    product_list: productListPayload(lines),
  };

  warnings.push(...(await offerWarnings(ctx.client, doc, number, partnerId)));
  if (num(doc.discount_value) || num(doc.prepayment_value)) {
    warnings.push(`Offer ${number} has a discount or prepayment on the whole offer; it stays, and Metakocka works out the totals with it.`);
  }

  const fingerprint = fingerprintOf(doc);
  const draft = ctx.drafts.add({
    docType: "offer_update",
    language: sl ? "sl" : "en",
    partner: { id: partnerId, name: str(partner.customer), taxId: str(partner.tax_id_number), addressId },
    docDate: fromMkDate(doc.doc_date) ?? ctx.today,
    lines,
    totals,
    payload,
    summary: "",
    target: { docType: "sales_offer", mkId: id, number },
    change: {
      endpoint: "put_document",
      precheck: async (client) =>
        fingerprintOf(await getDocument(client, "sales_offer", id)) === fingerprint
          ? undefined
          : `Offer ${number} changed in Metakocka since this draft was made; nothing was saved. Draft the change again from the offer as it is now.`,
      interpret: (response) => {
        const saved = str(response.mk_id);
        return saved && saved !== id
          ? { warnings: [`CHECK IN METAKOCKA: Metakocka saved a new offer ${str(response.count_code) ?? saved} instead of changing ${number}.`], mkId: saved }
          : {};
      },
      check: (client) => checkOfferEdit(client, draft, id, fingerprint),
      rejectedHint: "The offer is as it was.",
    },
  });
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  draft.summary = summarize({ number, partner: str(partner.customer), fields, diff, oldTotals: oldTotalsOf(doc, oldLines, currency), totals, sl, installation: ctx.installation });
  return { draft, warnings };
}

async function findOfferId(client: MetakockaClient, number: string): Promise<string> {
  const id = await findDocumentIdByNumber(client, "sales_offer", number);
  if (!id) throw new DraftError(`No offer with number ${number} in Metakocka. Find it with search_documents.`);
  return id;
}

/** A line as get_document returns it: a product (mk_id), a free-text line (name, no product) or a section header (neither). */
export function readLine(r: MkRecord, i: number): OldLine {
  const kind = str(r.mk_id) ? "product" : str(r.name) ? "free" : "header";
  const quantity = num(r.amount) ?? 0;
  const price = num(r.price) ?? 0;
  const discountPercent = num(r.discount) ?? 0;
  return {
    n: i + 1,
    kind,
    record: r,
    text: kind === "header" ? str(r.doc_desc) ?? str(r.name_desc) ?? "" : str(r.name) ?? str(r.code) ?? "",
    quantity,
    price,
    discountPercent,
    taxCode: str(r.tax) ?? "",
    net: kind === "header" ? 0 : round2(quantity * price * (1 - discountPercent / 100)),
  };
}

/** The new list: lines kept from the offer (keep_line) and new ones in draft_document's format. */
function newLines(catalog: Map<string, CatalogProduct>, old: OldLine[], input: OfferLineInput[], currency: string): DraftLine[] {
  if (!input.length) throw new DraftError("lines is empty; an offer needs at least one product or free-text line.");
  const seen = new Set<number>();
  const fresh: (DraftLine | undefined)[] = salesLines(
    catalog,
    input.map((l) => (l.keep_line === undefined ? l : { title: "kept" })),
    { currency },
  );
  const lines = input.map((l, i) => {
    if (l.keep_line === undefined) return fresh[i];
    if (seen.has(l.keep_line)) throw new DraftError(`Line ${i + 1}: line ${l.keep_line} of the offer is kept twice.`);
    seen.add(l.keep_line);
    const o = old[l.keep_line - 1];
    if (!o) throw new DraftError(`Line ${i + 1}: the offer has no line ${l.keep_line}; it has ${old.length}.`);
    return keptLine(catalog, o, l, i + 1);
  });
  const all = withHeaders(lines, input, "An offer");
  // A kept section header is a line here too, which withHeaders can't tell apart.
  if (all.every((l) => l.header !== undefined)) throw new DraftError("An offer needs at least one product or free-text line; section headers alone are not enough.");
  return all;
}

/** A line of the offer, kept with the changes the input gives. */
export function keptLine(catalog: Map<string, CatalogProduct>, o: OldLine, l: OfferLineInput, n: number): DraftLine {
  if (l.product_id !== undefined || l.code !== undefined) {
    throw new DraftError(`Line ${n}: keep_line keeps the offer's product; for another product give a new line without keep_line.`);
  }
  if (o.kind === "header") {
    const extra = (["quantity", "price", "discount_percent", "vat_percent", "description", "unit", "name"] as const).filter((k) => l[k] !== undefined);
    if (extra.length) throw new DraftError(`Line ${n}: line ${o.n} of the offer is a section header; it takes only title, not ${extra.join(", ")}.`);
    const title = (l.title ?? o.text).trim();
    if (!title) throw new DraftError(`Line ${n}: the title is empty.`);
    if (title.length > DESCRIPTION_MAX) throw new DraftError(`Line ${n}: the title is longer than ${DESCRIPTION_MAX} characters.`);
    return headerLine(title);
  }
  if (l.title !== undefined) throw new DraftError(`Line ${n}: line ${o.n} of the offer isn't a section header; title is only for headers.`);
  if (o.kind === "product" && (l.name !== undefined || l.unit !== undefined)) {
    throw new DraftError(`Line ${n}: line ${o.n} of the offer is a product; name and unit are only for free-text lines.`);
  }
  const quantity = l.quantity ?? o.quantity;
  if (!(quantity > 0)) throw new DraftError(`Line ${n}: quantity must be more than 0.`);
  const price = l.price ?? o.price;
  if (price < 0) throw new DraftError(`Line ${n}: the price can't be negative.`);
  const taxCode = l.vat_percent !== undefined ? taxCodeForRate(catalog, l.vat_percent, n) : o.taxCode;
  const taxRatePercent = l.vat_percent ?? rateOfTaxCode(catalog, o.taxCode, n);
  const description = l.description === undefined ? str(o.record.doc_desc) : l.description.trim() || undefined;
  if (description && description.length > DESCRIPTION_MAX) throw new DraftError(`Line ${n}: the description is longer than ${DESCRIPTION_MAX} characters.`);
  const common = { quantity, price, discountPercent: l.discount_percent ?? o.discountPercent, taxCode, taxRatePercent };

  if (o.kind === "free") {
    const name = (l.name ?? o.text).trim();
    if (!name) throw new DraftError(`Line ${n}: the name is empty.`);
    if (name.length > FREE_TEXT_NAME_MAX) throw new DraftError(`Line ${n}: the name is longer than ${FREE_TEXT_NAME_MAX} characters.`);
    // get_document doesn't return a free-text line's unit, and put_document refuses the line without one.
    const unit = l.unit?.trim();
    if (!unit) throw new DraftError(`Line ${n}: line ${o.n} of the offer is a free-text line ("${name}"); give its unit (e.g. kos, ura) — Metakocka's API doesn't return it.`);
    return { ...priceLine({ product: { id: "", name, unit }, ...common }), freeText: true, ...(description ? { description } : {}) };
  }
  const product = catalog.get(str(o.record.mk_id)!);
  if (!product) throw new DraftError(`Line ${n}: the product on line ${o.n} of the offer (${str(o.record.code) ?? str(o.record.mk_id)}) isn't in the catalogue any more; give another product.`);
  return { ...priceLine({ product, ...common }), ...(description ? { description } : {}) };
}

/** The VAT rate of a tax code, from the catalogue's price lists. */
function rateOfTaxCode(catalog: Map<string, CatalogProduct>, code: string, n: number): number {
  const rates = new Set<number>();
  for (const p of catalog.values()) if (p.taxCode === code && p.taxRatePercent !== undefined) rates.add(p.taxRatePercent);
  if (rates.size === 1) return [...rates][0]!;
  throw new DraftError(`Line ${n}: the VAT rate of tax code ${code} is unknown (no price list uses it); give vat_percent.`);
}

export interface LineDiff {
  changed: boolean;
  added: { at: number; line: DraftLine }[];
  removed: OldLine[];
  modified: { at: number; old: OldLine; changes: string[] }[];
  moved: boolean;
  unchanged: number;
}

/** What the new list does to the offer's lines. A line without keep_line is new; an old line no new line keeps is removed. */
export function lineDiff(old: OldLine[], lines: DraftLine[], input: OfferLineInput[] | undefined, language: "sl" | "en" = "sl", currency = "EUR"): LineDiff {
  const kept = input ? input.map((l) => l.keep_line) : old.map((o) => o.n);
  const diff: LineDiff = { changed: false, added: [], removed: [], modified: [], moved: false, unchanged: 0 };
  lines.forEach((line, i) => {
    const k = kept[i];
    if (k === undefined) {
      diff.added.push({ at: i + 1, line });
      return;
    }
    const changes = lineChanges(old[k - 1]!, line, language, currency);
    if (changes.length) diff.modified.push({ at: i + 1, old: old[k - 1]!, changes });
    else diff.unchanged++;
  });
  const keptSet = new Set(kept.filter((k): k is number => k !== undefined));
  diff.removed = old.filter((o) => !keptSet.has(o.n));
  const order = kept.filter((k): k is number => k !== undefined);
  diff.moved = order.some((k, i) => i > 0 && k < order[i - 1]!);
  diff.changed = !!(diff.added.length || diff.removed.length || diff.modified.length || diff.moved);
  return diff;
}

function lineChanges(o: OldLine, l: DraftLine, language: "sl" | "en", currency: string): string[] {
  const sl = language === "sl";
  const m = (n: number) => money(n, language, currency);
  const q = (s: string | undefined) => (s ? `"${oneLine(s)}"` : sl ? "(prazno)" : "(empty)");
  const out: string[] = [];
  if (l.header !== undefined) {
    if (l.header !== o.text) out.push(`${sl ? "naslov" : "heading"} ${q(o.text)} → ${q(l.header)}`);
    return out;
  }
  if (l.freeText && l.name !== o.text) out.push(`${sl ? "naziv" : "name"} ${q(o.text)} → ${q(l.name)}`);
  const oldDesc = str(o.record.doc_desc);
  if ((oldDesc ?? "") !== (l.description ?? "")) out.push(`${sl ? "opis" : "description"} ${q(oldDesc)} → ${q(l.description)}`);
  if (o.quantity !== l.quantity) out.push(`${sl ? "količina" : "quantity"} ${o.quantity} → ${l.quantity}`);
  if (Math.abs(o.price - l.price) > 1e-9) out.push(`${sl ? "cena" : "price"} ${m(o.price)} → ${m(l.price)}`);
  if (o.discountPercent !== l.discountPercent) out.push(`${sl ? "popust" : "discount"} ${o.discountPercent} % → ${l.discountPercent} %`);
  if (o.taxCode !== l.taxCode) out.push(`${sl ? "DDV" : "VAT"} ${o.taxCode} → ${l.taxCode} (${l.taxRatePercent} %)`);
  return out;
}

/** The offer's totals now: Metakocka's sum_all, and the net of its lines. */
function oldTotalsOf(doc: MkRecord, old: OldLine[], currency: string): DraftTotals {
  const net = round2(old.reduce((s, o) => s + o.net, 0));
  const gross = num(doc.sum_all) ?? net;
  return { net, tax: round2(gross - net), gross, currency };
}

/** Before the change: the offer's status, payments, and documents made from it. */
async function offerWarnings(client: MetakockaClient, doc: MkRecord, number: string, partnerId: string): Promise<string[]> {
  const warnings = [
    "Metakocka's API can't tell whether this offer was already sent to the customer; if it was, they have the old version.",
  ];
  const status = str(doc.status_code);
  if (status) warnings.push(`Offer ${number} has the status "${status}".`);
  if (num(doc.sum_paid) || num(doc.sum_prepayment)) warnings.push(`Offer ${number} already has payments; they stay on it.`);
  const from = fromMkDate(doc.doc_date);
  const linked: string[] = [];
  for (const docType of ["sales_bill_domestic", "sales_bill_foreign", "sales_bill_prepaid", "sales_order"] as const) {
    try {
      const { documents } = await searchDocuments(client, { docType, dateFrom: from, filters: [{ type: "partner_mk_id", value: partnerId }], limit: 100 });
      for (const d of documents) {
        if (asArray<MkRecord>(d.offer_list).some((o) => str(o.count_code) === number)) linked.push(`${str(d.count_code) ?? str(d.mk_id)} (${docType})`);
      }
    } catch {
      // A search that fails only loses this warning.
    }
  }
  if (linked.length) {
    warnings.push(`Documents were made from offer ${number}: ${linked.join(", ")}. Changing the offer doesn't change them.`);
  }
  return warnings;
}

/** The offer as Metakocka holds it, for telling whether it changed; key order and timing fields don't count. */
export function fingerprintOf(doc: MkRecord): string {
  const strip = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(strip)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as MkRecord)
              .filter((k) => !k.startsWith("opr_"))
              .sort()
              .map((k) => [k, strip((v as MkRecord)[k])]),
          )
        : v;
  return JSON.stringify(strip(doc));
}

/** Read the offer back: changed from what it was, and holding what was confirmed. */
async function checkOfferEdit(client: MetakockaClient, draft: Draft, id: string, before: string): Promise<ChangeCheck> {
  const doc = await getDocument(client, "sales_offer", id);
  if (fingerprintOf(doc) === before) return { done: false };
  const warnings = verifyStored(draft, doc);
  for (const k of ["title", "notes", "valid_days"] as const) {
    if ((str(doc[k]) ?? "") !== (str(draft.payload[k]) ?? "")) warnings.push(`CHECK IN METAKOCKA: ${k} is "${str(doc[k]) ?? ""}", not "${str(draft.payload[k]) ?? ""}".`);
  }
  return { done: true, warnings };
}

function summarize(s: {
  number: string;
  partner?: string;
  fields: { label: string; from?: string; to: string }[];
  diff: LineDiff;
  oldTotals: DraftTotals;
  totals: DraftTotals;
  sl: boolean;
  installation?: string;
}): string {
  const { sl, diff } = s;
  const language = sl ? "sl" : "en";
  const m = (n: number) => money(n, language, s.totals.currency);
  const show = (v: string | undefined) => (v ? oneLine(v) : sl ? "(prazno)" : "(empty)");
  const describe = (l: DraftLine) =>
    l.header !== undefined
      ? `▸ ${oneLine(l.header)}`
      : `${l.quantity}${l.freeText ? ` ${l.unit}` : ""} × ${l.name}${l.description ? ` (${oneLine(l.description)})` : ""} à ${m(l.price)}${l.discountPercent ? ` −${l.discountPercent} %` : ""} = ${m(l.net)}`;
  const describeOld = (o: OldLine) =>
    o.kind === "header"
      ? `▸ ${oneLine(o.text)}`
      : `${o.quantity} × ${o.text}${str(o.record.doc_desc) ? ` (${oneLine(str(o.record.doc_desc)!)})` : ""} à ${m(o.price)}${o.discountPercent ? ` −${o.discountPercent} %` : ""} = ${m(o.net)}`;
  const t = sl
    ? { head: "Spremeni PONUDBO", lines: "Postavke", added: "dodana", removed: "odstranjena", changed: "spremenjena", at: "vrstica", was: "prej vrstica", moved: "Vrstni red postavk se spremeni.", same: "Nespremenjenih postavk", net: "Osnova", tax: "DDV", gross: "Skupaj z DDV" }
    : { head: "Change OFFER", lines: "Lines", added: "added", removed: "removed", changed: "changed", at: "line", was: "was line", moved: "The order of the lines changes.", same: "Lines unchanged", net: "Net", tax: "VAT", gross: "Total incl. VAT" };
  const lineRows = [
    ...diff.removed.map((o) => `  − ${t.removed} (${t.was} ${o.n}): ${describeOld(o)}`),
    ...diff.modified.map((c) => `  ~ ${t.changed} (${t.at} ${c.at}, ${t.was} ${c.old.n}, ${c.old.kind === "header" ? "▸" : oneLine(c.old.text)}): ${c.changes.join("; ")}`),
    ...diff.added.map((a) => `  + ${t.added} (${t.at} ${a.at}): ${describe(a.line)}`),
    ...(diff.moved ? [`  ${t.moved}`] : []),
  ];
  return [
    `${t.head} ${s.number}${s.partner ? ` (${s.partner})` : ""}`,
    ...s.fields.map((f) => `  ${f.label}: ${show(f.from)} → ${show(f.to)}`),
    ...(diff.changed ? ["", `${t.lines}:`, ...lineRows, `  ${t.same}: ${diff.unchanged}`] : []),
    "",
    `${t.net}: ${m(s.oldTotals.net)} → ${m(s.totals.net)}`,
    `${t.tax}: ${m(s.oldTotals.tax)} → ${m(s.totals.tax)}`,
    `${t.gross}: ${m(s.oldTotals.gross)} → ${m(s.totals.gross)}`,
    ...(s.installation ? ["", `Metakocka: ${s.installation}`] : []),
  ].join("\n");
}
