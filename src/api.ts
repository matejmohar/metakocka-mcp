/**
 * Domain-level operations on top of MetakockaClient. Tools call these; they
 * know Metakocka's endpoint names, paging rules and response shapes.
 */
import { MetakockaError, type MetakockaClient } from "./client.js";
import type { DocType } from "./doc-types.js";
import { toMkDate } from "./dates.js";
import { asArray, num, str } from "./util.js";

export type MkRecord = Record<string, unknown>;

export interface AdvancedFilter {
  type: string;
  value: string;
}

export interface DocumentSearch {
  docType: DocType;
  query?: string;
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string; // YYYY-MM-DD
  filters?: AdvancedFilter[];
  /** Invoices: include each payment with its date (mark_paid). Costs nothing extra. */
  paymentDetail?: boolean;
  limit?: number; // max 100 per Metakocka call
  offset?: number;
}

/** Called after every page fetched by the multi-page searches, e.g. to report progress. */
export type OnPage = (info: { docType: DocType; fetched: number; total: number | undefined }) => void;

export interface SearchPage {
  totalRecords: number | undefined;
  offset: number;
  documents: MkRecord[];
}

export const SEARCH_PAGE_MAX = 100;
export const PRODUCT_PAGE_MAX = 1000;

export function buildSearchFilters(search: DocumentSearch): AdvancedFilter[] {
  const filters: AdvancedFilter[] = [];
  if (search.dateFrom) filters.push({ type: "doc_date_from", value: toMkDate(search.dateFrom) });
  if (search.dateTo) filters.push({ type: "doc_date_to", value: toMkDate(search.dateTo) });
  filters.push(...(search.filters ?? []));
  return filters;
}

/** One page of full documents from /search. */
export async function searchDocuments(client: MetakockaClient, search: DocumentSearch): Promise<SearchPage> {
  const limit = Math.min(Math.max(search.limit ?? 25, 1), SEARCH_PAGE_MAX);
  const offset = Math.max(search.offset ?? 0, 0);
  const filters = buildSearchFilters(search);
  const response = await client
    .call("search", {
      doc_type: search.docType,
      result_type: "doc",
      limit,
      offset,
      ...(search.query ? { query: search.query } : {}),
      ...(filters.length ? { query_advance: filters } : {}),
      ...(search.paymentDetail ? { show_payment_detail: "true" } : {}),
    })
    .catch((error: unknown) => {
      // Complaint searches answer "No complaints found" (opr_code 6) instead of an empty result.
      if (error instanceof MetakockaError && error.oprCode === "6" && /no \w+ found/i.test(error.message)) {
        return { result_all_records: "0", result: [] } as MkRecord;
      }
      throw error;
    });
  return {
    totalRecords: num(response.result_all_records),
    offset,
    documents: asArray<MkRecord>(response.result),
  };
}

/**
 * Fetch every matching document up to `maxDocuments`, page by page.
 * Returns `truncated: true` when more documents exist than were fetched.
 */
export async function searchAllDocuments(
  client: MetakockaClient,
  search: Omit<DocumentSearch, "limit" | "offset">,
  maxDocuments: number,
  onPage?: OnPage,
): Promise<{ documents: MkRecord[]; totalRecords: number | undefined; truncated: boolean }> {
  const documents: MkRecord[] = [];
  let totalRecords: number | undefined;
  let offset = 0;
  while (documents.length < maxDocuments) {
    const page = await searchDocuments(client, {
      ...search,
      limit: Math.min(SEARCH_PAGE_MAX, maxDocuments - documents.length),
      offset,
    });
    totalRecords = page.totalRecords ?? totalRecords;
    documents.push(...page.documents);
    offset += page.documents.length;
    onPage?.({ docType: search.docType, fetched: documents.length, total: totalRecords });
    const exhausted =
      page.documents.length === 0 ||
      (totalRecords !== undefined ? offset >= totalRecords : page.documents.length < SEARCH_PAGE_MAX);
    if (exhausted) break;
  }
  const truncated = totalRecords !== undefined ? documents.length < totalRecords : documents.length >= maxDocuments;
  return { documents, totalRecords, truncated };
}

