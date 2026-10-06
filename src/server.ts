import { McpServer } from "@modelcontextprotocol/server";
import type { MetakockaClient } from "./client.js";
import { TtlCache } from "./cache.js";
import { baseUrlFromEnv, cacheTtlMs, lazyClientFromEnv } from "./config.js";
import { describeInstallation } from "./installation.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerBankTools } from "./tools/bank.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerDocumentTools } from "./tools/documents.js";
import { registerPartnerTools } from "./tools/partners.js";
import { registerReportTools } from "./tools/reports.js";
import type { ToolContext } from "./tools/shared.js";
import { registerStockTools } from "./tools/stock.js";
import { registerWriteTools, type WriteContext } from "./tools/write.js";
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
  /** The API base URL the client talks to, named in the instructions when it isn't main.metakocka.si. Defaults to METAKOCKA_BASE_URL. */
  baseUrl?: string;
  /**
   * How get_document_pdf hands over the PDF: "file" saves it on this computer
   * (stdio, the default); "embedded" returns it inside the tool result, for
   * the HTTP server, whose disk the user can't reach.
   */
  pdfDelivery?: "file" | "embedded";
  /**
   * Turns on the opt-in tools that create documents (METAKOCKA_WRITE). Create
   * it once and pass the same one to every server instance, because drafts
   * must survive between requests. Without it the server is read-only.
   */
  write?: WriteContext;
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

/** Tells the model when it is not looking at the public installation, so it doesn't present test data as real figures. */
export function installationNote(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  const info = describeInstallation(baseUrl);
  if (info.isDefault) return undefined;
  return (
    `This server is connected to the Metakocka installation at ${info.host}, not the public main.metakocka.si. ` +
    "It may be a test, development or company-internal installation: say which installation the data comes from " +
    "when it matters, and don't present it as production data unless the user says it is."
  );
}

function urlFromEnvIfValid(): string | undefined {
  try {
    return baseUrlFromEnv();
  } catch {
    return undefined; // the tools report the bad setting on their first call
  }
}

/** Replaces the "Read-only" opening of the instructions when the write tools are on. */
export function writeInstructions(confirm: "client" | "elicitation" | "never", docTypes: readonly string[] = ["sales_offer"]): string {
  const what = [
    docTypes.includes("sales_offer") && "offers (ponudba / predračun)",
    docTypes.some((t) => t.startsWith("sales_bill_")) && "invoices (račun, saved not issued; also from an offer)",
  ].filter(Boolean);
  return (
    "Access to one company's Metakocka ERP (Slovenian ERP / e-commerce back office): it reads data, and it can create " +
    `${what.join(" and ")}. To create one: find the partner (search_partners) and products (search_products) and use ` +
    "their ids — never guess ids and never create partners or products; call draft_document, show its summary to the user, " +
    "then commit_document. " +
    (confirm === "never"
      ? "Save a document only after the user has agreed to its summary in the conversation. "
      : "The user confirms every document in their client" +
        (confirm === "client" ? "; pass the draft's summary as confirm_summary, copied exactly. " : ". ")) +
    "If commit_document reports an unknown outcome, call it again with the same draft_id instead of drafting the document again."
  );
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const note = installationNote(options.baseUrl ?? urlFromEnvIfValid());
  let instructions = note ? `${INSTRUCTIONS} ${note}` : INSTRUCTIONS;
  if (options.write) {
    instructions = instructions.replace(INSTRUCTIONS.slice(0, INSTRUCTIONS.indexOf(" Documents:")), writeInstructions(options.write.settings.confirm, options.write.settings.docTypes));
  }
  const server = new McpServer({ name: "metakocka", version: VERSION }, { instructions });
  const ctx: ToolContext = {
    getClient: options.getClient ?? lazyClientFromEnv(),
    now: options.now ?? (() => new Date()),
    cache: options.cache ?? new TtlCache(cacheTtlMs()),
    pdfDir: options.pdfDir,
    pdfDelivery: options.pdfDelivery ?? "file",
  };
  registerDocumentTools(server, ctx);
  registerCatalogTools(server, ctx);
  registerStockTools(server, ctx);
  registerPartnerTools(server, ctx);
  registerReportTools(server, ctx);
  registerBankTools(server, ctx);
  if (options.write) registerWriteTools(server, ctx, options.write);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}
