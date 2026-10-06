/**
 * Read-only checks against the real Metakocka API. They pin down the API
 * behaviour this server relies on (date formats, number formats, endpoint
 * shapes) so that a change on Metakocka's side shows up here instead of in
 * users' answers. They work with whatever data the company has.
 *
 * Run with `npm run test:live` (credentials from .env) or the nightly
 * "Live API check" workflow (credentials from repository secrets).
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentPayments } from "../../src/analytics.js";
import {
  findByTrackingCode,
  INVOICE_REPORT_ID,
  listBankStatements,
  listProducts,
  listWarehouses,
  printDocumentPdf,
  searchDocuments,
  searchPartners,
  type MkRecord,
} from "../../src/api.js";
import { MetakockaClient, MetakockaError } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";
import { addDays, todayInLjubljana } from "../../src/dates.js";
import { createServer } from "../../src/server.js";
import { asArray, num, numSl, str } from "../../src/util.js";

if (existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
const configured = !!(process.env.METAKOCKA_COMPANY_ID && process.env.METAKOCKA_SECRET_KEY);

describe.skipIf(!configured)("Metakocka API (live)", () => {
  let client: MetakockaClient;
  const today = todayInLjubljana();
  const yearAgo = addDays(today, -365);

  beforeAll(() => {
    client = new MetakockaClient(loadConfig());
  });

  it("answers with the company's warehouses", async () => {
    expect(Array.isArray(await listWarehouses(client))).toBe(true);
  });

  it.each([
    ["winter", `${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-01-31`],
    ["summer", `${today.slice(0, 4)}-07-01`, `${today.slice(0, 4)}-07-31`],
  ])("accepts %s dates in search filters", async (_, from, to) => {
    await expect(searchDocuments(client, { docType: "sales_bill_domestic", dateFrom: from, dateTo: to, limit: 1 })).resolves.toBeDefined();
  });

  it("accepts winter dates for bank statements", async () => {
    const year = today.slice(0, 4);
    await expect(listBankStatements(client, { dateFrom: `${year}-01-01`, dateTo: `${year}-01-31`, maxStatements: 1 })).resolves.toBeDefined();
  });

  it("returns payment amounts in Slovenian format that add up to sum_paid", async () => {
    const paid: MkRecord[] = [];
    for (const docType of ["sales_bill_domestic", "sales_bill_foreign", "purchase_bill_domestic", "purchase_bill_foreign"] as const) {
      const page = await searchDocuments(client, { docType, dateFrom: yearAgo, dateTo: today, paymentDetail: true, limit: 100 });
      paid.push(...page.documents.filter((d) => asArray(d.mark_paid).length > 0));
    }
    if (!paid.length) return console.warn("No paid invoices in the last year; payment format not checked.");
    for (const doc of paid) {
      const total = asArray<MkRecord>(doc.mark_paid).reduce((s, p) => s + (numSl(p.amount) ?? NaN), 0);
      expect(total, `payments on ${str(doc.count_code)}`).toBeCloseTo(Math.abs(num(doc.sum_paid) ?? 0), 2);
      expect(documentPayments(doc).some((p) => p.date_estimated)).toBe(false);
    }
  });

  it("finds a product by its exact id", async () => {
    const { products } = await listProducts(client, { limit: 1 });
    const first = products[0];
    if (!first) return console.warn("No products; exact lookup not checked.");
    const { products: found } = await listProducts(client, { productId: str(first.count_code), exact: true, limit: 10 });
    expect(found.map((p) => str(p.count_code))).toContain(str(first.count_code));
  });

  it("looks partners up with discounts", async () => {
    const page = await searchDocuments(client, { docType: "sales_bill_domestic", dateFrom: yearAgo, dateTo: today, limit: 1 });
    const partnerId = str((page.documents[0]?.partner as MkRecord | undefined)?.mk_id);
    if (!partnerId) return console.warn("No invoices with a partner; partner lookup not checked.");
    const partners = await searchPartners(client, { partnerId, withDiscounts: true });
    expect(partners.map((p) => str(p.mk_id))).toContain(partnerId);
  });

  it("prints an invoice as PDF with the standard invoice report", async () => {
    for (const docType of ["sales_bill_domestic", "sales_bill_foreign"] as const) {
      const page = await searchDocuments(client, { docType, dateFrom: yearAgo, dateTo: today, limit: 1 });
      const id = str(page.documents[0]?.mk_id);
      if (!id) continue;
      const pdf = await printDocumentPdf(client, id, INVOICE_REPORT_ID);
      expect(Buffer.from(pdf.subarray(0, 4)).toString("latin1")).toBe("%PDF");
      return;
    }
    console.warn("No sales invoices in the last year; PDF printing not checked.");
  });

  it("reports an unknown tracking code as an error", async () => {
    const error = await findByTrackingCode(client, { trackingCode: "MCP-LIVE-CHECK-NONE" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetakockaError);
    expect((error as Error).message).toMatch(/not found/i);
  });
});

describe.skipIf(!configured)("MCP tools (live)", () => {
  let mcp: Client;
  let close: () => Promise<void>;
  let pdfDir: string;

  beforeAll(async () => {
    pdfDir = await mkdtemp(join(tmpdir(), "mk-live-"));
    const handler = createMcpHandler(() => createServer({ pdfDir }));
    mcp = new Client({ name: "live", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL("http://live.local/mcp"), { fetch: (u, i) => handler.fetch(new Request(u, i)) }),
    );
    close = async () => {
      await mcp.close();
      await handler.close();
    };
  });

  afterAll(async () => {
    await close?.();
    await rm(pdfDir, { recursive: true, force: true });
  });

  const today = todayInLjubljana();
  const monthStart = `${today.slice(0, 7)}-01`;

  it.each([
    ["list_warehouses", {}],
    ["get_unpaid_invoices", {}],
    ["sales_summary", { date_from: monthStart, date_to: today, compare_to: "previous_year" }],
    ["purchase_summary", { date_from: monthStart, date_to: today, compare_to: "previous_period" }],
    ["low_stock", {}],
    ["stock_valuation", {}],
    ["get_bank_statements", {}],
    ["search_documents", { doc_type: "complaint", limit: 1 }],
  ])("%s runs without errors", async (name, args) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as { text?: string }[])[0]?.text;
    expect(result.isError, text).toBeFalsy();
  });
});
