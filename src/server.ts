import { McpServer } from "@modelcontextprotocol/server";
import type { MetakockaClient } from "./client.js";
import { lazyClientFromEnv } from "./config.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerReportTools } from "./tools/reports.js";
import type { ToolContext } from "./tools/shared.js";
import { VERSION } from "./version.js";

export { MetakockaClient, MetakockaError } from "./client.js";

export interface CreateServerOptions {
  /** Supplies the API client; defaults to one built from environment variables. */
  getClient?: () => MetakockaClient;
  now?: () => Date;
}

const INSTRUCTIONS = [
  "Read-only access to one company's Metakocka ERP (Slovenian ERP / e-commerce back office).",
  "Documents: search_documents to find, get_document for full detail. Products: search_products, get_stock, list_warehouses.",
  "Partners: search_partners. Reports: get_unpaid_invoices (receivables/payables aging) and sales_summary (revenue).",
  "Dates are YYYY-MM-DD in the Europe/Ljubljana time zone. Amounts are in each document's currency.",
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
  registerReportTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
