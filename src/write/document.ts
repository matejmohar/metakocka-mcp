/**
 * What every drafted document shares: the partner and its address linked by
 * id, product lines priced from Metakocka's catalogue, totals, and the
 * summary the user confirms. Nothing is written here.
 */
import { searchPartners, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import type { TtlCache } from "../cache.js";
import { asArray, bool, num, round2, str } from "../util.js";
import type { CatalogProduct } from "./catalog.js";
import type { Draft, DraftLine, DraftStore, DraftTotals } from "./drafts.js";

export interface LineInput {
  /** Metakocka product id (mk_id). */
  product_id?: string;
  /** Exact product code (šifra), as an alternative to product_id. */
  code?: string;
  quantity?: number;
  price?: number;
  discount_percent?: number;
  /** VAT rate to charge instead of the price list's (e.g. 0 for reverse charge or export, 22). */
  vat_percent?: number;
}

export interface BuildContext {
  client: MetakockaClient;
  cache: TtlCache;
  drafts: DraftStore;
  today: string;
  /** Host of the Metakocka installation when it is not main.metakocka.si, shown in the summary. */
  installation?: string;
}

/** A problem with the request the user has to resolve; nothing was saved. */
export class DraftError extends MetakockaError {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

/** Marks a document as created by this server in Metakocka's change log (max 50 characters). */
export const CHANGE_LOG_PREFIX = "metakocka-mcp";

/** get_partner answers "no partner with such properties" with an error (opr_code 2); here that is an empty list. */
export async function findPartners(client: MetakockaClient, q: Parameters<typeof searchPartners>[1]): Promise<MkRecord[]> {
  try {
    return await searchPartners(client, q);
  } catch (error) {
    if (error instanceof MetakockaError && error.oprCode === "2") return [];
    throw error;
  }
}

export interface ResolvedPartner {
  id: string;
  name?: string;
  taxId?: string;
  foreign: boolean;
  /** VAT registered (davčni zavezanec). */
  taxpayer: boolean;
  addresses: MkRecord[];
  /** The partner's discounts per product category (popusti partnerja). */
  discounts: PartnerDiscount[];
  /** As get_partner returned it. */
  record: MkRecord;
}

export interface PartnerDiscount {
  categories: string[];
  percent: number;
  /** Replaces a discount the price list already gives; otherwise that one stays. */
  override: boolean;
}

/** The partner by its id, refused when it is foreign and `foreign` isn't allowed. */
export async function resolvePartner(
  client: MetakockaClient,
  partnerId: string,
  { foreign, what }: { foreign: "refuse" | "allow"; what: string; discounts?: "ignore" },
): Promise<ResolvedPartner> {
  const found = (await findPartners(client, { partnerId, withDiscounts: true })).filter((p) => str(p.mk_id) === partnerId);
  if (found.length !== 1) {
    throw new DraftError(
      `No partner with id ${partnerId} in Metakocka. Find the partner with search_partners and use its id; ` +
        "this tool never creates partners — add a missing one in Metakocka first.",
    );
  }
  const p = found[0]!;
  const name = str(p.customer);
  const isForeign = bool(p.foreign_county) === true;
  if (isForeign && foreign === "refuse") {
    throw new DraftError(`${name} is a foreign partner. ${what} for foreign partners are not supported yet; create it in Metakocka.`);
  }
  return {
    id: partnerId,
    name,
    taxId: str(p.tax_id_number),
    foreign: isForeign,
    taxpayer: bool(p.taxpayer) === true,
    addresses: asArray<MkRecord>(p.partner_delivery_address_list),
    discounts: asArray<MkRecord>(p.discounts)
      .map((d) => ({
        categories: asArray<string>(d.categories).map((c) => String(c).trim()).filter(Boolean),
        percent: num(d.discount_percent) ?? 0,
        override: bool(d.override_existing) === true,
      }))
      .filter((d) => d.categories.length && d.percent > 0),
    record: p,
  };
}

export function resolveAddress(partner: ResolvedPartner, addressId: string | undefined): { id: string; text: string; record: MkRecord } {
  const describe = (a: MkRecord) =>
    [str(a.street), [str(a.post_number), str(a.city)].filter(Boolean).join(" "), str(a.country)].filter(Boolean).join(", ");
  const choices = partner.addresses.map((a) => `${str(a.mk_id)}: ${str(a.address_type) ?? "?"} — ${describe(a)}`).join("; ");
  if (addressId) {
    const a = partner.addresses.find((x) => str(x.mk_id) === addressId);
    if (!a) throw new DraftError(`Address ${addressId} does not belong to ${partner.name}. Its addresses: ${choices || "none"}.`);
    return { id: addressId, text: describe(a), record: a };
  }
  if (partner.addresses.length === 1) {
    const a = partner.addresses[0]!;
    return { id: str(a.mk_id) ?? "", text: describe(a), record: a };
  }
  if (!partner.addresses.length) throw new DraftError(`${partner.name} has no address in Metakocka. Add one there first.`);
  throw new DraftError(`${partner.name} has several addresses; ask the user which one and pass its id as address_id. ${choices}.`);
}

/** A tax code to use for products whose price list has none (foreign invoices: the 0 % code). */
export interface TaxFallback {
  code: string;
  ratePercent: number;
}

export interface LineOptions {
  /** Tax for products whose price list has none. */
  taxFallback?: TaxFallback;
  /**
   * Foreign partners: lines without vat_percent take this (the 0 % code: reverse charge, export) instead of the
   * price list's tax. Undefined when the catalogue has no single 0 % code; then vat_percent is needed.
   */
  foreignTax?: TaxFallback | "unknown";
  /** Document currency; price lists are in EUR, so other currencies need every price given. */
  currency?: string;
  /** The partner's discounts per product category, applied to lines priced from the price list. */
  partnerDiscounts?: PartnerDiscount[];
}

/** The partner's best discount for a product, by the product's categories. */
export function partnerDiscountFor(discounts: PartnerDiscount[] | undefined, product: CatalogProduct): (PartnerDiscount & { category: string }) | undefined {
  let best: (PartnerDiscount & { category: string }) | undefined;
  for (const d of discounts ?? []) {
    const category = d.categories.find((c) => product.categories.some((pc) => pc.toLowerCase() === c.toLowerCase()));
    if (category && (!best || d.percent > best.percent)) best = { ...d, category };
  }
  return best;
}

/** The one tax code the catalogue's price lists use for a VAT rate. */
export function taxCodeForRate(catalog: Map<string, CatalogProduct>, rate: number, n: number): string {
  const codes = new Set<string>();
  for (const p of catalog.values()) if (p.taxCode && p.taxRatePercent === rate) codes.add(p.taxCode);
  if (codes.size === 1) return [...codes][0]!;
  throw new DraftError(
    codes.size
      ? `Line ${n}: several tax codes have ${rate} % VAT (${[...codes].join(", ")}); create this document in Metakocka.`
      : `Line ${n}: no price list uses a tax code with ${rate} % VAT, so its code is unknown; create this document in Metakocka.`,
  );
}

/** The catalogue's only 0 % tax code, if it has exactly one. */
export function catalogZeroTax(catalog: Map<string, CatalogProduct>): TaxFallback | undefined {
  const zero = new Set([...catalog.values()].filter((p) => p.taxCode && p.taxRatePercent === 0).map((p) => p.taxCode!));
  return zero.size === 1 ? { code: [...zero][0]!, ratePercent: 0 } : undefined;
}

/**
 * Warnings about VAT on a document for a foreign partner: a VAT-registered business usually gets no VAT
 * (reverse charge), a private person may owe Slovenian VAT (or OSS).
 */
export function foreignVatWarnings(partner: ResolvedPartner, lines: DraftLine[]): string[] {
  if (!partner.foreign) return [];
  const withVat = lines.filter((l) => l.taxRatePercent > 0);
  if (withVat.length && partner.taxpayer) {
    return [`${partner.name} is a VAT-registered foreign business, yet ${withVat.length} line(s) charge VAT; within the EU that is usually reverse charge without VAT. Make sure VAT is right here.`];
  }
  if (!withVat.length && !partner.taxpayer) {
    return [`${partner.name} is a foreign private person (not VAT registered) and no line charges VAT; for sales to private persons in the EU Slovenian VAT (or OSS) may apply.`];
  }
  return [];
}

/**
 * A partner as a document's receiver (prejemnik). put_document ignores a receiver given only by id (it takes the
 * buyer instead) and creates a new partner from one given without it, so an existing partner is sent in full, with its id.
 */
export function receiverPayload(partner: ResolvedPartner, address: { id: string; record: MkRecord }): MkRecord {
  const p = partner.record;
  const a = address.record;
  return {
    mk_id: partner.id,
    mk_address_id: address.id,
    business_entity: str(p.business_entity) ?? "true",
    taxpayer: String(partner.taxpayer),
    foreign_county: String(partner.foreign),
    ...(partner.taxId ? { tax_id_number: partner.taxId } : {}),
    customer: partner.name,
    street: str(a.street),
    post_number: str(a.post_number),
    place: str(a.city),
    country: str(a.country),
  };
}

/** What the partner's category discounts did to the lines, for the draft's warnings. */
export function partnerDiscountNotes(partner: Pick<ResolvedPartner, "name" | "discounts">, lines: DraftLine[], input: LineInput[] | undefined, catalog: Map<string, CatalogProduct>): string[] {
  if (!partner.discounts.length) return [];
  const applied = lines.map((l, i) => (l.partnerDiscount ? `line ${i + 1} −${l.discountPercent} % (${l.partnerDiscount})` : undefined)).filter(Boolean);
  const notes = applied.length ? [`${partner.name}'s category discounts applied: ${applied.join(", ")}.`] : [];
  // A price given by hand gets no automatic discount: say so when one would have applied.
  const skipped = (input ?? [])
    .map((l, i) => {
      const product = catalog.get(lines[i]?.productId ?? "");
      const d = product && l.price !== undefined && l.discount_percent === undefined ? partnerDiscountFor(partner.discounts, product) : undefined;
      return d ? `line ${i + 1} (${d.category} −${d.percent} %)` : undefined;
    })
    .filter(Boolean);
  if (skipped.length) notes.push(`${partner.name} has a category discount for ${skipped.join(", ")}, not applied because the price was given; pass discount_percent if it should be.`);
  return notes;
}

/** A currency as an ISO code, e.g. "usd" → "USD". */
export function currencyCode(value: string | undefined): string {
  const code = (value ?? "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new DraftError(`Currency "${value}" is not an ISO code like EUR, USD, GBP, CHF.`);
  return code;
}

/** One catalogue product line, priced and taxed from its price list unless the line says otherwise. */
export function productLine(catalog: Map<string, CatalogProduct>, line: LineInput, i: number, options: LineOptions = {}): DraftLine {
  const { taxFallback, foreignTax } = options;
  const currency = options.currency ?? "EUR";
  const n = i + 1;
  let product: CatalogProduct | undefined;
  if (line.product_id) {
    product = catalog.get(line.product_id);
    if (!product) throw new DraftError(`Line ${n}: no product with id ${line.product_id}. Find it with search_products and use its id.`);
  } else if (line.code) {
    const matches = [...catalog.values()].filter((p) => p.code === line.code);
    if (matches.length !== 1) {
      throw new DraftError(
        matches.length
          ? `Line ${n}: several products have the code ${line.code}; use product_id.`
          : `Line ${n}: no product with the code ${line.code}. This tool never creates products — add it in Metakocka first.`,
      );
    }
    product = matches[0]!;
  } else {
    throw new DraftError(
      `Line ${n}: give product_id (or code). Every line must be a product: Metakocka's API has no description-only lines. ` +
        "Suggest to the user to leave this line out; don't move its text into the title or note unless they ask for it.",
    );
  }

  if (!product.active) throw new DraftError(`Line ${n}: ${product.name} is not active in Metakocka.`);
  if (!product.sales) throw new DraftError(`Line ${n}: ${product.name} is not marked for sale in Metakocka.`);
  let taxCode: string | undefined;
  let taxRatePercent: number | undefined;
  if (line.vat_percent !== undefined) {
    [taxCode, taxRatePercent] = [taxCodeForRate(catalog, line.vat_percent, n), line.vat_percent];
  } else if (foreignTax === "unknown") {
    throw new DraftError(`Line ${n}: give vat_percent for this foreign partner (0 for reverse charge or export, or the VAT rate to charge).`);
  } else if (foreignTax) {
    [taxCode, taxRatePercent] = [foreignTax.code, foreignTax.ratePercent];
  } else {
    taxCode = product.taxCode ?? taxFallback?.code;
    taxRatePercent = product.taxCode ? product.taxRatePercent : taxFallback?.ratePercent;
  }
  if (!taxCode || taxRatePercent === undefined) {
    throw new DraftError(`Line ${n}: ${product.name} has ${product.problem ?? "no tax code"}. Fix its price list in Metakocka, or give vat_percent.`);
  }
  // Price lists are in EUR; in another currency every price is given.
  const listPrice = currency === "EUR" ? product.price : undefined;
  const price = line.price ?? listPrice;
  if (price !== undefined && price < 0) throw new DraftError(`Line ${n}: the price can't be negative.`);
  if (price === undefined) {
    throw new DraftError(
      currency === "EUR"
        ? `Line ${n}: ${product.name} has ${product.problem ?? "no price"}. Give the price explicitly.`
        : `Line ${n}: give the price of ${product.name} in ${currency}; price lists are in EUR.`,
    );
  }
  const quantity = line.quantity;
  if (quantity === undefined || !(quantity > 0)) throw new DraftError(`Line ${n}: quantity must be more than 0.`);

  // Discount: given; else, for a price from the price list, the list's and the partner's discount for the product's category.
  let discountPercent = line.discount_percent ?? 0;
  let partnerDiscount: string | undefined;
  if (line.discount_percent === undefined && line.price === undefined && currency === "EUR") {
    const listed = product.discountPercent ?? 0;
    const partner = partnerDiscountFor(options.partnerDiscounts, product);
    discountPercent = listed;
    if (partner && (partner.override || !listed)) {
      discountPercent = partner.percent;
      partnerDiscount = partner.category;
    }
  }
  return { ...priceLine({ product, quantity, price, discountPercent, taxCode, taxRatePercent }), ...(partnerDiscount ? { partnerDiscount } : {}) };
}

/** Net, tax and gross of a line. */
export function priceLine(l: {
  product: Pick<CatalogProduct, "id" | "code" | "productId" | "name" | "unit">;
  quantity: number;
  price: number;
  discountPercent: number;
  taxCode: string;
  taxRatePercent: number;
}): DraftLine {
  const net = round2(l.quantity * l.price * (1 - l.discountPercent / 100));
  const tax = round2((net * l.taxRatePercent) / 100);
  return {
    productId: l.product.id,
    code: l.product.code,
    countCode: l.product.productId,
    name: l.product.name,
    unit: l.product.unit,
    quantity: l.quantity,
    price: l.price,
    discountPercent: l.discountPercent,
    taxCode: l.taxCode,
    taxRatePercent: l.taxRatePercent,
    net,
    tax,
    gross: round2(net + tax),
  };
}

export function totalsOf(lines: DraftLine[], currency = "EUR"): DraftTotals {
  return {
    net: round2(lines.reduce((s, l) => s + l.net, 0)),
    tax: round2(lines.reduce((s, l) => s + l.tax, 0)),
    gross: round2(lines.reduce((s, l) => s + l.gross, 0)),
    currency,
  };
}

/** put_document finds products by code / count_code; mk_id alone leaves it "not found". */
export function productListPayload(lines: DraftLine[]): MkRecord[] {
  return lines.map((l) => ({
    mk_id: l.productId,
    ...(l.code ? { code: l.code } : {}),
    ...(l.countCode ? { count_code: l.countCode } : {}),
    amount: String(l.quantity),
    price: String(l.price),
    discount: String(l.discountPercent),
    tax: l.taxCode,
  }));
}

/** A warning when this server already saved the same kind of document to this partner for the same amount today. */
export function duplicateWarning(drafts: DraftStore, d: Pick<Draft, "docType" | "partner" | "docDate" | "totals">, what: string): string | undefined {
  const same = drafts
    .committed()
    .find((c) => c.docType === d.docType && c.partner.id === d.partner.id && c.docDate === d.docDate && Math.abs(c.totals.gross - d.totals.gross) < 0.01);
  return same ? `${what} to this partner for the same amount was already created today (${same.result?.number ?? same.result?.mkId}).` : undefined;
}

/** A quantity or percentage in the summary's language: 37,48 in Slovenian, 37.48 in English. */
const decimal = (n: number, language: "sl" | "en") =>
  n.toLocaleString(language === "sl" ? "sl-SI" : "en-GB", { maximumFractionDigits: 6, useGrouping: false });

export const money = (n: number, language: "sl" | "en", currency = "EUR") =>
  `${n.toLocaleString(language === "sl" ? "sl-SI" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency === "EUR" ? "€" : currency}`;

/** The lines and totals block of a summary, one fact per line. */
export function linesAndTotals(d: Pick<Draft, "language" | "lines" | "totals">): string[] {
  const sl = d.language === "sl";
  const m = (n: number) => money(n, d.language, d.totals.currency);
  const t = sl ? { lines: "Postavke", net: "Osnova", tax: "DDV", gross: "Skupaj z DDV" } : { lines: "Lines", net: "Net", tax: "VAT", gross: "Total incl. VAT" };
  return [
    `${t.lines}:`,
    ...d.lines.map((l, i) => `  ${i + 1}. ${decimal(l.quantity, d.language)} × ${l.name} à ${m(l.price)}${l.discountPercent ? ` −${decimal(l.discountPercent, d.language)} %` : ""} = ${m(l.net)}`),
    "",
    `${t.net}: ${m(d.totals.net)}`,
    `${t.tax}: ${m(d.totals.tax)}`,
    `${t.gross}: ${m(d.totals.gross)}`,
  ];
}

/** A note on one summary line. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The summary as the client passed it back, compared without line endings, indentation or blank lines. */
export function sameSummary(given: string, summary: string): boolean {
  const norm = (s: string) =>
    s
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  return norm(given) === norm(summary);
}
