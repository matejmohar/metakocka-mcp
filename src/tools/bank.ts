import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { listBankStatements } from "../api.js";
import { bankSummary } from "../bank.js";
import { MetakockaError } from "../client.js";
import { addDays, daysBetween, todayInLjubljana } from "../dates.js";
import { isoDate } from "./documents.js";
import { progressReporter, READ_ONLY, run, type ToolContext } from "./shared.js";

export function registerBankTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_bank_statements",
    {
      title: "Bank statements",
      description:
        "Bank statements (bančni izpiski) for a period: per bank account the opening and closing balance and money in and out, " +
        "the partners with the most money in or out, and the individual transactions (date, partner, amount, linked document). " +
        "Use it for cash-flow questions like 'what came in this week?' or 'did ACME pay?'. Only statements entered or imported " +
        "into Metakocka are included.",
      inputSchema: z.object({
        date_from: isoDate.optional().describe("Start of the period (default: 30 days ago)."),
        date_to: isoDate.optional().describe("End of the period (default: today)."),
        direction: z.enum(["in", "out", "all"]).default("all").describe("in: receipts (prejemki), out: payments (izdatki)."),
        partner: z.string().optional().describe("Only transactions whose partner name contains this text."),
        min_amount: z.number().min(0).optional().describe("Only transactions of at least this amount."),
        max_transactions: z.number().int().min(0).max(1000).default(100).describe("How many transactions to list (newest first). Totals always cover all."),
        max_statements: z.number().int().min(1).max(5000).default(500).describe("Safety cap on statements read from Metakocka."),
      }),
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(async () => {
        const today = todayInLjubljana(ctx.now());
        const dateTo = args.date_to ?? today;
        const dateFrom = args.date_from ?? addDays(dateTo, -30);
        if (daysBetween(dateFrom, dateTo) < 0) throw new MetakockaError("date_from must be on or before date_to.");

        const progress = progressReporter(extra);
        const { statements, truncated } = await listBankStatements(
          ctx.getClient(),
          { dateFrom, dateTo, maxStatements: args.max_statements },
          (fetched) => progress(`Read ${fetched} bank statements`),
        );
        const summary = bankSummary(statements, {
          direction: args.direction === "all" ? undefined : args.direction,
          partner: args.partner,
          minAmount: args.min_amount,
        });
        const newestFirst = [...summary.transactions].reverse();
        const listed = newestFirst.slice(0, args.max_transactions);
        return {
          period: { from: dateFrom, to: dateTo },
          statements: statements.length,
          ...summary,
          transactions_matching: summary.transactions.length,
          transactions: listed,
          ...(newestFirst.length > listed.length ? { transactions_not_listed: newestFirst.length - listed.length } : {}),
          ...(summary.statements_not_reconciled
            ? {
                note: "On the statements listed in statements_not_reconciled the transactions don't add up to the balance change; check their amounts in Metakocka.",
              }
            : {}),
          ...(truncated ? { warning: "More statements exist than max_statements; totals are incomplete — shorten the period." } : {}),
        };
      }),
  );
}
