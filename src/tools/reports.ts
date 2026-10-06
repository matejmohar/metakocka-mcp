import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { agingReport, compareSummaries, salesSummary, toOpenInvoice, type OpenInvoice } from "../analytics.js";
import { searchAcrossTypes, type AdvancedFilter, type MkRecord } from "../api.js";
import { MetakockaError } from "../client.js";
import { daysBetween, previousPeriod, samePeriodLastYear, todayInLjubljana } from "../dates.js";
import { INVOICE_TYPES, PURCHASE_INVOICE_TYPES, SALES_INVOICE_TYPES, type DocType } from "../doc-types.js";
import { resolvePartner } from "./partners.js";
import { progressReporter, READ_ONLY, run, truncationWarning, type ToolContext } from "./shared.js";
import { isoDate } from "./documents.js";

const invoiceTypeSchema = z.enum(INVOICE_TYPES);

export function registerReportTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_unpaid_invoices",
    {
      title: "Unpaid invoices",
      description:
        "Open (unpaid or partly paid; neplačani / zapadli računi, terjatve, obveznosti) invoices with amount still owed, due date and days overdue, plus totals per currency, " +
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
    async (args, extra) =>
      run(async () => {
        const client = ctx.getClient();
        const progress = progressReporter(extra);
        const today = todayInLjubljana(ctx.now());
        const filters = [{ type: "payment_status", value: "false" }];
        if (args.partner_tax_number) filters.push({ type: "partner_tax_num", value: args.partner_tax_number });

        const found = await searchAcrossTypes(
          client,
          args.doc_types,
          { dateFrom: args.date_from, dateTo: args.date_to, filters },
          args.max_documents,
          ({ docType, fetched, total }) => progress(`Read ${fetched}${total ? ` of ${total}` : ""} ${docType} documents`),
        );
        let invoices = found.documents
          .map((d: MkRecord) => toOpenInvoice(d, today))
          .filter((i): i is OpenInvoice => i !== undefined);

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
          ...truncationWarning(found.truncatedTypes, "narrow the date range or raise max_documents"),
        };
      }),
  );

  registerSummaryTool(server, ctx, {
    name: "sales_summary",
    title: "Sales summary",
    description:
      "Revenue (promet, prihodki) for a period from issued invoices: net and gross totals per currency, grouped by partner, product, " +
      "month or document type (top N). Use it for questions like 'top customers this year', 'best-selling products " +
      "last month' or 'monthly revenue in 2026'. Set compare_to to compare with the previous period or the same period last year " +
      "in one call (change per group, and the customers or products that dropped the most). Pass a partner to see one customer " +
      "only, e.g. with group_by=product for what they buy. Credit notes are not subtracted.",
    allowedTypes: [...SALES_INVOICE_TYPES, "sales_bill_prepaid"],
    defaultTypes: SALES_INVOICE_TYPES,
    partnerWord: "customer",
  });

  registerSummaryTool(server, ctx, {
    name: "purchase_summary",
    title: "Purchase summary",
    description:
      "Spending (nabava, stroški) for a period from received supplier invoices (prejeti računi): net and gross totals per currency, " +
      "grouped by supplier (partner), product, month or document type (top N). Use it for 'biggest suppliers this year' or " +
      "'what did we buy most last quarter'. Set compare_to to compare with the previous period or the same period last year. " +
      "Credit notes are not subtracted.",
    allowedTypes: [...PURCHASE_INVOICE_TYPES, "purchase_bill_prepaid"],
    defaultTypes: PURCHASE_INVOICE_TYPES,
    partnerWord: "supplier",
  });
}

interface SummaryToolSpec {
  name: string;
  title: string;
  description: string;
  allowedTypes: readonly [DocType, ...DocType[]];
  defaultTypes: readonly DocType[];
  partnerWord: string;
}

