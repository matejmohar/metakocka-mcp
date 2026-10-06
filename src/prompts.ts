import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const languageArg = z
  .enum(["sl", "en"])
  .optional()
  .describe("Language of the output: sl (Slovenian) or en (English). Default: the language the user writes in.");

function languageLine(language?: "sl" | "en"): string {
  if (language === "sl") return "Write the result in Slovenian.";
  if (language === "en") return "Write the result in English.";
  return "Write the result in the language the user writes in.";
}

function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "monthly-sales-report",
    {
      title: "Monthly sales report",
      description: "Revenue, top customers and best-selling products for one month, compared with the month before.",
      argsSchema: z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/).describe("Month as YYYY-MM, e.g. 2026-09"),
        language: languageArg,
      }),
    },
    ({ month, language }) =>
      userMessage(
        `Prepare a sales report for ${month} from Metakocka.\n` +
          `1. Use sales_summary for the whole of ${month} with compare_to=previous_period, grouped by partner, then by product.\n` +
          "2. Write a short report: total net and gross revenue (with change vs. the previous month), " +
          "top 10 customers, top 10 products, and anything notable (new big customers, biggest_declines).\n" +
          "Keep amounts in their currency and say clearly if any totals were truncated. " +
          languageLine(language),
      ),
  );

  server.registerPrompt(
    "overdue-invoices",
    {
      title: "Overdue invoices follow-up",
      description: "Who owes money and for how long, with suggested follow-up e-mails.",
      argsSchema: z.object({
        min_days: z.string().regex(/^\d+$/).optional().describe("Only invoices at least this many days overdue (default 1)"),
        language: languageArg,
      }),
    },
    ({ min_days, language }) =>
      userMessage(
        `Use get_unpaid_invoices with min_days_overdue=${min_days ?? "1"} to find overdue sales invoices in Metakocka.\n` +
          "Summarise: total overdue per currency, the aging breakdown, and the customers who owe the most.\n" +
          "Then draft a short, polite payment reminder for each of the top 5 customers, " +
          "listing their invoice numbers, amounts and due dates. Write the reminders in " +
          `${language === "en" ? "English" : "Slovenian"}. Do not send anything.`,
      ),
  );

  server.registerPrompt(
    "stock-check",
    {
      title: "Stock check",
      description: "Check stock for some products and flag anything low or out of stock.",
      argsSchema: z.object({
        products: z.string().describe("Product codes or names, comma-separated"),
        language: languageArg,
      }),
    },
    ({ products, language }) =>
      userMessage(
        `Check current stock in Metakocka for: ${products}.\n` +
          "Use search_products to find each product, then get_product for stock, free stock and incoming supplier orders per warehouse. " +
          "Report stock and free stock per warehouse, flag products that are out of stock or below their safety stock, " +
          "and say when incoming orders are expected. " +
          languageLine(language),
      ),
  );

  server.registerPrompt(
    "payment-reminders",
    {
      title: "Payment reminders",
      description: "Draft payment reminders for overdue customers, firmer the longer an invoice is overdue.",
      argsSchema: z.object({
        customer: z.string().optional().describe("One customer (name or tax number). Default: the customers who owe the most"),
        min_days: z.string().regex(/^\d+$/).optional().describe("Only invoices at least this many days overdue (default 1)"),
        max_customers: z.string().regex(/^\d+$/).optional().describe("How many customers to write to (default 5)"),
        language: languageArg,
      }),
    },
    ({ customer, min_days, max_customers, language }) =>
      userMessage(
        (customer
          ? `Use partner_statement for the customer "${customer}" to find their open invoices.\n`
          : `Use get_unpaid_invoices with min_days_overdue=${min_days ?? "1"} and find the ${max_customers ?? "5"} customers who owe the most. ` +
            "Then use partner_statement for each of them to see all their open invoices and credit notes.\n") +
          "Draft one e-mail per customer listing every overdue invoice (number, date, due date, amount still open) and the total. " +
          "Match the tone to the most overdue invoice: up to 14 days a friendly reminder, 15–45 days a firm second reminder, " +
          "over 45 days a final reminder that asks them to pay or get in touch within 8 days. " +
          "Mention open credit notes if they have any. Don't threaten legal steps unless I ask. " +
          `Write the e-mails in ${language === "en" ? "English" : "Slovenian"}. Do not send anything.`,
      ),
  );

  server.registerPrompt(
    "customer-review",
    {
      title: "Customer review",
      description: "One customer at a glance: what they buy, how much, how they pay, and what to watch.",
      argsSchema: z.object({
        customer: z.string().describe("Customer name, tax number or Metakocka partner id"),
        language: languageArg,
      }),
    },
    ({ customer, language }) =>
      userMessage(
        `Review the customer "${customer}" in Metakocka.\n` +
          "1. get_partner: contact details, payment terms, discounts and current open balance.\n" +
          "2. partner_statement for the last 12 months, and again for the 12 months before that " +
          "(include_opening_balance=false), to compare how much they bought.\n" +
          "3. search_documents for their sales orders and offers of the last 3 months (by partner_tax_number when they have one).\n" +
          "Write a short review: who they are, revenue now vs. a year ago, payment behaviour (overdue invoices, how late), " +
          "open orders and offers, and two or three suggestions (e.g. follow up an offer, tighten payment terms). " +
          languageLine(language),
      ),
  );

  server.registerPrompt(
    "weekly-business-digest",
    {
      title: "Weekly business digest",
      description: "Sales, overdue payments, new orders and stock to reorder for the past week, in one page.",
      argsSchema: z.object({
        week_ending: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Last day of the week, YYYY-MM-DD (default: today)"),
        language: languageArg,
      }),
    },
    ({ week_ending, language }) =>
      userMessage(
        `Prepare a weekly business digest from Metakocka for the 7 days ending ${week_ending ?? "today"}.\n` +
          "1. sales_summary for those 7 days with compare_to=previous_period, grouped by partner.\n" +
          "2. search_documents for sales orders and sales offers dated in those 7 days (limit 1, just to read total_matching).\n" +
          "3. get_unpaid_invoices with overdue_only=true.\n" +
          "4. low_stock.\n" +
          "Write a one-page digest with four short sections: sales (vs. the week before, top customers), new orders and offers, " +
          "money owed (total overdue, biggest debtors), and stock to reorder. End with the three things that need attention first. " +
          languageLine(language),
      ),
  );

  server.registerPrompt(
    "month-end-checklist",
    {
      title: "Month-end checklist",
      description: "Figures and checks for closing a month: revenue, spending, receivables, payables, credit notes and stock.",
      argsSchema: z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/).describe("Month as YYYY-MM, e.g. 2026-09"),
        language: languageArg,
      }),
    },
    ({ month, language }) =>
      userMessage(
        `Help me close ${month} in Metakocka.\n` +
          `1. sales_summary for the whole of ${month} with compare_to=previous_year, grouped by document_type.\n` +
          `2. purchase_summary for ${month} with compare_to=previous_period, grouped by partner.\n` +
          `3. search_documents for sales_bill_credit_note dated in ${month}.\n` +
          "4. get_unpaid_invoices for receivables, and again with purchase invoice types for payables.\n" +
          "5. stock_valuation and low_stock (these show stock as of today, not the end of the month — say so).\n" +
          "Write a month-end summary (revenue, spending, credit notes, receivables and payables with aging, stock value), " +
          "then a checklist of what to check before handing over to the accountant: unusual changes vs. last year, " +
          "large overdue receivables, supplier invoices due soon, credit notes to explain, negative or missing stock. " +
          languageLine(language),
      ),
  );
}