/** searchAllDocuments for several document types, one after another. */
export async function searchAcrossTypes(
  client: MetakockaClient,
  docTypes: readonly DocType[],
  search: Omit<DocumentSearch, "docType" | "limit" | "offset">,
  maxDocumentsPerType: number,
  onPage?: OnPage,
): Promise<{ documents: MkRecord[]; truncatedTypes: DocType[] }> {
  const documents: MkRecord[] = [];
  const truncatedTypes: DocType[] = [];
  for (const docType of docTypes) {
    const result = await searchAllDocuments(client, { ...search, docType }, maxDocumentsPerType, onPage);
    if (result.truncated) truncatedTypes.push(docType);
    // Some doc types come back without doc_type on each record; callers rely on it.
    documents.push(...result.documents.map((d) => (d.doc_type ? d : { ...d, doc_type: docType })));
  }
  return { documents, truncatedTypes };
}

export async function getDocument(
  client: MetakockaClient,
  docType: DocType,
  docId: string,
  extra: Record<string, string> = {},
): Promise<MkRecord> {
  return client.call("get_document", { doc_type: docType, doc_id: docId, ...extra });
}

/**
 * Find a document by its number as shown in Metakocka (count_code, e.g.
 * "PP-18495" or "1-MK-2344"). Returns undefined when there's no exact match.
 */
export async function findDocumentIdByNumber(
  client: MetakockaClient,
  docType: DocType,
  number: string,
): Promise<string | undefined> {
  const response = await client.call("search", { doc_type: docType, query: number, limit: 50, offset: 0 });
  const wanted = number.trim().toLowerCase();
  const hit = asArray<MkRecord>(response.result).find((r) => str(r.count_code)?.toLowerCase() === wanted);
  return hit ? str(hit.mk_id) : undefined;
}

export async function discoverSearchFilters(client: MetakockaClient, docType?: DocType): Promise<MkRecord> {
  const response = await client.call("search_query_advance_discovery", docType ? { doc_type: docType } : {});
  const { opr_code: _code, opr_time_ms: _time, ...rest } = response;
  return rest;
}

export interface ProductQuery {
  name?: string;
  code?: string;
  productId?: string;
  category?: string;
  activeOnly?: boolean;
  salesOnly?: boolean;
  /** Leave out services (products that are never on stock). */
  goodsOnly?: boolean;
  /** Match product_id / code / name exactly instead of partially. */
  exact?: boolean;
  includeStock?: boolean;
  includePrices?: boolean;
  /** Reservations per warehouse (reservation_detail). */
  includeReservations?: boolean;
  /** Ordered from suppliers but not yet received (order_in_delivery). */
  includeIncoming?: boolean;
  includeLastPurchasePrice?: boolean;
  /** Bill of materials / norm (compounds). */
  includeCompound?: boolean;
  includeCategories?: boolean;
  limit?: number;
  offset?: number;
}

export async function listProducts(
  client: MetakockaClient,
  q: ProductQuery,
): Promise<{ products: MkRecord[]; offset: number; limit: number }> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), PRODUCT_PAGE_MAX);
  const offset = Math.max(q.offset ?? 0, 0);
  const params: MkRecord = { limit, offset };
  // Metakocka's LIKE search matches on one of count_code / code / title.
  if (q.productId) params.count_code = q.productId;
  else if (q.code) params.code = q.code;
  else if (q.name) params.title = q.name;
  if ((q.productId || q.code || q.name) && !q.exact) params.search_with_like = true;
  if (q.category) params.category = q.category;
  if (q.activeOnly) params.active = "true";
  if (q.salesOnly) params.sales = "true";
  if (q.goodsOnly) params.service = "false";
  if (q.includeStock) {
    params.return_warehause_stock = "true"; // sic — Metakocka's spelling
    params.return_free_amount = "true";
  }
  if (q.includePrices) {
    params.return_pricelist = "true";
    params.show_tax_factor = "true";
  }
  if (q.includeReservations) params.return_warehouse_reservation = "true";
  if (q.includeIncoming) params.return_expect_order_delivery_date = "true";
  if (q.includeLastPurchasePrice) params.return_last_purchase_price = "true";
  if (q.includeCompound) params.return_product_compound = "true";
  if (q.includeCategories) params.return_category = "true";
  const response = await client.call("json/product_list", params);
  return { products: asArray<MkRecord>(response.product_list), offset, limit };
}