function registerSummaryTool(server: McpServer, ctx: ToolContext, spec: SummaryToolSpec): void {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: z.object({
        date_from: isoDate.describe("Start of the period (inclusive), YYYY-MM-DD."),
        date_to: isoDate.describe("End of the period (inclusive), YYYY-MM-DD."),
        group_by: z
          .enum(["partner", "product", "month", "document_type"])
          .default("partner")
          .describe(`partner = ${spec.partnerWord}.`),
        partner_id: z.string().optional().describe(`Only this ${spec.partnerWord} (Metakocka partner id).`),
        partner_tax_number: z.string().optional().describe(`Only this ${spec.partnerWord}, by tax number.`),
        partner_name: z
          .string()
          .optional()
          .describe(`Only this ${spec.partnerWord}, by name (must match one partner). With group_by=product: what they buy.`),
        compare_to: z
          .enum(["none", "previous_period", "previous_year"])
          .default("none")
          .describe(
            "previous_period: the period just before, of the same length (whole months map to whole months: Sep → Aug, Q3 → Q2). " +
              "previous_year: the same dates one year earlier.",
          ),
        doc_types: z
          .array(z.enum(spec.allowedTypes))
          .min(1)
          .default([...spec.defaultTypes])
          .describe("Invoice types to count."),
        top: z.number().int().min(1).max(200).default(20).describe("How many groups to return (ignored for month)."),
        max_documents: z.number().int().min(1).max(10000).default(3000).describe("Safety cap on documents fetched per type and period."),
      }),
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(async () => {
        if (daysBetween(args.date_from, args.date_to) < 0) {
          throw new MetakockaError("date_from must be on or before date_to.");
        }
        const client = ctx.getClient();
        const progress = progressReporter(extra);
        const filters: AdvancedFilter[] = [];
        let partner: MkRecord | undefined;
        if (args.partner_id || args.partner_tax_number || args.partner_name) {
          partner = await resolvePartner(ctx, {
            partner_id: args.partner_id,
            tax_number: args.partner_tax_number,
            name: args.partner_name,
          });
          filters.push({ type: "partner_mk_id", value: String(partner.mk_id) });
        }
        const fetchPeriod = (from: string, to: string) =>
          searchAcrossTypes(client, args.doc_types, { dateFrom: from, dateTo: to, filters }, args.max_documents, ({ docType, fetched, total }) =>
            progress(`${from} – ${to}: read ${fetched}${total ? ` of ${total}` : ""} ${docType} documents`),
          );
        const partnerInfo = partner ? { partner: { id: String(partner.mk_id), name: partner.customer } } : {};

        const current = await fetchPeriod(args.date_from, args.date_to);
        const notes = {
          ...(args.group_by === "product"
            ? { note: "Product values are net of line discounts but before document-level discounts." }
            : {}),
        };

        if (args.compare_to === "none") {
          return {
            period: { from: args.date_from, to: args.date_to },
            ...partnerInfo,
            doc_types: args.doc_types,
            ...salesSummary(current.documents, args.group_by, args.top),
            ...notes,
            ...truncationWarning(current.truncatedTypes, "shorten the period or raise max_documents"),
          };
        }

        const previousRange =
          args.compare_to === "previous_period"
            ? previousPeriod(args.date_from, args.date_to)
            : samePeriodLastYear(args.date_from, args.date_to);
        const previous = await fetchPeriod(previousRange.from, previousRange.to);
        return {
          period: { from: args.date_from, to: args.date_to },
          compared_with: previousRange,
          ...partnerInfo,
          doc_types: args.doc_types,
          ...compareSummaries(
            salesSummary(current.documents, args.group_by, Infinity),
            salesSummary(previous.documents, args.group_by, Infinity),
            args.top,
          ),
          ...notes,
          ...truncationWarning(
            [...new Set([...current.truncatedTypes, ...previous.truncatedTypes])],
            "shorten the period or raise max_documents",
          ),
        };
      }),
  );
}
