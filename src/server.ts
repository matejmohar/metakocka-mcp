import { McpServer } from "@modelcontextprotocol/server";
import type { MetakockaClient } from "./client.js";
import { lazyClientFromEnv } from "./config.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerPartnerTools } from "./tools/partners.js";
import { registerReportTools } from "./tools/reports.js";
import type { ToolContext } from "./tools/shared.js";
import { registerStockTools } from "./tools/stock.js";
import { VERSION } from "./version.js";

export { MetakockaClient, MetakockaError } from "./client.js";

export interface CreateServerOptions {
  /** Supplies the API client; defaults to one built from environment variables. */
  getClient?: () => MetakockaClient;
  now?: () => Date;
}

const INSTRUCTIONS = [
  "Read-only access to one company's Metakocka ERP (Slovenian ERP / e-commerce back office).",
  "Documents: search_documents to find, get_document for full detail.",
  "Products: search_products to find, get_product for full detail. Stock: get_stock, low_stock (what to reorder), " +
    "stock_movements (one product's history), stock_valuation, list_warehouses.",
  "Partners: search_partners to find, get_partner for detail and open balance, partner_statement for their invoices and credit notes.",
  "Reports: get_unpaid_invoices (receivables/payables aging), sales_summary (revenue) and purchase_summary (spending); " +
    "both summaries take compare_to for period-over-period comparison in one call.",
  "Dates are YYYY-MM-DD in the Europe/Ljubljana time zone. Amounts are in each document's currency.",
  "Users may write in Slovenian: račun = invoice (izdani = issued/sales, prejeti = received/purchase), ponudba = offer, " +
    "naročilo = order, dobavnica = packing list, dobropis = credit note, zaloga = stock, skladišče = warehouse, " +
    "kupec = customer, dobavitelj = supplier, zapadlo / zapadli = overdue, neplačano = unpaid, davčna številka = tax number, " +
    "kartica partnerja = partner statement, kartica artikla = stock movements, varnostna zaloga = safety stock. " +
    "Reply in the language the user writes in.",
  "Metakocka runs searches one at a time per company, so prefer one well-filtered call over many small ones.",
].join(" ");

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: "metakocka", version: VERSION }, { instructions: INSTRUCTIONS });
  const ctx: ToolContext = {
    getClient: options.getClient ?? lazyClientFromEnv(),
    now: options.now ?? (() => new Date()),
  };
  registerDocumentTools(server, ctx);
  registerCatalogTools(server, ctx);
  registerStockTools(server, ctx);
  registerPartnerTools(server, ctx);
  registerReportTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
