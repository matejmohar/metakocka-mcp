import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { accountingExport, bankStatementStatus, listBankStatements, listCashRegisterJournals, listCompensations } from "../api.js";
import { bankBalances, bankSummary, cashJournalAsStatement, compensationSummary } from "../bank.js";
import { MetakockaError } from "../client.js";
import { pdfDirectory } from "../config.js";
import { addDays, addMonths, daysBetween, todayInLjubljana } from "../dates.js";
import { isoDate } from "./documents.js";
import { progressReporter, READ_ONLY, run, type ToolContext, type ToolResult } from "./shared.js";

/** A period from optional dates: to defaults to today, from to `days` before it. */
function period(ctx: ToolContext, from: string | undefined, to: string | undefined, days: number) {
  const dateTo = to ?? todayInLjubljana(ctx.now());
  const dateFrom = from ?? addDays(dateTo, -days);
  if (daysBetween(dateFrom, dateTo) < 0) throw new MetakockaError("date_from must be on or before date_to.");
  return { dateFrom, dateTo };
}

/** An accounting export can take minutes: Metakocka runs one at a time per company and queues the rest. */
const EXPORT_TIMEOUT_MS = 10 * 60_000;

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

  server.registerTool(
    "get_bank_balances",
    {
      title: "Bank balances",
      description:
        "How much money is on each bank account (stanje na računu): the closing balance of its last bank statement (izpisek) " +
        "in Metakocka, with the statement's number and date. The balance is only as current as the last statement entered " +
        "or imported; days_since_last_statement says how old it is.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const rows = await bankStatementStatus(ctx.getClient());
        if (!rows.length) return { accounts: [], note: "No bank statements in Metakocka, so no balances are known." };
        const result = bankBalances(rows, todayInLjubljana(ctx.now()));
        const stale = result.accounts.filter((a) => (a.days_since_last_statement ?? 0) > 7);
        return {
          ...result,
          ...(stale.length ? { note: `The last statement of ${stale.map((a) => a.account).join(", ")} is more than a week old; the balance may be out of date.` } : {}),
        };
      }),
  );

  server.registerTool(
    "get_compensations",
    {
      title: "Compensations",
      description:
        "Compensations (kompenzacije, also multilateral / pobot) for a period: invoices settled against each other instead of " +
        "paid. Per compensation: the partner, the amount, whether it is confirmed, and which of our invoices and the partner's " +
        "invoices it settled. Use it when an invoice shows as paid but no money came in, or for a partner's full account.",
      inputSchema: z.object({
        date_from: isoDate.optional().describe("Start of the period (default: a year ago)."),
        date_to: isoDate.optional().describe("End of the period (default: today)."),
        partner: z.string().optional().describe("Only compensations whose partner name contains this text."),
        max_records: z.number().int().min(1).max(5000).default(500).describe("Safety cap on compensations read from Metakocka."),
      }),
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(async () => {
        const { dateFrom, dateTo } = period(ctx, args.date_from, args.date_to, 365);
        const progress = progressReporter(extra);
        const { records, truncated } = await listCompensations(
          ctx.getClient(),
          { dateFrom, dateTo, max: args.max_records },
          (n) => progress(`Read ${n} compensations`),
        );
        return {
          period: { from: dateFrom, to: dateTo },
          ...compensationSummary(records, { partner: args.partner }),
          ...(truncated ? { warning: "More compensations exist than max_records; the list is incomplete — shorten the period." } : {}),
        };
      }),
  );

  server.registerTool(
    "get_cash_register",
    {
      title: "Cash register",
      description:
        "Cash register journals (blagajniški dnevnik, blagajna) for a period: per register the opening and closing cash " +
        "balance, cash in and out, deposits to the bank (polog), and the individual receipts (prejemki) and expenses " +
        "(izdatki) with partner and document. For bank accounts use get_bank_statements.",
      inputSchema: z.object({
        date_from: isoDate.optional().describe("Start of the period (default: 30 days ago)."),
        date_to: isoDate.optional().describe("End of the period (default: today)."),
        cash_register: z.string().optional().describe("Only this cash register, by its name in Metakocka (e.g. \"Blagajna 1\")."),
        direction: z.enum(["in", "out", "all"]).default("all").describe("in: receipts (prejemki), out: expenses (izdatki) and deposits."),
        partner: z.string().optional().describe("Only transactions whose partner name contains this text."),
        max_transactions: z.number().int().min(0).max(1000).default(100).describe("How many transactions to list (newest first). Totals always cover all."),
        max_journals: z.number().int().min(1).max(5000).default(500).describe("Safety cap on daily journals read from Metakocka."),
      }),
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      run(async () => {
        const { dateFrom, dateTo } = period(ctx, args.date_from, args.date_to, 30);
        const progress = progressReporter(extra);
        const { records, truncated } = await listCashRegisterJournals(
          ctx.getClient(),
          { dateFrom, dateTo, max: args.max_journals, cashRegister: args.cash_register },
          (n) => progress(`Read ${n} cash register journals`),
        );
        if (!records.length) {
          return { period: { from: dateFrom, to: dateTo }, journals: 0, note: "No cash register journals in this period." };
        }
        const summary = bankSummary(records.map(cashJournalAsStatement), {
          direction: args.direction === "all" ? undefined : args.direction,
          partner: args.partner,
        });
        const newestFirst = [...summary.transactions].reverse();
        const listed = newestFirst.slice(0, args.max_transactions);
        const { accounts, statements_not_reconciled: notReconciled, ...rest } = summary;
        return {
          period: { from: dateFrom, to: dateTo },
          journals: records.length,
          registers: accounts.map(({ account, ...a }) => ({ register: account, ...a })),
          ...rest,
          transactions_matching: summary.transactions.length,
          transactions: listed.map(({ account, statement, ...t }) => ({ register: account, journal: statement, ...t })),
          ...(newestFirst.length > listed.length ? { transactions_not_listed: newestFirst.length - listed.length } : {}),
          ...(notReconciled
            ? {
                journals_not_reconciled: notReconciled,
                note: "In the journals listed in journals_not_reconciled the transactions don't add up to the balance change; check them in Metakocka.",
              }
            : {}),
          ...(truncated ? { warning: "More journals exist than max_journals; totals are incomplete — shorten the period." } : {}),
        };
      }),
  );

  const embedded = ctx.pdfDelivery === "embedded";
  server.registerTool(
    "accounting_export",
    {
      title: "Accounting export",
      description:
        "Run Metakocka's export for the accountant (izvoz v računovodstvo, e.g. for Vasco, Minimax, Pantheon) for a period, " +
        "using export profiles set up in Metakocka (Nastavitve → Izvoz v računovodstvo). The result is the same ZIP file as " +
        "the export in Metakocka itself. " +
        (embedded
          ? "Returns a download link, valid for one hour. "
          : "It is saved on this computer (by default in Downloads/Metakocka); the download link is also returned, valid for one hour. ") +
        "There is no way to list the profiles through the API: ask the user for their exact names (or ids) if you don't know them. " +
        "An export can take a few minutes. It does not change any documents in Metakocka.",
      inputSchema: z.object({
        profiles: z
          .array(z.string().min(1))
          .min(1)
          .max(20)
          .describe('Export profile names (or ids) exactly as in Metakocka, e.g. ["Izdani računi Vasco - domači"].'),
        date_from: isoDate.optional().describe("First day of the period (default: first day of last month)."),
        date_to: isoDate.optional().describe("Last day of the period (default: last day of last month)."),
        include_attachments: z.boolean().default(false).describe("Also export each invoice's PDF and the files attached to it (a much larger file)."),
      }),
      annotations: embedded ? READ_ONLY : { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra): Promise<ToolResult> => {
      let saved: { path: string; name: string } | undefined;
      const result = await run(async () => {
        const today = todayInLjubljana(ctx.now());
        const thisMonth = `${today.slice(0, 8)}01`;
        const dateFrom = args.date_from ?? addMonths(thisMonth, -1);
        const dateTo = args.date_to ?? addDays(thisMonth, -1);
        if (daysBetween(dateFrom, dateTo) < 0) throw new MetakockaError("date_from must be on or before date_to.");

        progressReporter(extra)("Metakocka is preparing the export");
        const { url, jobId } = await accountingExport(ctx.getClient(), {
          profiles: args.profiles,
          dateFrom,
          dateTo,
          attachments: args.include_attachments,
          timeoutMs: EXPORT_TIMEOUT_MS,
        });
        const expires = new Date(ctx.now().getTime() + 60 * 60_000).toISOString();
        const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "") || `accounting_export_${dateFrom}_${dateTo}.zip`;
        const base = { period: { from: dateFrom, to: dateTo }, profiles: args.profiles, job_id: jobId };
        if (embedded) return { ...base, file_name: fileName, download_url: url, link_expires_at: expires };

        const response = await (ctx.fetchFile ?? fetch)(url, { signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) });
        if (!response.ok) {
          return { ...base, download_url: url, link_expires_at: expires, warning: `The export is ready, but downloading it failed (HTTP ${response.status}); open the link instead.` };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const dir = ctx.pdfDir ?? pdfDirectory();
        const path = join(dir, fileName.replace(/[^\p{L}\p{N}._-]+/gu, "-"));
        await mkdir(dir, { recursive: true });
        await writeFile(path, bytes);
        saved = { path, name: fileName };
        return { ...base, saved_to: path, size_kb: Math.round(bytes.length / 102.4) / 10, download_url: url, link_expires_at: expires };
      });
      if (saved) result.content.push({ type: "resource_link", uri: pathToFileURL(saved.path).href, name: saved.name, mimeType: "application/zip" });
      return result;
    },
  );
}
