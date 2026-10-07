/**
 * Purchase and warehouse documents: purchase orders to suppliers
 * (naročilnica), packing lists and delivery orders to customers (dobavnica,
 * nalog za odpremo), receiving orders and goods received notes from suppliers
 * (nalog za prevzem, prevzemnica), transfers between warehouses and work
 * orders. Linked to existing partners, products and documents by id like
 * every other document; nothing is written here. Packing lists, goods
 * received notes and confirmed transfers move stock, and the summary says so.
 */
import { findDocumentIdByNumber, getDocument, searchAllDocuments, type MkRecord } from "../api.js";
import { isIsoDate, toMkDate } from "../dates.js";
import type { DocType } from "../doc-types.js";
import { asArray, num, str } from "../util.js";
import { cachedWarehouses, resolveWarehouse, type ToolContext } from "../tools/shared.js";
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
} from "./document.js";
import type { Draft, DraftLine } from "./drafts.js";
import { purchaseProduct, taxCodeFor } from "./purchase.js";

export interface StockLineInput {
  product_id?: string;
  code?: string;
  quantity?: number;
  price?: number;
  discount_percent?: number;
  vat_percent?: number;
}

export interface StockDocInput {
  doc_type: StockDocType;
  partner_id?: string;
  address_id?: string;
  lines?: StockLineInput[];
  /** Warehouse name, mark or id; transfers: the source warehouse. */
  warehouse?: string;
  /** Transfers: the target warehouse. */
  to_warehouse?: string;
  /** Transfers: confirm it at once (moves the stock). */
  confirm?: boolean;
  /** Outgoing documents and work orders: the sales order they are for (lines and partner taken from it). */
  from_order?: string;
  /** Receiving orders and goods received notes: the purchase order they receive. */
  from_purchase_order?: string;
  /** Goods received notes: the supplier's delivery note number. */
  supplier_document?: string;
  /** Purchase orders: expected delivery; work orders: deadline. */
  delivery_date?: string;
  /** Work orders. */
  start_date?: string;
  title?: string;
  note?: string;
  /** ISO currency (default EUR, or the source document's). */
  currency?: string;
  language?: "sl" | "en";
}

export type StockDocType =
  | "purchase_order"
  | "warehouse_packing_list"
  | "warehouse_delivery_note"
  | "warehouse_receiving_note"
  | "warehouse_acceptance_note"
  | "transfer_order"
  | "workorder";

const OUTGOING = new Set<StockDocType>(["warehouse_packing_list", "warehouse_delivery_note"]);
const INCOMING = new Set<StockDocType>(["warehouse_receiving_note", "warehouse_acceptance_note"]);

const NAMES: Record<StockDocType, [string, string]> = {
  purchase_order: ["NAROČILNICO", "a PURCHASE ORDER"],
  warehouse_packing_list: ["DOBAVNICO", "a PACKING LIST"],
  warehouse_delivery_note: ["NALOG ZA ODPREMO", "a DELIVERY ORDER"],
  warehouse_receiving_note: ["NALOG ZA PREVZEM", "a RECEIVING ORDER"],
  warehouse_acceptance_note: ["PREVZEMNICO", "a GOODS RECEIVED NOTE"],
  transfer_order: ["MEDSKLADIŠČNI PRENOS", "a TRANSFER"],
  workorder: ["DELOVNI NALOG", "a WORK ORDER"],
};

/** Fields each document type takes besides partner, lines and note. */
export const STOCK_FIELDS: Record<StockDocType, readonly (keyof StockDocInput)[]> = {
  purchase_order: ["partner_id", "address_id", "lines", "warehouse", "delivery_date", "title", "note", "currency"],
  warehouse_packing_list: ["partner_id", "address_id", "lines", "warehouse", "from_order", "title", "note", "currency"],
  warehouse_delivery_note: ["partner_id", "address_id", "lines", "warehouse", "from_order", "title", "note", "currency"],
  warehouse_receiving_note: ["partner_id", "address_id", "lines", "warehouse", "from_purchase_order", "title", "note", "currency"],
  warehouse_acceptance_note: ["partner_id", "address_id", "lines", "warehouse", "from_purchase_order", "supplier_document", "title", "note", "currency"],
  transfer_order: ["lines", "warehouse", "to_warehouse", "confirm"],
  workorder: ["partner_id", "from_order", "start_date", "delivery_date", "title", "note"],
};

const HISTORY_MAX = 200;

