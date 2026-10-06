/**
 * Builds an offer (ponudba / predračun) draft. Everything the document refers
 * to must already exist in Metakocka and is linked by id: the partner and its
 * address by mk_id / mk_address_id, products by mk_id. Prices and tax codes
 * come from Metakocka's catalogue, not from the model. Nothing is written here.
 */
import { searchPartners, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import type { TtlCache } from "../cache.js";
import { toMkDate } from "../dates.js";
import { asArray, bool, num, round2, str } from "../util.js";
import { loadCatalog, type CatalogProduct } from "./catalog.js";
import type { Draft, DraftLine, DraftStore } from "./drafts.js";

export interface OfferLineInput {
  /** Metakocka product id (mk_id). */
  product_id?: string;
  /** Exact product code (šifra), as an alternative to product_id. */
  code?: string;
  /** A description-only line (no product, no amount, no price). */
  text?: string;
  quantity?: number;
  price?: number;
  discount_percent?: number;
}

export interface OfferInput {
  partner_id: string;
  address_id?: string;
  lines: OfferLineInput[];
  title?: string;
  note?: string;
  valid_days?: number;
  language?: "sl" | "en";
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

export async function buildOfferDraft(ctx: BuildContext, input: OfferInput): Promise<{ draft: Draft; warnings: string[] }> {
  const warnings: string[] = [];
  const partner = await resolvePartner(ctx.client, input.partner_id);
  const address = resolveAddress(partner, input.address_id);

  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  const productLines = input.lines.filter((l) => l.text === undefined);
  if (!productLines.length) throw new DraftError("An offer needs at least one product line.");

  const lines: DraftLine[] = [];
  for (const [i, line] of input.lines.entries()) {
    lines.push(line.text !== undefined ? textLine(line, i) : productLine(catalog, line, i));
  }
  // A description line carries no amount; give it the tax code the product lines use so Metakocka has one.
  const firstTax = lines.find((l) => l.kind === "product")!;
  for (const l of lines) if (l.kind === "text") Object.assign(l, { taxCode: firstTax.taxCode, taxRatePercent: firstTax.taxRatePercent });

  const totals = {
    net: round2(lines.reduce((s, l) => s + l.net, 0)),
    tax: round2(lines.reduce((s, l) => s + l.tax, 0)),
    gross: round2(lines.reduce((s, l) => s + l.gross, 0)),
    currency: "EUR",
  };

  const validDays = input.valid_days ?? 30;
  const payload: MkRecord = {
    doc_type: "sales_offer",
    doc_date: toMkDate(ctx.today),
    partner: { mk_id: partner.id, mk_address_id: address.id },
    currency_code: "EUR",
    valid_days: String(validDays),
    ...(input.title ? { title: input.title } : {}),
    ...(input.note ? { notes: input.note } : {}),
    product_list: lines.map((l) =>
      l.kind === "product"
        ? { mk_id: l.productId, amount: String(l.quantity), price: String(l.price), discount: String(l.discountPercent), tax: l.taxCode }
        : { name: l.name, amount: "0", price: "0", tax: l.taxCode },
    ),
  };

  const same = ctx.drafts
    .committed()
    .find((d) => d.partner.id === partner.id && d.docDate === ctx.today && Math.abs(d.totals.gross - totals.gross) < 0.01);
  if (same) warnings.push(`An offer to this partner for the same amount was already created today (${same.result?.number ?? same.result?.mkId}).`);

  const language = input.language ?? "sl";
  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const draft = ctx.drafts.add({
    docType: "sales_offer",
    language,
    partner: partnerRef,
    docDate: ctx.today,
    lines,
    totals,
    payload,
    summary: "",
  });
  // The id goes into Metakocka's change log, so the document can be traced back to this draft.
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  draft.summary = summarize(draft, validDays, ctx.installation);
  return { draft, warnings };
}

interface ResolvedPartner {
  id: string;
  name?: string;
  taxId?: string;
  addresses: MkRecord[];
}

async function resolvePartner(client: MetakockaClient, partnerId: string): Promise<ResolvedPartner> {
  const found = (await searchPartners(client, { partnerId, withDiscounts: true })).filter((p) => str(p.mk_id) === partnerId);
  if (found.length !== 1) {
    throw new DraftError(
      `No partner with id ${partnerId} in Metakocka. Find the partner with search_partners and use its id; ` +
        "this tool never creates partners — add a missing one in Metakocka first.",
    );
  }
  const p = found[0]!;
  const name = str(p.customer);
  if (bool(p.foreign_county)) {
    throw new DraftError(`${name} is a foreign partner. Offers for foreign partners are not supported yet; create it in Metakocka.`);
  }
  if (asArray(p.discounts).length) {
    throw new DraftError(
      `${name} has partner discounts per product category in Metakocka. They are not applied automatically yet, ` +
        "so this offer can't be created here; create it in Metakocka.",
    );
  }
  return { id: partnerId, name, taxId: str(p.tax_id_number), addresses: asArray<MkRecord>(p.partner_delivery_address_list) };
}

function resolveAddress(partner: ResolvedPartner, addressId: string | undefined): { id: string; text: string } {
  const describe = (a: MkRecord) =>
    [str(a.street), [str(a.post_number), str(a.city)].filter(Boolean).join(" "), str(a.country)].filter(Boolean).join(", ");
  const choices = partner.addresses.map((a) => `${str(a.mk_id)}: ${str(a.address_type) ?? "?"} — ${describe(a)}`).join("; ");
  if (addressId) {
    const a = partner.addresses.find((x) => str(x.mk_id) === addressId);
    if (!a) throw new DraftError(`Address ${addressId} does not belong to ${partner.name}. Its addresses: ${choices || "none"}.`);
    return { id: addressId, text: describe(a) };
  }
  if (partner.addresses.length === 1) {
    const a = partner.addresses[0]!;
    return { id: str(a.mk_id) ?? "", text: describe(a) };
  }
  if (!partner.addresses.length) throw new DraftError(`${partner.name} has no address in Metakocka. Add one there first.`);
  throw new DraftError(`${partner.name} has several addresses; ask the user which one and pass its id as address_id. ${choices}.`);
}

function productLine(catalog: Map<string, CatalogProduct>, line: OfferLineInput, i: number): DraftLine {
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
    throw new DraftError(`Line ${n}: give product_id (or code) for a product line, or text for a description line.`);
  }

  if (!product.active) throw new DraftError(`Line ${n}: ${product.name} is not active in Metakocka.`);
  if (!product.sales) throw new DraftError(`Line ${n}: ${product.name} is not marked for sale in Metakocka.`);
  if (!product.taxCode || product.taxRatePercent === undefined) {
    throw new DraftError(`Line ${n}: ${product.name} has ${product.problem ?? "no tax code"}. Fix its price list in Metakocka.`);
  }
  const price = line.price ?? product.price;
  if (price === undefined) throw new DraftError(`Line ${n}: ${product.name} has ${product.problem ?? "no price"}. Give the price explicitly.`);
  const quantity = line.quantity;
  if (quantity === undefined || !(quantity > 0)) throw new DraftError(`Line ${n}: quantity must be more than 0.`);

  const discountPercent = line.discount_percent ?? (line.price === undefined ? product.discountPercent ?? 0 : 0);
  const net = round2(quantity * price * (1 - discountPercent / 100));
  const tax = round2((net * product.taxRatePercent) / 100);
  return {
    kind: "product",
    productId: product.id,
    code: product.code,
    name: product.name,
    unit: product.unit,
    quantity,
    price,
    discountPercent,
    taxCode: product.taxCode,
    taxRatePercent: product.taxRatePercent,
    net,
    tax,
    gross: round2(net + tax),
  };
}

function textLine(line: OfferLineInput, i: number): DraftLine {
  const text = line.text?.trim();
  if (!text) throw new DraftError(`Line ${i + 1}: a description line needs text.`);
  if (line.product_id || line.code || line.price !== undefined || line.quantity !== undefined) {
    throw new DraftError(`Line ${i + 1}: a description line has only text, no product, quantity or price.`);
  }
  return { kind: "text", name: text, quantity: 0, price: 0, discountPercent: 0, taxCode: "", taxRatePercent: 0, net: 0, tax: 0, gross: 0 };
}

const money = (n: number, language: "sl" | "en") =>
  `${n.toLocaleString(language === "sl" ? "sl-SI" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** What the user confirms: short, in their language, with everything that identifies the document. */
function summarize(d: Draft, validDays: number, installation: string | undefined): string {
  const sl = d.language === "sl";
  const products = d.lines.filter((l) => l.kind === "product");
  const lines = products
    .map((l) => `${l.quantity} × ${l.name} à ${money(l.price, d.language)}${l.discountPercent ? ` −${l.discountPercent} %` : ""}`)
    .join("; ");
  const who = `${d.partner.name}${d.partner.taxId ? ` (${d.partner.taxId})` : ""}, ${d.partner.address}`;
  const where = installation ? ` Metakocka: ${installation}.` : "";
  return sl
    ? `Ustvari PONUDBO za ${who}. Postavke (${products.length}): ${lines}. Skupaj ${money(d.totals.gross, "sl")} z DDV ` +
        `(osnova ${money(d.totals.net, "sl")}, DDV ${money(d.totals.tax, "sl")}). Datum ${d.docDate}, velja ${validDays} dni.${where}`
    : `Create an OFFER for ${who}. ${products.length} line(s): ${lines}. Total ${money(d.totals.gross, "en")} incl. VAT ` +
        `(net ${money(d.totals.net, "en")}, VAT ${money(d.totals.tax, "en")}). Dated ${d.docDate}, valid ${validDays} days.${where}`;
}
