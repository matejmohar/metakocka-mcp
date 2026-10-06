/**
 * The product catalogue as the write tools need it: every product by its
 * Metakocka id with its sales price and tax code. One product_list call
 * returns up to 1000 products with their price lists, so the whole catalogue
 * usually costs one call and is then reused from the cache.
 */
import { listAllProducts, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import type { TtlCache } from "../cache.js";
import { fromMkDate } from "../dates.js";
import { asArray, bool, num, str } from "../util.js";

export interface CatalogProduct {
  id: string;
  code?: string;
  productId?: string;
  name: string;
  unit?: string;
  active: boolean;
  sales: boolean;
  /** Net sales price from the one applicable price list entry, when there is exactly one. */
  price?: number;
  /** Discount on that price list entry, in percent. */
  discountPercent?: number;
  /** Tax code to send on document lines (e.g. "EX4"), when all applicable entries agree. */
  taxCode?: string;
  taxRatePercent?: number;
  /** Why price or tax are missing, for the error message. */
  problem?: string;
}

const MAX_PRODUCTS = 20_000;

export function loadCatalog(client: MetakockaClient, cache: TtlCache, today: string): Promise<Map<string, CatalogProduct>> {
  return cache.getOrLoad(`write:catalog:${today}`, async () => {
    const { products, truncated } = await listAllProducts(client, { includePrices: true }, MAX_PRODUCTS);
    if (truncated) throw new Error(`The catalogue has more than ${MAX_PRODUCTS} products; writing documents is not supported for it yet.`);
    return new Map(products.map((p) => [str(p.mk_id) ?? "", toCatalogProduct(p, today)]).filter(([id]) => id) as [string, CatalogProduct][]);
  });
}

/**
 * Applicable price list entries: sales, EUR, valid today and not for one
 * specific customer. Phase 1 only uses a price or tax code when that leaves
 * no doubt which one applies.
 */
export function toCatalogProduct(p: MkRecord, today: string): CatalogProduct {
  const applicable = asArray<MkRecord>(p.pricelist).filter((pl) => {
    if (str(pl.sales_purchase) !== "sales") return false;
    if ((str(pl.currency_code) ?? "EUR") !== "EUR") return false;
    if (str(pl.buyer)) return false;
    const from = fromMkDate(pl.valid_from);
    const to = fromMkDate(pl.valid_to);
    return (!from || from <= today) && (!to || to >= today);
  });
  const defs = applicable.map((pl) => (pl.price_def ?? {}) as MkRecord);
  const taxCodes = [...new Set(defs.map((d) => str(d.tax)).filter(Boolean))] as string[];
  const tiered = defs.some((d) => (num(d.amount_from) ?? 0) > 1 || num(d.amount_to) !== undefined);

  let problem: string | undefined;
  if (!applicable.length) problem = "no sales price in EUR valid today";
  else if (taxCodes.length !== 1) problem = taxCodes.length ? `several tax codes (${taxCodes.join(", ")})` : "no tax code on its price list";
  else if (applicable.length > 1 || tiered) problem = "several applicable prices; give the price explicitly";

  const one = applicable.length === 1 && !tiered ? defs[0] : undefined;
  const taxDef = taxCodes.length === 1 ? defs.find((d) => str(d.tax) === taxCodes[0]) : undefined;
  return {
    id: str(p.mk_id) ?? "",
    code: str(p.code),
    productId: str(p.count_code),
    name: str(p.name) ?? str(p.code) ?? "?",
    unit: str(p.unit),
    active: bool(p.activated ?? p.active) !== false,
    sales: bool(p.sales) === true,
    price: one ? num(one.price) : undefined,
    discountPercent: one ? num(one.discount) : undefined,
    taxCode: taxCodes.length === 1 ? taxCodes[0] : undefined,
    taxRatePercent: taxDef ? num(taxDef.tax_desc) ?? ratePercent(num(taxDef.tax_factor)) : undefined,
    problem,
  };
}

function ratePercent(factor: number | undefined): number | undefined {
  return factor === undefined ? undefined : Math.round(factor * 10000) / 100;
}
