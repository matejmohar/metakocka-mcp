import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { agingReport, partnerLedger, partnerStatement, toOpenInvoice, type OpenInvoice } from "../analytics.js";
import { searchAcrossTypes, searchPartners, type AdvancedFilter, type MkRecord } from "../api.js";
import { MetakockaError } from "../client.js";
import { addDays, addMonths, daysBetween, todayInLjubljana } from "../dates.js";
import type { DocType } from "../doc-types.js";
import { summarizePartner } from "../summarize.js";
import { str } from "../util.js";
import { isoDate } from "./documents.js";
import { progressReporter, READ_ONLY, run, truncationWarning, type ToolContext } from "./shared.js";

const RECEIVABLE_TYPES = ["sales_bill_domestic", "sales_bill_foreign"] as const satisfies readonly DocType[];
const PAYABLE_TYPES = ["purchase_bill_domestic", "purchase_bill_foreign"] as const satisfies readonly DocType[];
const STATEMENT_TYPES = {
  customer: ["sales_bill_domestic", "sales_bill_foreign", "sales_bill_credit_note"],
  supplier: ["purchase_bill_domestic", "purchase_bill_foreign", "purchase_bill_credit_note"],
} as const satisfies Record<string, readonly DocType[]>;

const partnerIdentity = {
  partner_id: z.string().optional().describe("Metakocka partner id (from search_partners)."),
  tax_number: z.string().optional().describe("Tax / VAT number (davčna številka), e.g. SI12345678."),
  name: z.string().optional().describe("Partner name; must identify a single partner."),
};

const hasIdentity = (a: { partner_id?: string; tax_number?: string; name?: string }) => !!(a.partner_id || a.tax_number || a.name);
const IDENTITY_MESSAGE = "Provide partner_id, tax_number or name.";

const normaliseTaxNumber = (v: unknown) => str(v)?.replace(/\s/g, "").toUpperCase();

/**
 * Exactly one partner, or an error that lists the candidates so the model can
 * ask the user or retry with partner_id.
 */
export async function resolvePartner(
  ctx: ToolContext,
  who: { partner_id?: string; tax_number?: string; name?: string },
): Promise<MkRecord> {
  const query = {
    partnerId: who.partner_id,
    taxNumber: who.partner_id ? undefined : who.tax_number,
    name: who.partner_id || who.tax_number ? undefined : who.name,
    withDiscounts: true,
  };
  const client = ctx.getClient();
  const found = await ctx.cache.getOrLoad(`partners:${JSON.stringify(query)}`, () => searchPartners(client, query));
  let matches = found;
  if (who.partner_id) matches = found.filter((p) => str(p.mk_id) === who.partner_id);
  else if (who.tax_number) matches = found.filter((p) => normaliseTaxNumber(p.tax_id_number) === normaliseTaxNumber(who.tax_number));
  else if (who.name) {
    const exact = found.filter((p) => str(p.customer)?.toLowerCase() === who.name!.trim().toLowerCase());
    if (exact.length) matches = exact;
  }

  if (matches.length === 1) return matches[0]!;
  const what = who.partner_id ? `id "${who.partner_id}"` : who.tax_number ? `tax number "${who.tax_number}"` : `name "${who.name}"`;
  if (!matches.length) throw new MetakockaError(`No partner with ${what}. Try search_partners with part of the name.`);
  const candidates = matches
    .slice(0, 10)
    .map((p) => `${str(p.customer)} (partner_id ${str(p.mk_id)}${str(p.tax_id_number) ? `, ${str(p.tax_id_number)}` : ""})`)
    .join("; ");
  throw new MetakockaError(
    `${matches.length} partners match ${what}: ${candidates}${matches.length > 10 ? "; …" : ""}. Retry with partner_id.`,
  );
}

const partnerFilter = (partner: MkRecord): AdvancedFilter => ({ type: "partner_mk_id", value: str(partner.mk_id)! });