export async function buildStockDocDraft(ctx: BuildContext & { tool: ToolContext }, input: StockDocInput): Promise<{ draft: Draft; warnings: string[] }> {
  const type = input.doc_type;
  const allowed = STOCK_FIELDS[type];
  const misplaced = (Object.keys(input) as (keyof StockDocInput)[]).filter(
    (k) => !["doc_type", "language"].includes(k) && input[k] !== undefined && !allowed.includes(k),
  );
  if (misplaced.length) throw new DraftError(`${misplaced.join(", ")}: not for ${type}.`);
  for (const k of ["delivery_date", "start_date"] as const) if (input[k] !== undefined && !isIsoDate(input[k]!)) throw new DraftError(`${k} must be a date as YYYY-MM-DD.`);
  if (type === "transfer_order") return buildTransfer(ctx, input);

  const warnings: string[] = [];
  // The source document: a sales order for outgoing documents and work orders, a purchase order for incoming ones.
  const sourceType: DocType | undefined = input.from_order ? "sales_order" : input.from_purchase_order ? "purchase_order" : undefined;
  const sourceNumber = input.from_order ?? input.from_purchase_order;
  let source: MkRecord | undefined;
  if (sourceType && sourceNumber) {
    const id = await findDocumentIdByNumber(ctx.client, sourceType, sourceNumber);
    if (!id) throw new DraftError(`No ${sourceType} ${sourceNumber} in Metakocka.`);
    source = await getDocument(ctx.client, sourceType, id);
    if (input.lines?.length && type !== "workorder") throw new DraftError(`Give either lines or ${input.from_order ? "from_order" : "from_purchase_order"}, not both.`);
  }
  const sourcePartner = source ? str((source.partner as MkRecord | undefined)?.mk_id) : undefined;
  if (source && input.partner_id && sourcePartner !== input.partner_id) throw new DraftError(`${sourceNumber} is for another partner.`);
  const partnerId = input.partner_id ?? sourcePartner;
  if (!partnerId) throw new DraftError("Give partner_id (from search_partners).");
  const supplierSide = type === "purchase_order" || INCOMING.has(type);
  const partner = await resolvePartner(ctx.client, partnerId, { foreign: "allow", what: "These documents", discounts: "ignore" });
  const address = resolveAddress(partner, input.address_id ?? (source ? str((source.partner as MkRecord).mk_address_id) : undefined));

  let warehouse: MkRecord | undefined;
  if (type !== "workorder") {
    const warehouses = await cachedWarehouses(ctx.tool);
    if (input.warehouse) warehouse = resolveWarehouse(warehouses, input.warehouse);
    else if (warehouses.length === 1) warehouse = warehouses[0];
    else if (type !== "purchase_order") throw new DraftError(`Give the warehouse: ${warehouses.map((w) => str(w.name)).join(", ")}.`);
  }

  const currency = source ? str(source.currency_code) ?? "EUR" : currencyCode(input.currency);
  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  let lines: DraftLine[] = [];
  if (type === "workorder") {
    // A work order's head only; what it makes is planned in Metakocka.
  } else if (source) {
    lines = sourceLines(catalog, source, `${sourceType === "sales_order" ? "Sales order" : "Purchase order"} ${sourceNumber}`);
  } else {
    if (!input.lines?.length) throw new DraftError(`${type} needs at least one product line${OUTGOING.has(type) ? ", or from_order" : INCOMING.has(type) ? ", or from_purchase_order" : ""}.`);
    if (supplierSide) {
      const history = (await searchAllDocuments(ctx.client, { docType: "purchase_bill_domestic", filters: [{ type: "partner_mk_id", value: partner.id }] }, HISTORY_MAX)).documents;
      lines = input.lines.map((l, i) => {
        const n = i + 1;
        const product = purchaseProduct(catalog, l, n);
        if (!(l.quantity! > 0)) throw new DraftError(`Line ${n}: quantity must be more than 0.`);
        if (l.price === undefined || l.price < 0) throw new DraftError(`Line ${n}: give the net unit purchase price.`);
        if (l.vat_percent === undefined) throw new DraftError(`Line ${n}: give vat_percent (e.g. 22, 9.5 or 0).`);
        const taxCode = taxCodeFor(catalog, history, product, l.vat_percent, n);
        return priceLine({ product, quantity: l.quantity!, price: l.price, discountPercent: l.discount_percent ?? 0, taxCode, taxRatePercent: l.vat_percent });
      });
    } else {
      lines = input.lines.map((l, i) => {
        return productLine(catalog, { ...l }, i, { currency, foreignTax: partner.foreign && l.vat_percent === undefined ? catalogZeroTax(catalog) ?? "unknown" : undefined });
      });
    }
  }
  const goods = lines.filter((l) => !catalog.get(l.productId)?.service);
  if ((type === "warehouse_packing_list" || type === "warehouse_acceptance_note") && goods.length) {
    warnings.push(
      type === "warehouse_packing_list"
        ? `Saving it takes the goods out of stock in ${str(warehouse?.name) ?? "the warehouse"}.`
        : `Saving it puts the goods into stock in ${str(warehouse?.name) ?? "the warehouse"}.`,
    );
  }
  const totals = totalsOf(lines, currency);
  const links = source
    ? sourceType === "sales_order"
      ? { sales_order_list: [{ count_code: str(source.count_code) }] }
      : { order_list: [{ count_code: str(source.count_code) }] }
    : {};

  let payload: MkRecord;
  let putEndpoint: string | undefined;
  if (type === "workorder") {
    putEndpoint = "put_document_workorder";
    const start = input.start_date ?? ctx.today;
    if (input.delivery_date && input.delivery_date < start) throw new DraftError("delivery_date (the deadline) is before start_date.");
    payload = {
      doc_date: toMkDate(ctx.today),
      start_date: toMkDate(start),
      partner: { mk_id: partner.id, mk_address_id: address.id },
      ...(input.title ? { title: input.title } : {}),
      ...(input.note ? { notes: input.note } : {}),
      ...(input.delivery_date ? { produce_deadline_date: toMkDate(input.delivery_date) } : {}),
      ...links,
    };
  } else {
    payload = {
      doc_type: type,
      doc_date: toMkDate(ctx.today),
      partner: { mk_id: partner.id, mk_address_id: address.id },
      currency_code: currency,
      ...(warehouse ? { [type === "purchase_order" ? "warehouse_delivery" : "warehouse"]: str(warehouse.mark) ?? str(warehouse.name) } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.note ? { notes: input.note } : {}),
      ...(input.delivery_date ? { delivery_date: toMkDate(input.delivery_date) } : {}),
      ...(input.supplier_document ? { packlist_code: input.supplier_document } : {}),
      ...links,
      product_list: productListPayload(lines),
    };
  }

  const sl = (input.language ?? "sl") === "sl";
  const partnerRef = { id: partner.id, name: partner.name, taxId: partner.taxId, addressId: address.id, address: address.text };
  const draft = ctx.drafts.add({ docType: type, language: sl ? "sl" : "en", partner: partnerRef, docDate: ctx.today, lines, totals, payload, summary: "", ...(putEndpoint ? { putEndpoint } : {}) });
  payload.document_change_log_notes = `${CHANGE_LOG_PREFIX} ${draft.id}`;
  const [nameSl, nameEn] = NAMES[type];
  draft.summary = [
    `${sl ? `Ustvari ${nameSl} za` : `Create ${nameEn} for`} ${partner.name}${partner.taxId ? ` (${partner.taxId})` : ""}`,
    address.text,
    ...(sourceNumber ? [`${sl ? (input.from_order ? "Iz prodajnega naročila" : "Iz naročilnice") : input.from_order ? "From sales order" : "From purchase order"}: ${sourceNumber}`] : []),
    ...(warehouse ? [`${sl ? "Skladišče" : "Warehouse"}: ${str(warehouse.name)}`] : []),
    ...(input.supplier_document ? [`${sl ? "Dobavnica dobavitelja" : "Supplier's delivery note"}: ${input.supplier_document}`] : []),
    ...(input.title ? [`${sl ? "Naziv" : "Title"}: ${input.title}`] : []),
    ...(input.note ? [`${sl ? "Opomba" : "Note"}: ${oneLine(input.note)}`] : []),
    ...(lines.length ? ["", ...linesAndTotals(draft)] : []),
    "",
    [
      `${sl ? "Datum" : "Dated"} ${ctx.today}`,
      ...(input.start_date ? [`${sl ? "začetek" : "start"} ${input.start_date}`] : []),
      ...(input.delivery_date ? [`${type === "workorder" ? (sl ? "rok" : "deadline") : sl ? "dobava" : "delivery"} ${input.delivery_date}`] : []),
      ...(ctx.installation ? [`Metakocka: ${ctx.installation}`] : []),
    ].join(" · "),
  ].join("\n");
  return { draft, warnings };
}

