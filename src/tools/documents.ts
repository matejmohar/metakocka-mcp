import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  discoverSearchFilters,
  findDocumentIdByNumber,
  getDocument,
  searchDocuments,
  type AdvancedFilter,
} from "../api.js";
import { MetakockaError } from "../client.js";
import { isIsoDate } from "../dates.js";
import { DOC_TYPE_VALUES, isInvoiceType } from "../doc-types.js";
import { cleanDocument, summarizeDocument } from "../summarize.js";
import { list } from "../util.js";
import { READ_ONLY, run, type ToolContext } from "./shared.js";

export const docTypeSchema = z
  .enum(DOC_TYPE_VALUES)
  .describe(
    "Metakocka document type. Common ones: sales_offer (ponudba), sales_order (prodajno naročilo), " +
      "sales_bill_domestic / sales_bill_foreign / sales_bill_retail (izdani računi), sales_bill_credit_note (dobropis), " +
      "purchase_order (naročilnica), purchase_bill_domestic / purchase_bill_foreign (prejeti računi), " +
      "warehouse_packing_list (dobavnica), warehouse_acceptance_note (prevzemnica), workorder (delovni nalog).",
  );

export const isoDate = z
  .string()
  .refine(isIsoDate, "Use the format YYYY-MM-DD, e.g. 2026-09-30")
  .describe("Date as YYYY-MM-DD");

export function registerDocumentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        "Search Metakocka documents (dokumenti: offers, sales orders, invoices, purchase documents, warehouse documents, work orders) " +
        "of one type. Returns a compact summary per document: number, date, partner, status, totals, amount paid, due date. " +
        "Use get_document for the full document with its line items. Results are paged (max 100 per call): " +
        "use next_offset to continue.",
      inputSchema: z.object({
        doc_type: docTypeSchema,
        query: z
          .string()
          .optional()
          .describe("Free-text search, same as the search box in Metakocka (partner name, document number, …)."),
        date_from: isoDate.optional().describe("Only documents dated on or after this date (YYYY-MM-DD)."),
        date_to: isoDate.optional().describe("Only documents dated on or before this date (YYYY-MM-DD)."),
        partner_tax_number: z.string().optional().describe("Only documents for the partner with this tax number, e.g. SI12345678."),
        status: z
          .string()
          .optional()
          .describe(
            "Comma-separated status names as configured in this company's Metakocka (e.g. 'draft,ready_to_ship'). " +
              "Supported for sales orders and warehouse documents.",
          ),
        unpaid_only: z.boolean().optional().describe("Invoices only: return only documents that are not fully paid."),
        product_codes: z
          .string()
          .optional()
          .describe("Sales orders only: comma-separated product codes; returns orders containing any of them."),
        extra_filters: z
          .array(z.object({ type: z.string(), value: z.string() }))
          .optional()
          .describe(
            "Additional Metakocka 'advanced search' filters as {type, value} pairs. " +
              "Call list_search_filters to see which types a document type supports.",
          ),
        limit: z.number().int().min(1).max(100).default(25).describe("Documents per page (1–100)."),
        offset: z.number().int().min(0).default(0).describe("Paging offset; use next_offset from the previous call."),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const filters: AdvancedFilter[] = [];
        if (args.partner_tax_number) filters.push({ type: "partner_tax_num", value: args.partner_tax_number });
        if (args.status) filters.push({ type: "status_list", value: list(args.status).join(",") });
        if (args.unpaid_only) {
          if (!isInvoiceType(args.doc_type)) {
            throw new MetakockaError(`unpaid_only works only for invoice types, not ${args.doc_type}.`);
          }
          filters.push({ type: "payment_status", value: "false" });
        }
        if (args.product_codes) filters.push({ type: "product_code_list", value: list(args.product_codes).join(",") });
        filters.push(...(args.extra_filters ?? []));

        const page = await searchDocuments(ctx.getClient(), {
          docType: args.doc_type,
          query: args.query,
          dateFrom: args.date_from,
          dateTo: args.date_to,
          filters,
          limit: args.limit,
          offset: args.offset,
        });
        const nextOffset = page.offset + page.documents.length;
        const hasMore =
          page.totalRecords !== undefined ? nextOffset < page.totalRecords : page.documents.length === args.limit;
        return {
          doc_type: args.doc_type,
          total_matching: page.totalRecords,
          returned: page.documents.length,
          offset: page.offset,
          ...(hasMore ? { next_offset: nextOffset } : {}),
          documents: page.documents.map(summarizeDocument),
        };
      }),
  );

  server.registerTool(
    "get_document",
    {
      title: "Get document",
      description:
        "Get one Metakocka document in full: partner and receiver, line items (products, quantities, prices, discounts, tax), " +
        "totals, payment status, linked documents. Identify it either by its internal id (from search_documents) or by " +
        "its number as shown in Metakocka (e.g. 'PP-18495').",
      inputSchema: z
        .object({
          doc_type: docTypeSchema,
          id: z.string().optional().describe("Internal Metakocka id (mk_id / 'id' in search results)."),
          number: z.string().optional().describe("Document number as shown in Metakocka, e.g. 'PP-18495' or '1-MK-2344'."),
          include_payments: z
            .boolean()
            .default(false)
            .describe("Invoices only: include individual payments (date, amount, method)."),
        })
        .refine((a) => a.id || a.number, { message: "Provide either id or number." }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const client = ctx.getClient();
        const id = args.id ?? (await findDocumentIdByNumber(client, args.doc_type, args.number!));
        if (!id) {
          throw new MetakockaError(
            `No ${args.doc_type} with number "${args.number}" was found. Check the document type, or use search_documents.`,
          );
        }
        const extra: Record<string, string> = {};
        if (args.include_payments && isInvoiceType(args.doc_type)) {
          extra.show_payment_detail = "true";
          extra.show_last_payment_date = "true";
        }
        return cleanDocument(await getDocument(client, args.doc_type, id, extra));
      }),
  );

  server.registerTool(
    "list_search_filters",
    {
      title: "List search filters",
      description:
        "List the advanced search filters Metakocka supports (per document type), for use in search_documents' extra_filters. " +
        "Each entry has a type, a label as shown in Metakocka, and a description of the expected value.",
      inputSchema: z.object({
        doc_type: docTypeSchema.optional().describe("Limit the list to one document type (recommended)."),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => discoverSearchFilters(ctx.getClient(), args.doc_type)),
  );
}