export function registerPartnerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_partner",
    {
      title: "Get partner",
      description:
        "One customer or supplier (partner) in full: contacts, addresses, payment terms, discounts per product category, " +
        "and their current open balance: what they owe us (unpaid sales invoices) and what we owe them (unpaid purchase invoices), " +
        "with overdue amounts and aging. Works for private persons without a tax number too.",
      inputSchema: z
        .object({
          ...partnerIdentity,
          include_balance: z.boolean().default(true).describe("Include open receivables and payables (a few extra searches)."),
        })
        .refine(hasIdentity, { message: IDENTITY_MESSAGE }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const client = ctx.getClient();
        const partner = await resolvePartner(ctx, args);
        const result: MkRecord = { partner: summarizePartner(partner) };
        if (!args.include_balance) return result;

        const today = todayInLjubljana(ctx.now());
        const filters = [partnerFilter(partner), { type: "payment_status", value: "false" }];
        const balance = async (types: readonly DocType[]) => {
          const { documents, truncatedTypes } = await searchAcrossTypes(client, types, { filters }, 500);
          const invoices = documents.map((d) => toOpenInvoice(d, today)).filter((i): i is OpenInvoice => i !== undefined);
          invoices.sort((a, b) => b.days_overdue - a.days_overdue);
          const summary = {
            open_invoices: invoices.length,
            totals_by_currency: agingReport(invoices).totals_by_currency,
            ...(invoices[0]?.days_overdue ? { most_overdue: invoices[0] } : {}),
          };
          return { summary, truncatedTypes };
        };
        const receivable = await balance(RECEIVABLE_TYPES);
        const payable = await balance(PAYABLE_TYPES);
        return {
          ...result,
          as_of: today,
          they_owe_us: receivable.summary,
          we_owe_them: payable.summary,
          ...truncationWarning([...receivable.truncatedTypes, ...payable.truncatedTypes], "use partner_statement for the full list"),
        };
      }),
  );

  server.registerTool(
    "partner_statement",
    {
      title: "Partner statement",
      description:
        "Statement of account (kartica partnerja / izpis odprtih postavk) for one customer or supplier: invoices and credit notes " +
        "in a period and each payment on the date it was made, with a running balance that starts from what older unpaid " +
        "documents still owed. Totals per currency (invoiced, credited, paid), what is open and overdue today, and payment " +
        "behaviour (average days to pay, how often and how late). Use it before writing a payment reminder or reviewing a customer.",
      inputSchema: z
        .object({
          ...partnerIdentity,
          side: z
            .enum(["customer", "supplier"])
            .default("customer")
            .describe("customer: our sales invoices to them; supplier: their invoices to us."),
          date_from: isoDate.optional().describe("Start of the period (default: 12 months ago)."),
          date_to: isoDate.optional().describe("End of the period (default: today)."),
          include_opening_balance: z
            .boolean()
            .default(true)
            .describe("Also count documents from before the period that are still unpaid."),
          include_payment_dates: z
            .boolean()
            .default(true)
            .describe(
              "List each payment on its own date (on by default; costs nothing extra). " +
                "false: one row per document with the amount paid so far.",
            ),
          max_rows: z.number().int().min(1).max(500).default(100).describe("How many rows to list (the most recent ones). Totals always cover all."),
          max_documents: z.number().int().min(1).max(5000).default(1000).describe("Safety cap on documents fetched per type."),
        })
        .refine(hasIdentity, { message: IDENTITY_MESSAGE }),
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(async () => {
        const today = todayInLjubljana(ctx.now());
        const dateTo = args.date_to ?? today;
        const dateFrom = args.date_from ?? addDays(addMonths(dateTo, -12), 1);
        if (daysBetween(dateFrom, dateTo) < 0) throw new MetakockaError("date_from must be on or before date_to.");

        const client = ctx.getClient();
        const progress = progressReporter(extra);
        const partner = await resolvePartner(ctx, args);
        const types = STATEMENT_TYPES[args.side];
        const onPage = ({ docType, fetched }: { docType: string; fetched: number }) => progress(`Read ${fetched} ${docType} documents`);
        const inPeriod = await searchAcrossTypes(
          client,
          types,
          { dateFrom, dateTo, filters: [partnerFilter(partner)], paymentDetail: args.include_payment_dates },
          args.max_documents,
          onPage,
        );
        const older = args.include_opening_balance
          ? await searchAcrossTypes(
              client,
              types,
              {
                dateTo: addDays(dateFrom, -1),
                filters: [partnerFilter(partner), { type: "payment_status", value: "false" }],
                paymentDetail: args.include_payment_dates,
              },
              args.max_documents,
              onPage,
            )
          : { documents: [], truncatedTypes: [] };

        const header = {
          partner: { id: str(partner.mk_id), name: str(partner.customer), tax_id: str(partner.tax_id_number) },
          side: args.side,
          period: { from: dateFrom, to: dateTo },
          as_of: today,
        };
        const warning = truncationWarning(
          [...new Set([...inPeriod.truncatedTypes, ...older.truncatedTypes])],
          "shorten the period or raise max_documents",
        );

        if (args.include_payment_dates) {
          const ledger = partnerLedger(inPeriod.documents, older.documents, { from: dateFrom, to: dateTo }, today);
          const entries = ledger.entries.slice(-args.max_rows);
          return {
            ...header,
            ...ledger,
            entries,
            ...(ledger.entries.length > entries.length ? { earlier_entries_not_listed: ledger.entries.length - entries.length } : {}),
            ...(ledger.entries.some((e) => e.date_estimated)
              ? { note: "Entries with date_estimated had no payment detail; the date is when the document was fully paid." }
              : {}),
            ...warning,
          };
        }

        const statement = partnerStatement(inPeriod.documents, older.documents, today);
        const rows = statement.rows.slice(-args.max_rows);
        return {
          ...header,
          ...statement,
          rows,
          ...(statement.rows.length > rows.length ? { earlier_rows_not_listed: statement.rows.length - rows.length } : {}),
          note: "Payments are shown per document (amount paid so far). Set include_payment_dates to see when each was paid.",
          ...warning,
        };
      }),
  );
}