/** Lines of a sales or purchase order, as they are on it. */
function sourceLines(catalog: Map<string, CatalogProduct>, source: MkRecord, label: string): DraftLine[] {
  const rates = new Map<string, number>();
  for (const p of catalog.values()) if (p.taxCode && p.taxRatePercent !== undefined) rates.set(p.taxCode, p.taxRatePercent);
  const lines = asArray<MkRecord>(source.product_list);
  if (!lines.length) throw new DraftError(`${label} has no lines.`);
  return lines.map((l, i) => {
    const n = i + 1;
    const product = catalog.get(str(l.mk_id) ?? "");
    if (!product) throw new DraftError(`${label}, line ${n} (${str(l.name) ?? "?"}) is not a product from the catalogue.`);
    const quantity = num(l.amount);
    if (!quantity || quantity <= 0) throw new DraftError(`${label}, line ${n}: quantity is missing.`);
    const taxCode = str(l.tax) ?? product.taxCode ?? "";
    const rate = rates.get(taxCode) ?? product.taxRatePercent ?? 0;
    return priceLine({ product, quantity, price: num(l.price) ?? 0, discountPercent: num(l.discount) ?? 0, taxCode, taxRatePercent: rate });
  });
}

async function buildTransfer(ctx: BuildContext & { tool: ToolContext }, input: StockDocInput): Promise<{ draft: Draft; warnings: string[] }> {
  if (!input.warehouse || !input.to_warehouse) throw new DraftError("Give warehouse (from) and to_warehouse.");
  const warehouses = await cachedWarehouses(ctx.tool);
  const from = resolveWarehouse(warehouses, input.warehouse);
  const to = resolveWarehouse(warehouses, input.to_warehouse);
  if (str(from.mk_id) === str(to.mk_id)) throw new DraftError("warehouse and to_warehouse are the same.");
  if (!input.lines?.length) throw new DraftError("A transfer needs at least one product line.");
  const catalog = await loadCatalog(ctx.client, ctx.cache, ctx.today);
  const lines = input.lines.map((l, i) => {
    const n = i + 1;
    if (l.price !== undefined || l.vat_percent !== undefined || l.discount_percent !== undefined) throw new DraftError(`Line ${n}: a transfer has only products and quantities.`);
    let product: CatalogProduct | undefined = l.product_id ? catalog.get(l.product_id) : [...catalog.values()].find((p) => p.code === l.code);
    if (!product) throw new DraftError(`Line ${n}: no product ${l.product_id ?? l.code}.`);
    if (product.service) throw new DraftError(`Line ${n}: ${product.name} is a service; services aren't kept in stock.`);
    if (!(l.quantity! > 0)) throw new DraftError(`Line ${n}: quantity must be more than 0.`);
    product = product!;
    return priceLine({ product, quantity: l.quantity!, price: 0, discountPercent: 0, taxCode: "", taxRatePercent: 0 });
  });
  const sl = (input.language ?? "sl") === "sl";
  const payload: MkRecord = {
    doc_date: toMkDate(ctx.today),
    warehouseIdFrom: str(from.mk_id),
    warehouseIdTo: str(to.mk_id),
    ...(input.confirm ? { confirmed: "true" } : {}),
    product_list: lines.map((l) => ({ mk_id: l.productId, amount: String(l.quantity) })),
  };
  const draft = ctx.drafts.add({
    docType: "transfer_order",
    language: sl ? "sl" : "en",
    partner: { id: "", addressId: "" },
    docDate: ctx.today,
    lines,
    totals: { net: 0, tax: 0, gross: 0, currency: "EUR" },
    payload,
    summary: "",
    putEndpoint: "put_document_transfer_order",
  });
  draft.summary = [
    `${sl ? "Ustvari MEDSKLADIŠČNI PRENOS" : "Create a TRANSFER"} ${str(from.name)} → ${str(to.name)}${input.confirm ? (sl ? " (potrjen: premakne zalogo)" : " (confirmed: moves the stock)") : sl ? " (nepotrjen)" : " (not confirmed)"}`,
    "",
    ...lines.map((l, i) => `  ${i + 1}. ${l.quantity} × ${l.name}${l.unit ? ` ${l.unit}` : ""}`),
    "",
    [`${sl ? "Datum" : "Dated"} ${ctx.today}`, ...(ctx.installation ? [`Metakocka: ${ctx.installation}`] : [])].join(" · "),
  ].join("\n");
  return { draft, warnings: [] };
}
