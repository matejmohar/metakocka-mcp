/**
 * What every drafted document shares: the partner and its address linked by
 * id, product lines priced from Metakocka's catalogue, totals, and the
 * summary the user confirms. Nothing is written here.
 */
import { searchPartners, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import type { TtlCache } from "../cache.js";
import { asArray, bool, round2, str } from "../util.js";
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
}

/**
 * The partner by its id, refused when it is foreign and `foreign` isn't allowed, or (for sales documents)
 * has category discounts.
 */
export async function resolvePartner(
  client: MetakockaClient,
  partnerId: string,
  { foreign, what, discounts = "refuse" }: { foreign: "refuse" | "allow"; what: string; discounts?: "refuse" | "ignore" },
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
  if (discounts === "refuse" && asArray(p.discounts).length) {
    throw new DraftError(
      `${name} has partner discounts per product category in Metakocka. They are not applied automatically yet, ` +
        "so this document can't be created here; create it in Metakocka.",
    );
  }
  return {
    id: partnerId,
    name,
    taxId: str(p.tax_id_number),
    foreign: isForeign,
    taxpayer: bool(p.taxpayer) === true,
    addresses: asArray<MkRecord>(p.partner_delivery_address_list),
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

  const discountPercent = line.discount_percent ?? (line.price === undefined && currency === "EUR" ? product.discountPercent ?? 0 : 0);
  return priceLine({ product, quantity, price, discountPercent, taxCode, taxRatePercent });
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
