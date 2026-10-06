import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { agingReport, partnerStatement, toOpenInvoice, type OpenInvoice } from "../analytics.js";
import { searchAcrossTypes, searchPartners, type AdvancedFilter, type MkRecord } from "../api.js";
import type { MetakockaClient } from "../client.js";
import { MetakockaError } from "../client.js";
import { addDays, addMonths, daysBetween, todayInLjubljana } from "../dates.js";
import type { DocType } from "../doc-types.js";
import { summarizePartner } from "../summarize.js";
import { str } from "../util.js";
import { isoDate } from "./documents.js";
import { READ_ONLY, run, truncationWarning, type ToolContext } from "./shared.js";

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
  client: MetakockaClient,
  who: { partner_id?: string; tax_number?: string; name?: string },
): Promise<MkRecord> {
  const found = await searchPartners(client, {
    partnerId: who.partner_id,
    taxNumber: who.partner_id ? undefined : who.tax_number,
    name: who.partner_id || who.tax_number ? undefined : who.name,
    withDiscounts: true,
  });
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
        const partner = await resolvePartner(client, args);
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
        "Statement of account (kartica partnerja / izpis odprtih postavk) for one customer or supplier: every invoice and credit note " +
        "in a period in date order, with amount, paid, still open, days overdue and a running open balance that starts from what was " +
        "already open before the period. Totals per currency: invoiced, credited, paid, open, overdue. " +
        "Use it before writing a payment reminder or reviewing a customer.",
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
          max_rows: z.number().int().min(1).max(500).default(100).describe("How many rows to list (the most recent ones). Totals always cover all."),
          max_documents: z.number().int().min(1).max(5000).default(1000).describe("Safety cap on documents fetched per type."),
        })
        .refine(hasIdentity, { message: IDENTITY_MESSAGE }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const today = todayInLjubljana(ctx.now());
        const dateTo = args.date_to ?? today;
        const dateFrom = args.date_from ?? addDays(addMonths(dateTo, -12), 1);
        if (daysBetween(dateFrom, dateTo) < 0) throw new MetakockaError("date_from must be on or before date_to.");

        const client = ctx.getClient();
        const partner = await resolvePartner(client, args);
        const types = STATEMENT_TYPES[args.side];
        const inPeriod = await searchAcrossTypes(
          client,
          types,
          { dateFrom, dateTo, filters: [partnerFilter(partner)] },
          args.max_documents,
        );
        const older = args.include_opening_balance
          ? await searchAcrossTypes(
              client,
              types,
              { dateTo: addDays(dateFrom, -1), filters: [partnerFilter(partner), { type: "payment_status", value: "false" }] },
              args.max_documents,
            )
          : { documents: [], truncatedTypes: [] };

        const statement = partnerStatement(inPeriod.documents, older.documents, today);
        const rows = statement.rows.slice(-args.max_rows);
        return {
          partner: { id: str(partner.mk_id), name: str(partner.customer), tax_id: str(partner.tax_id_number) },
          side: args.side,
          period: { from: dateFrom, to: dateTo },
          as_of: today,
          ...statement,
          rows,
          ...(statement.rows.length > rows.length ? { earlier_rows_not_listed: statement.rows.length - rows.length } : {}),
          note: "Payments are shown per document (amount paid so far); Metakocka's search does not return payment dates.",
          ...truncationWarning(
            [...new Set([...inPeriod.truncatedTypes, ...older.truncatedTypes])],
            "shorten the period or raise max_documents",
          ),
        };
      }),
  );
}
