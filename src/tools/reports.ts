import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { agingReport, salesSummary, toOpenInvoice, type OpenInvoice } from "../analytics.js";
import { searchAllDocuments, type MkRecord } from "../api.js";
import { MetakockaError } from "../client.js";
import { daysBetween, todayInLjubljana } from "../dates.js";
import { INVOICE_TYPES, SALES_INVOICE_TYPES } from "../doc-types.js";
import { READ_ONLY, run, type ToolContext } from "./shared.js";
import { isoDate } from "./documents.js";

const invoiceTypeSchema = z.enum(INVOICE_TYPES);

export function registerReportTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_unpaid_invoices",
    {
      title: "Unpaid invoices",
      description:
        "Open (unpaid or partly paid) invoices with amount still owed, due date and days overdue, plus totals per currency, " +
        "an aging breakdown (not due, 1–30, 31–60, 61–90, 90+ days) and the partners who owe the most. " +
        "Defaults to issued sales invoices (receivables); pass purchase invoice types for payables.",
      inputSchema: z.object({
        doc_types: z
          .array(invoiceTypeSchema)
          .min(1)
          .default(["sales_bill_domestic", "sales_bill_foreign"])
          .describe("Invoice types to include."),
        date_from: isoDate.optional().describe("Only invoices dated on or after this date."),
        date_to: isoDate.optional().describe("Only invoices dated on or before this date."),
        partner_tax_number: z.string().optional().describe("Only this partner (tax number, e.g. SI12345678)."),
        overdue_only: z.boolean().default(false).describe("Only invoices past their due date."),
        min_days_overdue: z.number().int().min(0).default(0).describe("Only invoices at least this many days overdue."),
        max_invoices_listed: z.number().int().min(0).max(500).default(50).describe("How many individual invoices to list (most overdue first). Totals always cover all."),
        max_documents: z.number().int().min(1).max(5000).default(1000).describe("Safety cap on documents fetched from Metakocka per type."),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const client = ctx.getClient();
        const today = todayInLjubljana(ctx.now());
        const filters = [{ type: "payment_status", value: "false" }];
        if (args.partner_tax_number) filters.push({ type: "partner_tax_num", value: args.partner_tax_number });

        let invoices: OpenInvoice[] = [];
        const truncatedTypes: string[] = [];
        for (const docType of args.doc_types) {
          const result = await searchAllDocuments(
            client,
            { docType, dateFrom: args.date_from, dateTo: args.date_to, filters },
            args.max_documents,
          );
          if (result.truncated) truncatedTypes.push(docType);
          invoices.push(...result.documents.map((d: MkRecord) => toOpenInvoice(d, today)).filter((i) => i !== undefined));
        }

        const minDays = Math.max(args.min_days_overdue, args.overdue_only ? 1 : 0);
        if (minDays > 0) invoices = invoices.filter((i) => i.days_overdue >= minDays);
        invoices.sort((a, b) => b.days_overdue - a.days_overdue || b.open_amount - a.open_amount);

        const report = agingReport(invoices);
        return {
          as_of: today,
          invoice_count: invoices.length,
          ...report,
          top_partners: report.top_partners.slice(0, 15),
          invoices: invoices.slice(0, args.max_invoices_listed),
          ...(invoices.length > args.max_invoices_listed
            ? { invoices_not_listed: invoices.length - args.max_invoices_listed }
            : {}),
          ...(truncatedTypes.length
            ? {
                warning: `More documents matched than max_documents for: ${truncatedTypes.join(", ")}. ` +
                  "Totals are incomplete — narrow the date range or raise max_documents.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "sales_summary",
    {
      title: "Sales summary",
      description:
        "Revenue for a period from issued invoices: net and gross totals per currency, grouped by partner, product, " +
        "month or document type (top N). Use it for questions like 'top customers this year', 'best-selling products " +
        "last month' or 'monthly revenue in 2026'. Credit notes are not subtracted.",
      inputSchema: z.object({
        date_from: isoDate.describe("Start of the period (inclusive), YYYY-MM-DD."),
        date_to: isoDate.describe("End of the period (inclusive), YYYY-MM-DD."),
        group_by: z.enum(["partner", "product", "month", "document_type"]).default("partner"),
        doc_types: z
          .array(invoiceTypeSchema)
          .min(1)
          .default([...SALES_INVOICE_TYPES])
          .describe("Invoice types counted as sales."),
        top: z.number().int().min(1).max(200).default(20).describe("How many groups to return (ignored for month)."),
        max_documents: z.number().int().min(1).max(10000).default(3000).describe("Safety cap on documents fetched per type."),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        if (daysBetween(args.date_from, args.date_to) < 0) {
          throw new MetakockaError("date_from must be on or before date_to.");
        }
        const client = ctx.getClient();
        const docs: MkRecord[] = [];
        const truncatedTypes: string[] = [];
        for (const docType of args.doc_types) {
          const result = await searchAllDocuments(
            client,
            { docType, dateFrom: args.date_from, dateTo: args.date_to },
            args.max_documents,
          );
          if (result.truncated) truncatedTypes.push(docType);
          docs.push(...result.documents);
        }
        return {
          period: { from: args.date_from, to: args.date_to },
          doc_types: args.doc_types,
          ...salesSummary(docs, args.group_by, args.top),
          ...(args.group_by === "product"
            ? { note: "Product values are net of line discounts but before document-level discounts." }
            : {}),
          ...(truncatedTypes.length
            ? {
                warning: `More documents matched than max_documents for: ${truncatedTypes.join(", ")}. ` +
                  "Totals are incomplete — shorten the period or raise max_documents.",
              }
            : {}),
        };
      }),
  );
}
