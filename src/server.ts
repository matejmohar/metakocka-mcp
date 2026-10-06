import { McpServer } from "@modelcontextprotocol/server";
import type { MetakockaClient } from "./client.js";
import { TtlCache } from "./cache.js";
import { cacheTtlMs, lazyClientFromEnv } from "./config.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerBankTools } from "./tools/bank.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerPartnerTools } from "./tools/partners.js";
import { registerReportTools } from "./tools/reports.js";
import type { ToolContext } from "./tools/shared.js";
import { registerStockTools } from "./tools/stock.js";
import { VERSION } from "./version.js";

export { TtlCache } from "./cache.js";
export { MetakockaClient, MetakockaError } from "./client.js";

export interface CreateServerOptions {
  /** Supplies the API client; defaults to one built from environment variables. */
  getClient?: () => MetakockaClient;
  now?: () => Date;
  /**
   * Cache for warehouses and partner lookups. Pass one to share it between
   * server instances (an HTTP host creating a server per request); by default
   * each server has its own, kept for METAKOCKA_CACHE_SECONDS (5 minutes).
   */
  cache?: TtlCache;
  /** Where get_document_pdf saves files; defaults to METAKOCKA_PDF_DIR or Downloads/Metakocka. */
  pdfDir?: string;
}

const INSTRUCTIONS = [
  "Read-only access to one company's Metakocka ERP (Slovenian ERP / e-commerce back office).",
  "Documents: search_documents to find, get_document for full detail (also complaints / reklamacije: doc_type complaint), " +
    "get_document_pdf to save an invoice as PDF, find_by_tracking_code for the order behind a parcel.",
  "Products: search_products to find, get_product for full detail. Stock: get_stock, low_stock (what to reorder), " +
    "stock_movements (one product's history), stock_valuation, list_warehouses.",
  "Partners: search_partners to find, get_partner for detail and open balance, partner_statement for their invoices, " +
    "credit notes and dated payments (and how late they pay).",
  "Reports: get_unpaid_invoices (receivables/payables aging), sales_summary (revenue) and purchase_summary (spending); " +
    "both summaries take compare_to for period-over-period comparison and a partner to look at one customer or supplier. " +
    "Bank: get_bank_statements (money in and out).",
  "Dates are YYYY-MM-DD in the Europe/Ljubljana time zone. Amounts are in each document's currency.",
  "Users may write in Slovenian: račun = invoice (izdani = issued/sales, prejeti = received/purchase), ponudba = offer, " +
    "naročilo = order, dobavnica = packing list, dobropis = credit note, zaloga = stock, skladišče = warehouse, " +
    "kupec = customer, dobavitelj = supplier, zapadlo / zapadli = overdue, neplačano = unpaid, davčna številka = tax number, " +
    "kartica partnerja = partner statement, kartica artikla = stock movements, varnostna zaloga = safety stock, " +
    "izpisek = bank statement, reklamacija = complaint, številka pošiljke = tracking code. " +
    "Reply in the language the user writes in.",
  "Metakocka runs searches one at a time per company, so prefer one well-filtered call over many small ones.",
].join(" ");

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: "metakocka", version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = {
    getClient: options.getClient ?? lazyClientFromEnv(),
    now: options.now ?? (() => new Date()),
    cache: options.cache ?? new TtlCache(cacheTtlMs()),
    pdfDir: options.pdfDir,
  };
  registerDocumentTools(server, ctx);
  registerCatalogTools(server, ctx);
  registerStockTools(server, ctx);
  registerPartnerTools(server, ctx);
  registerReportTools(server, ctx);
  registerBankTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
