import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

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
      }),
    },
    ({ month }) =>
      userMessage(
        `Prepare a sales report for ${month} from Metakocka.\n` +
          `1. Use sales_summary for ${month} grouped by partner, then by product.\n` +
          "2. Run sales_summary for the previous month (grouped by partner) to compare.\n" +
          "3. Write a short report: total net and gross revenue (with change vs. the previous month), " +
          "top 10 customers, top 10 products, and anything notable (new big customers, big drops).\n" +
          "Keep amounts in their currency and say clearly if any totals were truncated.",
      ),
  );

  server.registerPrompt(
    "overdue-invoices",
    {
      title: "Overdue invoices follow-up",
      description: "Who owes money and for how long, with suggested follow-up e-mails.",
      argsSchema: z.object({
        min_days: z.string().regex(/^\d+$/).optional().describe("Only invoices at least this many days overdue (default 1)"),
      }),
    },
    ({ min_days }) =>
      userMessage(
        `Use get_unpaid_invoices with min_days_overdue=${min_days ?? "1"} to find overdue sales invoices in Metakocka.\n` +
          "Summarise: total overdue per currency, the aging breakdown, and the customers who owe the most.\n" +
          "Then draft a short, polite payment reminder (in Slovenian) for each of the top 5 customers, " +
          "listing their invoice numbers, amounts and due dates. Do not send anything.",
      ),
  );

  server.registerPrompt(
    "stock-check",
    {
      title: "Stock check",
      description: "Check stock for some products and flag anything low or out of stock.",
      argsSchema: z.object({
        products: z.string().describe("Product codes or names, comma-separated"),
      }),
    },
    ({ products }) =>
      userMessage(
        `Check current stock in Metakocka for: ${products}.\n` +
          "Use search_products (with include_stock) to find each product, then get_stock for per-warehouse detail. " +
          "Report stock and free stock per warehouse, and flag products that are out of stock or below their safety stock.",
      ),
  );
}
