/**
 * Domain-level operations on top of MetakockaClient. Tools call these; they
 * know Metakocka's endpoint names, paging rules and response shapes.
 */
import { MetakockaError, type BinaryResponse, type MetakockaClient } from "./client.js";
import type { DocType } from "./doc-types.js";
import { fromMkDate, toMkDate } from "./dates.js";
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

/**
 * Document types whose /search rejects doc_date_from / doc_date_to (offers: "cannot get beQueryParam";
 * complaints want last_change_from/to instead). Their dates are filtered here, over all matching documents.
 */
const NO_DATE_FILTER: ReadonlySet<DocType> = new Set<DocType>(["sales_offer", "complaint"]);
/** How many documents of such a type are read to filter them by date. */
const LOCAL_DATE_FILTER_MAX = 5000;
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
  if (!filtersDatesHere(search)) return searchPage(client, search);
  const inRange = await searchFilteringDates(client, search);
  const offset = Math.max(search.offset ?? 0, 0);
  const limit = Math.min(Math.max(search.limit ?? 25, 1), SEARCH_PAGE_MAX);
  return { totalRecords: inRange.length, offset, documents: inRange.slice(offset, offset + limit) };
}

const filtersDatesHere = (search: Pick<DocumentSearch, "docType" | "dateFrom" | "dateTo">) =>
  NO_DATE_FILTER.has(search.docType) && !!(search.dateFrom || search.dateTo);

/** Every document of a type Metakocka can't filter by date, read without the dates and filtered here. */
async function searchFilteringDates(client: MetakockaClient, search: Omit<DocumentSearch, "limit" | "offset">): Promise<MkRecord[]> {
  const { dateFrom, dateTo, ...rest } = search;
  const all: MkRecord[] = [];
  for (let at = 0; ; at += SEARCH_PAGE_MAX) {
    const page = await searchPage(client, { ...rest, limit: SEARCH_PAGE_MAX, offset: at });
    all.push(...page.documents);
    if (page.documents.length < SEARCH_PAGE_MAX || (page.totalRecords !== undefined && all.length >= page.totalRecords)) break;
    if (all.length >= LOCAL_DATE_FILTER_MAX) {
      throw new MetakockaError(
        `Metakocka can't filter ${search.docType} by date, and there are more than ${LOCAL_DATE_FILTER_MAX} of them to filter here. ` +
          "Narrow the search (e.g. by partner or text).",
      );
    }
  }
  return all.filter((d) => {
    const date = fromMkDate(d.doc_date);
    return !!date && (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo);
  });
}

