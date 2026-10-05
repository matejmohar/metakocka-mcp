/**
 * Domain-level operations on top of MetakockaClient. Tools call these; they
 * know Metakocka's endpoint names, paging rules and response shapes.
 */
import type { MetakockaClient } from "./client.js";
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
  limit?: number; // max 100 per Metakocka call
  offset?: number;
}

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
  const response = await client.call("search", {
    doc_type: search.docType,
    result_type: "doc",
    limit,
    offset,
    ...(search.query ? { query: search.query } : {}),
    ...(filters.length ? { query_advance: filters } : {}),
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
    const exhausted =
      page.documents.length === 0 ||
      (totalRecords !== undefined ? offset >= totalRecords : page.documents.length < SEARCH_PAGE_MAX);
    if (exhausted) break;
  }
  const truncated = totalRecords !== undefined ? documents.length < totalRecords : documents.length >= maxDocuments;
  return { documents, totalRecords, truncated };
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
  includeStock?: boolean;
  includePrices?: boolean;
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
  if (q.productId || q.code || q.name) params.search_with_like = true;
  if (q.category) params.category = q.category;
  if (q.activeOnly) params.active = "true";
  if (q.salesOnly) params.sales = "true";
  if (q.includeStock) {
    params.return_warehause_stock = "true"; // sic — Metakocka's spelling
    params.return_free_amount = "true";
  }
  if (q.includePrices) {
    params.return_pricelist = "true";
    params.show_tax_factor = "true";
  }
  const response = await client.call("json/product_list", params);
  return { products: asArray<MkRecord>(response.product_list), offset, limit };
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
}

export async function searchPartners(client: MetakockaClient, q: PartnerQuery): Promise<MkRecord[]> {
  const params: MkRecord = {};
  if (q.partnerId) params.partner_id = q.partnerId;
  if (q.name) params.partner_name = q.name;
  if (q.taxNumber) params.partner_tax_number = q.taxNumber;
  if (q.email) params.partner_email = q.email;
  if (q.phone) params.partner_phone_number = q.phone;
  const response = await client.call("get_partner", params);
  return asArray<MkRecord>(response.partner_list);
}
