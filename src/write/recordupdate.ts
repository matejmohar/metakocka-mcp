/**
 * Changes to existing register entries: a partner's data (update_partner) or
 * a product's (json/product_update), including its sales price when it has a
 * single, untiered price list entry. Only the fields given change; the
 * summary shows each old and new value, and the entry is read back afterwards.
 */
import { listAllProducts, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { asArray, bool, num, str } from "../util.js";
import type { ChangeCheck } from "./change.js";
import { DraftError, findPartners, money, type BuildContext } from "./document.js";
import type { Draft } from "./drafts.js";

export interface PartnerUpdateInput {
  partner_id?: string;
  name?: string;
  street?: string;
  post_number?: string;
  city?: string;
  country?: string;
  tax_id?: string;
  registration_number?: string;
  taxpayer?: boolean;
  role?: "supplier" | "buyer" | "both";
  language?: "sl" | "en";
}

export interface ProductUpdateInput {
  product_id?: string;
  name?: string;
  description?: string;
  unit?: string;
  barcode?: string;
  active?: boolean;
  sales?: boolean;
  purchasing?: boolean;
  safety_stock?: number;
  minimal_order_quantity?: number;
  weight_kg?: number;
  /** New net sales price on the product's one price list entry. */
  price?: number;
  language?: "sl" | "en";
}

interface Change {
  label: string;
  from?: string;
  to: string;
}

const show = (v: string | undefined, sl: boolean) => (v === undefined || v === "" ? (sl ? "(prazno)" : "(empty)") : v);

function summary(head: string, changes: Change[], installation: string | undefined, sl: boolean): string {
  return [head, ...changes.map((c) => `  ${c.label}: ${show(c.from, sl)} → ${show(c.to, sl)}`), ...(installation ? ["", `Metakocka: ${installation}`] : [])].join("\n");
}

export async function buildPartnerUpdateDraft(ctx: BuildContext, input: PartnerUpdateInput): Promise<{ draft: Draft; warnings: string[] }> {
  if (!input.partner_id) throw new DraftError("Give partner_id (from search_partners).");
  const found = (await findPartners(ctx.client, { partnerId: input.partner_id })).filter((p) => str(p.mk_id) === input.partner_id);
  if (found.length !== 1) throw new DraftError(`No partner with id ${input.partner_id} in Metakocka.`);
  const p = found[0]!;
  const address = asArray<MkRecord>(p.partner_delivery_address_list)[0] ?? {};
  const sl = (input.language ?? "sl") === "sl";

  const role = (b: MkRecord) => (bool(b.supplier) && bool(b.buyer) ? "both" : bool(b.supplier) ? "supplier" : bool(b.buyer) ? "buyer" : undefined);
  // Each field: what it is now, and how update_partner takes it.
  const fields: { key: keyof PartnerUpdateInput; label: string; now?: string; put: (v: never) => MkRecord }[] = [
    { key: "name", label: sl ? "naziv" : "name", now: str(p.customer), put: (v: string) => ({ customer: v }) },
    { key: "street", label: sl ? "ulica" : "street", now: str(address.street), put: (v: string) => ({ street: v }) },
    { key: "post_number", label: sl ? "pošta" : "post number", now: str(address.post_number), put: (v: string) => ({ post_number: v }) },
    { key: "city", label: sl ? "kraj" : "city", now: str(address.city), put: (v: string) => ({ place: v }) },
    { key: "country", label: sl ? "država" : "country", now: str(address.country), put: (v: string) => ({ country: v }) },
    { key: "tax_id", label: sl ? "davčna številka" : "tax number", now: str(p.tax_id_number), put: (v: string) => ({ tax_id_number: v }) },
    { key: "registration_number", label: sl ? "matična številka" : "registration number", now: str(p.registration_number), put: (v: string) => ({ registration_number: v }) },
    { key: "taxpayer", label: sl ? "davčni zavezanec" : "VAT registered", now: str(p.taxpayer), put: (v: boolean) => ({ taxpayer: String(v) }) },
    { key: "role", label: sl ? "vloga" : "role", now: role(p), put: (v: "supplier" | "buyer" | "both") => ({ supplier: String(v !== "buyer"), buyer: String(v !== "supplier") }) },
  ];
  const changes: Change[] = [];
  let partner: MkRecord = { mk_id: input.partner_id };
  const warnings: string[] = [];
  for (const f of fields) {
    const value = input[f.key];
    if (value === undefined) continue;
    const to = typeof value === "string" ? value.trim() : String(value);
    if (!to) throw new DraftError(`${f.key} can't be empty.`);
    if ((f.now ?? "").toLowerCase() === to.toLowerCase()) {
      warnings.push(`${f.key} is already ${f.now}; left as it is.`);
      continue;
    }
    partner = { ...partner, ...f.put((typeof value === "string" ? value.trim() : value) as never) };
    changes.push({ label: f.label, from: f.now, to });
  }
  if (!changes.length) throw new DraftError("Nothing to change: give at least one new value.");
  // Address fields go on the partner's main address as a whole.
  if (input.street || input.post_number || input.city || input.country) {
    partner = {
      ...partner,
      street: partner.street ?? str(address.street),
      post_number: partner.post_number ?? str(address.post_number),
      place: partner.place ?? str(address.city),
      country: partner.country ?? str(address.country),
    };
  }

  const name = str(p.customer);
  const draft = ctx.drafts.add({
    docType: "partner_update",
    language: sl ? "sl" : "en",
    partner: { id: input.partner_id, name, taxId: str(p.tax_id_number), addressId: str(address.mk_id) ?? "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload: { partner },
    summary: "",
    target: { docType: "partner", mkId: input.partner_id, number: name },
    change: { endpoint: "update_partner", check: (client) => checkPartner(client, input.partner_id!, input) },
  });
  draft.summary = summary(`${sl ? "Spremeni PARTNERJA" : "Change PARTNER"} ${name}${str(p.tax_id_number) ? ` (${str(p.tax_id_number)})` : ""}`, changes, ctx.installation, sl);
  return { draft, warnings };
}

async function checkPartner(client: MetakockaClient, id: string, input: PartnerUpdateInput): Promise<ChangeCheck> {
  const p = (await findPartners(client, { partnerId: id })).find((x) => str(x.mk_id) === id);
  if (!p) return { done: false };
  const a = asArray<MkRecord>(p.partner_delivery_address_list)[0] ?? {};
  const eq = (x: string | undefined, y: string | undefined) => (x ?? "").trim().toLowerCase() === (y ?? "").trim().toLowerCase();
  const wrong = [
    input.name !== undefined && !eq(str(p.customer), input.name) && "name",
    input.street !== undefined && !eq(str(a.street), input.street) && "street",
    input.post_number !== undefined && !eq(str(a.post_number), input.post_number) && "post_number",
    input.city !== undefined && !eq(str(a.city), input.city) && "city",
    input.tax_id !== undefined && !eq(str(p.tax_id_number), input.tax_id) && "tax_id",
    input.registration_number !== undefined && !eq(str(p.registration_number), input.registration_number) && "registration_number",
    input.taxpayer !== undefined && bool(p.taxpayer) !== input.taxpayer && "taxpayer",
    input.role !== undefined && (bool(p.supplier) !== (input.role !== "buyer") || bool(p.buyer) !== (input.role !== "supplier")) && "role",
  ].filter(Boolean) as string[];
  const given = Object.keys(input).filter((k) => !["partner_id", "language", "country"].includes(k) && input[k as keyof PartnerUpdateInput] !== undefined);
  if (given.length && wrong.length === given.length) return { done: false };
  return { done: true, warnings: wrong.length ? [`CHECK IN METAKOCKA: ${wrong.join(", ")} didn't change.`] : [] };
}

export async function buildProductUpdateDraft(ctx: BuildContext, input: ProductUpdateInput): Promise<{ draft: Draft; warnings: string[] }> {
  if (!input.product_id) throw new DraftError("Give product_id (the product's Metakocka id from search_products).");
  const product = await readProduct(ctx.client, input.product_id);
  if (!product) throw new DraftError(`No product with id ${input.product_id} in Metakocka.`);
  const sl = (input.language ?? "sl") === "sl";
  const warnings: string[] = [];
  const payload: MkRecord = { mk_id: input.product_id };
  const changes: Change[] = [];

  const simple: { key: keyof ProductUpdateInput; api: string; label: string; now?: string }[] = [
    { key: "name", api: "name", label: sl ? "naziv" : "name", now: str(product.name) },
    { key: "description", api: "name_desc", label: sl ? "opis" : "description", now: str(product.name_desc) },
    { key: "unit", api: "unit", label: sl ? "enota" : "unit", now: str(product.unit) },
    { key: "barcode", api: "barcode", label: sl ? "črtna koda" : "barcode", now: str(product.barcode) },
    { key: "active", api: "activated", label: sl ? "aktiven" : "active", now: str(product.activated) },
    { key: "sales", api: "sales", label: sl ? "prodajni" : "sales", now: str(product.sales) },
    { key: "purchasing", api: "purchasing", label: sl ? "nabavni" : "purchasing", now: str(product.purchasing) },
    { key: "safety_stock", api: "safety_stock", label: sl ? "varnostna zaloga" : "safety stock", now: str(product.safety_stock) },
    { key: "minimal_order_quantity", api: "minimal_order_quantity", label: sl ? "minimalna naročilna količina" : "minimum order quantity", now: str(product.minimal_order_quantity) },
    { key: "weight_kg", api: "weight", label: sl ? "teža (kg)" : "weight (kg)", now: str(product.weight) },
  ];
  for (const f of simple) {
    const value = input[f.key];
    if (value === undefined) continue;
    if (typeof value === "number" && value < 0) throw new DraftError(`${f.key} can't be negative.`);
    const to = typeof value === "string" ? value.trim() : String(value);
    if (!to && (f.key === "name" || f.key === "unit")) throw new DraftError(`${f.key} can't be empty.`);
    const same = typeof value === "number" ? num(f.now) === value : (f.now ?? "").toLowerCase() === to.toLowerCase();
    if (same) {
      warnings.push(`${f.key} is already ${f.now}; left as it is.`);
      continue;
    }
    // Metakocka clears a text field only with this marker; an empty value would leave it as it is.
    payload[f.api] = to === "" ? "$REMOVE_STRING_VALUE$" : to;
    changes.push({ label: f.label, from: f.now, to });
  }

  let priceCheck: { pricelist: string; price: number } | undefined;
  if (input.price !== undefined) {
    if (input.price < 0) throw new DraftError("The price can't be negative.");
    const entries = asArray<MkRecord>(product.pricelist).filter((pl) => str(pl.sales_purchase) === "sales" && (str(pl.currency_code) ?? "EUR") === "EUR" && !str(pl.buyer));
    const defs = entries.flatMap((pl) => asArray<MkRecord>(pl.price_def));
    if (entries.length !== 1 || defs.length !== 1 || (num(defs[0]!.amount_from) ?? 0) > 1 || num(defs[0]!.amount_to) !== undefined) {
      throw new DraftError(
        entries.length
          ? `${str(product.name)} has ${entries.length > 1 ? "several sales price lists" : "a tiered price"}; change its price in Metakocka.`
          : `${str(product.name)} has no sales price list in EUR to change; set its first price in Metakocka.`,
      );
    }
    const def = defs[0]!;
    const current = num(def.price);
    if (current === input.price) {
      warnings.push(`The price is already ${current}; left as it is.`);
    } else {
      const pricelist = str(entries[0]!.count_code);
      if (!pricelist) throw new DraftError(`${str(product.name)}'s price list has no code; change its price in Metakocka.`);
      payload.pricelist = [{ count_code: pricelist, price_def: [{ amount_from: "0", amount_to: null, tax: str(def.tax), price: String(input.price), ...(str(def.discount) ? { discount: str(def.discount) } : {}) }] }];
      changes.push({ label: sl ? `cena (${pricelist})` : `price (${pricelist})`, from: current === undefined ? undefined : money(current, sl ? "sl" : "en"), to: money(input.price, sl ? "sl" : "en") });
      priceCheck = { pricelist, price: input.price };
    }
  }
  if (!changes.length) throw new DraftError("Nothing to change: give at least one new value.");
  if (input.active === false) warnings.push("An inactive product can't be used on new documents.");

  const name = str(product.name);
  const draft = ctx.drafts.add({
    docType: "product_update",
    language: sl ? "sl" : "en",
    partner: { id: "", addressId: "" },
    docDate: ctx.today,
    lines: [],
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload,
    summary: "",
    target: { docType: "product", mkId: input.product_id, number: str(product.code) },
    change: { endpoint: "json/product_update", check: (client) => checkProduct(client, input.product_id!, payload, priceCheck) },
  });
  draft.summary = summary(`${sl ? "Spremeni IZDELEK" : "Change PRODUCT"} ${name} (${sl ? "šifra" : "code"} ${str(product.code) ?? "?"})`, changes, ctx.installation, sl);
  return { draft, warnings };
}

/** product_list can't select by mk_id, so the catalogue is read (usually one call of up to 1000 products). */
async function readProduct(client: MetakockaClient, id: string): Promise<MkRecord | undefined> {
  const { products } = await listAllProducts(client, { includePrices: true }, 20_000);
  return products.find((p) => str(p.mk_id) === id);
}

async function checkProduct(client: MetakockaClient, id: string, payload: MkRecord, price: { pricelist: string; price: number } | undefined): Promise<ChangeCheck> {
  const p = await readProduct(client, id);
  if (!p) return { done: false };
  // product_list doesn't return every field (e.g. safety_stock); those can't be checked here.
  const fields = Object.keys(payload).filter((k) => k !== "mk_id" && k !== "pricelist" && (p[k] !== undefined || payload[k] === "$REMOVE_STRING_VALUE$"));
  const wrong = fields.filter((k) => {
    const want = String(payload[k]);
    if (want === "$REMOVE_STRING_VALUE$") return !!str(p[k]);
    const have = str(p[k]) ?? "";
    return num(want) !== undefined && num(have) !== undefined ? num(want) !== num(have) : have.toLowerCase() !== want.toLowerCase();
  });
  if (price) {
    const entry = asArray<MkRecord>(p.pricelist).find((pl) => str(pl.count_code) === price.pricelist);
    const now = num(asArray<MkRecord>(entry?.price_def)[0]?.price);
    if (now !== price.price) wrong.push("price");
  }
  const total = fields.length + (price ? 1 : 0);
  if (total && wrong.length === total) return { done: false };
  return { done: true, warnings: wrong.length ? [`CHECK IN METAKOCKA: ${wrong.join(", ")} didn't change.`] : [] };
}