/** Every matching product up to `maxProducts`, 1000 per call. */
export async function listAllProducts(
  client: MetakockaClient,
  q: Omit<ProductQuery, "limit" | "offset">,
  maxProducts: number,
): Promise<{ products: MkRecord[]; truncated: boolean }> {
  const products: MkRecord[] = [];
  while (products.length < maxProducts) {
    const limit = Math.min(PRODUCT_PAGE_MAX, maxProducts - products.length);
    const page = await listProducts(client, { ...q, limit, offset: products.length });
    products.push(...page.products);
    // product_list has no total count: a short page is the last one.
    if (page.products.length < limit) return { products, truncated: false };
  }
  return { products, truncated: true };
}

export interface StockQuery {
  productCodes?: string[];
  warehouseIds?: string[];
  limit?: number;
  offset?: number;
}

export async function getStock(
  client: MetakockaClient,
  q: StockQuery,
): Promise<{ rows: MkRecord[]; offset: number; limit: number }> {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), PRODUCT_PAGE_MAX);
  const offset = Math.max(q.offset ?? 0, 0);
  const params: MkRecord = { limit, offset };
  if (q.productCodes?.length) params.product_code_list = q.productCodes.join(",");
  if (q.warehouseIds?.length) params.wh_id_list = q.warehouseIds.join(",");
  const response = await client.call("json/warehouse_stock", params);
  return { rows: asArray<MkRecord>(response.stock_list), offset, limit };
}

export async function listWarehouses(client: MetakockaClient): Promise<MkRecord[]> {
  const response = await client.call("json/warehouse_list", {});
  return asArray<MkRecord>(response.warehouse_list);
}

export interface PartnerQuery {
  name?: string;
  taxNumber?: string;
  email?: string;
  phone?: string;
  partnerId?: string;
  /** Include the partner's discounts per product category. */
  withDiscounts?: boolean;
}

export async function searchPartners(client: MetakockaClient, q: PartnerQuery): Promise<MkRecord[]> {
  const params: MkRecord = {};
  if (q.withDiscounts) params.show_partner_discount = "true";
  if (q.partnerId) params.partner_id = q.partnerId;
  if (q.name) params.partner_name = q.name;
  if (q.taxNumber) params.partner_tax_number = q.taxNumber;
  if (q.email) params.partner_email = q.email;
  if (q.phone) params.partner_phone_number = q.phone;
  const response = await client.call("get_partner", params);
  return asArray<MkRecord>(response.partner_list);
}

/** Report 38 is Metakocka's standard invoice print-out (sales and purchase invoices). */
export const INVOICE_REPORT_ID = "38";

/** A document printed as PDF, as Metakocka would print it from the app. */
export async function printDocumentPdf(client: MetakockaClient, docId: string, reportId: string): Promise<Uint8Array> {
  const { bytes } = await client.callBinary("report", {
    mk_id: docId,
    report_id: reportId,
    params: [{ type: "REPORT_TYPE", value: "PDF" }],
  });
  return bytes;
}

/** The sales order a parcel (or return parcel) tracking code or sticker number belongs to. */
export async function findByTrackingCode(
  client: MetakockaClient,
  q: { trackingCode?: string; stickerCode?: string },
): Promise<MkRecord> {
  const { opr_code: _c, opr_time_ms: _t, opr_time_no_lock_ms: _t2, ...rest } = await client.call("search_tracking_code", {
    ...(q.trackingCode ? { tracking_code: q.trackingCode } : {}),
    ...(q.stickerCode ? { sticker_code: q.stickerCode } : {}),
  });
  return rest;
}

export const BANK_PAGE_MAX = 100;

/** Bank statements (izpiski) with their transactions, dated in [dateFrom, dateTo]. */
export async function listBankStatements(
  client: MetakockaClient,
  q: { dateFrom: string; dateTo: string; maxStatements: number },
  onPage?: (fetched: number) => void,
): Promise<{ statements: MkRecord[]; truncated: boolean }> {
  const statements: MkRecord[] = [];
  while (statements.length < q.maxStatements) {
    const limit = Math.min(BANK_PAGE_MAX, q.maxStatements - statements.length);
    const response = await client.call("json/get_bank_statement", {
      doc_date_from: toMkDate(q.dateFrom),
      doc_date_to: toMkDate(q.dateTo),
      limit,
      offset: statements.length,
    });
    const page = asArray<MkRecord>(response.result);
    statements.push(...page);
    onPage?.(statements.length);
    if (page.length < limit) return { statements, truncated: false };
  }
  return { statements, truncated: true };
}