async function searchPage(client: MetakockaClient, search: DocumentSearch): Promise<SearchPage> {
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
  if (filtersDatesHere(search)) {
    const inRange = await searchFilteringDates(client, search);
    const documents = inRange.slice(0, maxDocuments);
    onPage?.({ docType: search.docType, fetched: documents.length, total: inRange.length });
    return { documents, totalRecords: inRange.length, truncated: documents.length < inRange.length };
  }
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
 * Insert a document. Sent exactly once, never retried: Metakocka inserts a new
 * document on every put_document without an mk_id, so a retry after a timeout
 * could create a duplicate. The caller treats a network error as "outcome unknown".
 */
export async function putDocument(client: MetakockaClient, payload: MkRecord, timeoutMs: number): Promise<MkRecord> {
  return client.call("put_document", payload, { idempotent: false, timeoutMs });
}

/**
 * Attach a file to a document. This endpoint lives next to the API's base path
 * (/rest/eshop/add_attachment, not /rest/eshop/v1/...). Not retried: a retry
 * could attach the file twice.
 */
export async function addAttachment(client: MetakockaClient, docType: DocType, mkId: string, fileName: string, dataB64: string, timeoutMs: number): Promise<void> {
  await client.call("../add_attachment", { doc_type: docType, mk_id: mkId, attachment_list: [{ file_name: fileName, data_b64: dataB64 }] }, { idempotent: false, timeoutMs });
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

/** Closing balance of every bank account, from its last statement (get_bank_statement_status). */
export async function bankStatementStatus(client: MetakockaClient): Promise<MkRecord[]> {
  const response = await client.call("get_bank_statement_status");
  return asArray<MkRecord>(response.statement_list);
}

/** Every record of a paged json/ list endpoint dated in [dateFrom, dateTo], up to `max`. */
async function listDated(
  client: MetakockaClient,
  endpoint: string,
  listKey: string,
  q: { dateFrom: string; dateTo: string; max: number; extra?: MkRecord },
  onPage?: (fetched: number) => void,
): Promise<{ records: MkRecord[]; truncated: boolean }> {
  const records: MkRecord[] = [];
  while (records.length < q.max) {
    const limit = Math.min(BANK_PAGE_MAX, q.max - records.length);
    const response = await client.call(endpoint, {
      doc_date_from: toMkDate(q.dateFrom),
      doc_date_to: toMkDate(q.dateTo),
      limit,
      offset: records.length,
      ...q.extra,
    });
    const page = asArray<MkRecord>(response[listKey]);
    records.push(...page);
    onPage?.(records.length);
    if (page.length < limit) return { records, truncated: false };
  }
  return { records, truncated: true };
}

/** Compensations (kompenzacije): invoices settled against each other instead of paid. */
export function listCompensations(
  client: MetakockaClient,
  q: { dateFrom: string; dateTo: string; max: number },
  onPage?: (fetched: number) => void,
): Promise<{ records: MkRecord[]; truncated: boolean }> {
  return listDated(client, "json/get_bank_compensation", "result", q, onPage);
}

/** Cash register journals (blagajniški dnevniki), one per register and day, with their transactions. */
export function listCashRegisterJournals(
  client: MetakockaClient,
  q: { dateFrom: string; dateTo: string; max: number; cashRegister?: string },
  onPage?: (fetched: number) => void,
): Promise<{ records: MkRecord[]; truncated: boolean }> {
  const extra = q.cashRegister ? { cash_register: q.cashRegister } : undefined;
  return listDated(client, "json/cash_register_journal", "cash_register_journal_list", { ...q, extra }, onPage);
}

/**
 * Run an accounting export (izvoz za računovodstvo) with profiles defined in
 * Metakocka. Answers with a link to a ZIP file, valid for an hour. Metakocka
 * runs one export at a time and an export can take a while, so it is never
 * retried (a retry would only queue a second export).
 */
export async function accountingExport(
  client: MetakockaClient,
  q: { profiles: string[]; dateFrom: string; dateTo: string; attachments: boolean; timeoutMs: number },
): Promise<{ url: string; jobId?: string }> {
  let response: MkRecord;
  try {
    response = await client.call(
      "accounting_export",
      {
        profile_name_list: q.profiles,
        from_date: toMkDate(q.dateFrom),
        to_date: toMkDate(q.dateTo),
        export_attachment: String(q.attachments),
      },
      { idempotent: false, timeoutMs: q.timeoutMs },
    );
  } catch (error) {
    // An unknown profile name makes Metakocka fail with a bare NullPointerException.
    if (error instanceof MetakockaError && /NullPointerException/.test(error.message)) {
      throw new MetakockaError(
        `Metakocka could not run the export: ${error.message}. Usually a profile name is wrong — use the profile names ` +
          "(or ids) exactly as under Settings → Accounting export (Nastavitve → Izvoz v računovodstvo) in Metakocka.",
        error.oprCode,
      );
    }
    throw error;
  }
  const url = str(response.result_url);
  if (!url) throw new MetakockaError("Metakocka finished the export but returned no file.");
  return { url, jobId: str(response.job_id) };
}

/**
 * Partners on the company's blacklist (črna lista) matching an e-mail, phone
 * or name. Metakocka asks which of its users is searching (api_user_email).
 */
export async function searchBlacklist(
  client: MetakockaClient,
  q: { email?: string; phone?: string; name?: string; userEmail?: string },
): Promise<MkRecord[]> {
  try {
    const response = await client.call("search_blacklist_partner", {
      ...(q.userEmail ? { api_user_email: q.userEmail } : {}),
      ...(q.email ? { partner_email: q.email } : {}),
      ...(q.phone ? { partner_phone_number: q.phone } : {}),
      ...(q.name ? { partner_name: q.name } : {}),
    });
    return asArray<MkRecord>(response.partner_list);
  } catch (error) {
    if (error instanceof MetakockaError && error.oprCode === "1" && /internal server error/i.test(error.message)) {
      throw new MetakockaError(
        "Metakocka could not search the blacklist (internal server error). The blacklist (črna lista) is probably not in use " +
          "for this company" +
          (q.userEmail ? "" : ", or Metakocka needs the e-mail of one of its users: set METAKOCKA_USER_EMAIL") +
          ".",
        error.oprCode,
      );
    }
    throw error;
  }
}

/** SMS / Viber / WhatsApp threads, for one sales order or with inbound messages since a time. Lives at /rest/eshop/get_message. */
export async function getMessages(
  client: MetakockaClient,
  q: { type: "sms" | "viber" | "whatsapp"; docType?: string; docId?: string; inboundSince?: string },
): Promise<MkRecord[]> {
  const response = await client.call("../get_message", {
    type: q.type,
    ...(q.docId ? { doc_type: q.docType ?? "sales_order", doc_id: q.docId } : {}),
    ...(q.inboundSince ? { return_new_inbound_messages_from: q.inboundSince } : {}),
  });
  return asArray<MkRecord>(response.message_list);
}

/** The delivery service's proof of delivery for a sales order's parcel, as a file. Lives at /rest/eshop/get_proof_of_delivery. */
export function getProofOfDelivery(client: MetakockaClient, buyerOrder: string, trackingCode: string): Promise<BinaryResponse> {
  return client.callBinary("../get_proof_of_delivery", { buyer_order: buyerOrder, tracking_code: trackingCode });
}

/** Price lists of the delivery types (dostavne službe), all of them. */
export async function deliveryPriceLists(client: MetakockaClient): Promise<MkRecord[]> {
  const response = await client.call("get_delivery_service_pricelist");
  return asArray<MkRecord>(response.pricelist_list);
}

/**
 * Stock as kept in an external ERP (Navision, Vasco …), less today's invoices
 * and credit notes made in Metakocka.
 */
export async function sourceStock(client: MetakockaClient, q: { warehouseIds?: string[]; productIds?: string[] }): Promise<MkRecord[]> {
  const response = await client.call("source_stock", {
    ...(q.warehouseIds?.length ? { wh_id_list: q.warehouseIds.join(",") } : {}),
    ...(q.productIds?.length ? { product_mk_id_list: q.productIds.join(",") } : {}),
  });
  return asArray<MkRecord>(response.stock_list);
}

/** Metakocka answers progress checks of an asynchronous print at most once every 10 seconds. */
export const ASYNC_REPORT_POLL_MS = 10_500;

/**
 * Print a report asynchronously: start it, then check every 10 seconds until
 * Metakocka gives a download link (valid for a day). For print-outs that take
 * longer than a request may, and for links to share.
 */
export async function printReportAsync(
  client: MetakockaClient,
  q: { docId: string; reportId: string; maxWaitMs: number },
  options: { sleep?: (ms: number) => Promise<void>; onProgress?: (message: string) => void } = {},
): Promise<{ url: string; token: string }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const base = { mk_id: q.docId, report_id: q.reportId, async: "true", params: [{ type: "REPORT_TYPE", value: "PDF" }] };
  const started = await client.call("report", base);
  const token = str(started.token);
  if (!token) throw new MetakockaError("Metakocka did not start the print-out (no token).");
  for (let waited = 0; waited <= q.maxWaitMs; waited += ASYNC_REPORT_POLL_MS) {
    await sleep(ASYNC_REPORT_POLL_MS);
    const state = await client.call("report", { ...base, token });
    const url = str(state.url);
    if (url) return { url, token };
    const progress = str(state.progress);
    if (progress) options.onProgress?.(progress);
  }
  throw new MetakockaError(`The print-out is not ready after ${Math.round(q.maxWaitMs / 1000)} s; Metakocka is still working on it.`);
}

/** Delivery events (sent, delivered, opened, bounced …) of e-mails sent through send_message. Lives at /rest/eshop/get_email_events. */
export async function getEmailEvents(client: MetakockaClient, ids: string[]): Promise<MkRecord[]> {
  const response = await client.call("../get_email_events", { mk_id_list: ids });
  // Metakocka answers with a bare list, which the client hands over as { list }.
  return asArray<MkRecord>(response.list);
}
