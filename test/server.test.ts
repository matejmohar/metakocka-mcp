/**
 * End-to-end: a real MCP Client talks to the server in-process, and the
 * server talks to a fake Metakocka API.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import type { MetakockaClient } from "../src/client.js";
import { ConfigError, SETUP_HELP } from "../src/config.js";
import { createServer } from "../src/server.js";
import { fakeMetakocka, filterValue, invoice, type Handler } from "./fake-metakocka.js";

const NOW = new Date("2026-10-05T10:00:00Z");
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function connect(getClient: () => MetakockaClient) {
  const handler = createMcpHandler(() => createServer({ getClient, now: () => NOW }));
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  cleanup = async () => {
    await client.close();
    await handler.close();
  };
  return client;
}

async function setup(handlers: Record<string, Handler>) {
  const fake = fakeMetakocka(handlers);
  const client = await connect(() => fake.client);
  return { client, calls: fake.calls };
}

function json(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const block = (result.content as { type: string; text: string }[])[0]!;
  return JSON.parse(block.text);
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text: string }[])[0]!.text;
}

const WAREHOUSES = {
  opr_code: "0",
  warehouse_list: [
    { mk_id: "1600000042", mark: "oznaka1", name: "Glavno skladišče", main_warehouse: "true", active: "true" },
    { mk_id: "1600000067", mark: "oznaka2", name: "Maribor", active: "true" },
  ],
};

describe("MCP server", () => {
  it("lists all tools, every one read-only", async () => {
    const { client } = await setup({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_document",
      "get_partner",
      "get_product",
      "get_stock",
      "get_unpaid_invoices",
      "list_search_filters",
      "list_warehouses",
      "low_stock",
      "partner_statement",
      "purchase_summary",
      "sales_summary",
      "search_documents",
      "search_partners",
      "search_products",
      "stock_movements",
      "stock_valuation",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.description, tool.name).toBeTruthy();
    }
  });

  it("lists prompts and resources", async () => {
    const { client } = await setup({ "json/warehouse_list": () => WAREHOUSES });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "customer-review",
      "month-end-checklist",
      "monthly-sales-report",
      "overdue-invoices",
      "payment-reminders",
      "stock-check",
      "weekly-business-digest",
    ]);
    const { contents } = await client.readResource({ uri: "metakocka://warehouses" });
    expect(JSON.parse((contents[0] as { text: string }).text)[0]).toMatchObject({ name: "Glavno skladišče", main: true });
  });

  it("prompts follow the requested language and the document-types resource maps everyday Slovenian terms", async () => {
    const { client } = await setup({});
    const text = async (name: string, args: Record<string, string>) =>
      ((await client.getPrompt({ name, arguments: args })).messages[0]!.content as { text: string }).text;
    expect(await text("monthly-sales-report", { month: "2026-09", language: "sl" })).toContain("Slovenian");
    expect(await text("monthly-sales-report", { month: "2026-09" })).toContain("language the user writes in");
    expect(await text("overdue-invoices", {})).toContain("reminders in Slovenian");
    expect(await text("overdue-invoices", { language: "en" })).toContain("reminders in English");

    const { contents } = await client.readResource({ uri: "metakocka://document-types" });
    const doc = JSON.parse((contents[0] as { text: string }).text);
    expect(doc.types.sales_order).toContain("Prodajno naročilo");
    expect(doc.everyday_terms["dobavnica / odpremnica"]).toBe("warehouse_packing_list");
  });

  it("search_documents builds filters and summarises results", async () => {
    const { client, calls } = await setup({
      search: () => ({
        opr_code: "0",
        result_all_records: "60",
        result_count: "2",
        result: [invoice(), invoice({ mk_id: "2", count_code: "PRD1_495", sum_paid: "22" })],
      }),
    });
    const result = await client.callTool({
      name: "search_documents",
      arguments: {
        doc_type: "sales_bill_domestic",
        date_from: "2026-08-01",
        date_to: "2026-08-31",
        unpaid_only: true,
        partner_tax_number: "SI12345678",
        limit: 2,
      },
    });
    expect(result.isError).toBeFalsy();
    const body = calls[0]!.body;
    expect(calls[0]!.endpoint).toBe("search");
    expect(body).toMatchObject({ doc_type: "sales_bill_domestic", result_type: "doc", limit: 2, offset: 0 });
    expect(filterValue(body, "doc_date_from")).toBe("01.08.2026");
    expect(filterValue(body, "doc_date_to")).toBe("31.08.2026");
    expect(filterValue(body, "payment_status")).toBe("false");
    expect(filterValue(body, "partner_tax_num")).toBe("SI12345678");

    const data = json(result);
    expect(data).toMatchObject({ total_matching: 60, returned: 2, next_offset: 2 });
    expect(data.documents[1]).toEqual({
      id: "2",
      number: "PRD1_495",
      type: "sales_bill_domestic",
      date: "2026-08-10",
      partner: "ACME d.o.o.",
      partner_tax_id: "SI12345678",
      partner_country: "Slovenia",
      currency: "EUR",
      net_total: 100,
      total: 122,
      paid: 22,
      open_amount: 100,
      due_date: "2026-08-25",
      line_count: 1,
    });
  });

  it("rejects unpaid_only for non-invoice documents", async () => {
    const { client, calls } = await setup({});
    const result = await client.callTool({
      name: "search_documents",
      arguments: { doc_type: "sales_order", unpaid_only: true },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/only for invoice types/);
    expect(calls).toHaveLength(0);
  });

  it("validates arguments before calling Metakocka", async () => {
    const { client, calls } = await setup({});
    const result = await client.callTool({
      name: "search_documents",
      arguments: { doc_type: "sales_order", date_from: "1.9.2026" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/YYYY-MM-DD/);
    expect(calls).toHaveLength(0);
  });

  it("get_document finds a document by its number", async () => {
    const { client, calls } = await setup({
      search: () => ({
        opr_code: "0",
        result: [
          { mk_id: "111", count_code: "PP-184951" },
          { mk_id: "222", count_code: "PP-18495" },
        ],
      }),
      get_document: () => ({ ...invoice({ mk_id: "222", count_code: "PP-18495", doc_type: "sales_order" }), opr_time_ms: "5" }),
    });
    const result = await client.callTool({
      name: "get_document",
      arguments: { doc_type: "sales_order", number: "pp-18495" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls[1]).toEqual({
      endpoint: "get_document",
      body: { doc_type: "sales_order", doc_id: "222", company_id: "16", secret_key: "s3cret-key" },
    });
    const doc = json(result);
    expect(doc).toMatchObject({ count_code: "PP-18495", doc_date: "2026-08-10", sum_all: 122 });
    expect(doc.product_list[0]).toMatchObject({ amount: 2, price: 50 });
    expect(doc.opr_code).toBeUndefined();
  });

  it("get_document reports a missing number clearly", async () => {
    const { client } = await setup({ search: () => ({ opr_code: "0", result: [] }) });
    const result = await client.callTool({ name: "get_document", arguments: { doc_type: "sales_order", number: "X-1" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No sales_order with number "X-1"/);
  });

  it("get_stock resolves warehouse names and totals per product", async () => {
    const { client, calls } = await setup({
      "json/warehouse_list": () => WAREHOUSES,
      "json/warehouse_stock": () => ({
        opr_code: "0",
        stock_list: [
          { warehouse_id: "1600000042", count_code: "6967", title: "Pralni stroj", amount: "47", unit: "kos" },
          { warehouse_id: "1600000067", count_code: "6967", title: "Pralni stroj", amount: "3", unit: "kos" },
          { warehouse_id: "1600000067", count_code: "7000", title: "Sušilni stroj", amount: "0", unit: "kos" },
        ],
      }),
    });
    const result = await client.callTool({
      name: "get_stock",
      arguments: { warehouse: "maribor, oznaka1", product_codes: "6967,7000", hide_zero: true },
    });
    expect(calls[1]!.body).toMatchObject({ wh_id_list: "1600000067,1600000042", product_code_list: "6967,7000" });
    const data = json(result);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toMatchObject({ warehouse: "Glavno skladišče", amount: 47 });
    expect(data.totals_per_product).toEqual([{ product_id: "6967", product: "Pralni stroj", amount: 50 }]);
  });

  it("get_stock lists known warehouses when one is unknown", async () => {
    const { client } = await setup({ "json/warehouse_list": () => WAREHOUSES });
    const result = await client.callTool({ name: "get_stock", arguments: { warehouse: "Koper" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Unknown warehouse "Koper".*Maribor \(oznaka2\)/);
  });

  it("search_products maps filters and summarises stock and prices", async () => {
    const { client, calls } = await setup({
      "json/product_list": () => ({
        opr_code: "0",
        product_list: {
          // a single product comes back as an object, not a list
          count_code: "PA_115_PA",
          mk_id: "1600000392",
          code: "art1",
          name: "Majica",
          unit: "kos",
          sales: "true",
          amount: "10",
          amount_detail: [
            { warehouse_name: "moje skladisce", amount: "4" },
            { warehouse_name: "moje skladisce", amount: "6" },
          ],
          pricelist: [{ title: "cenik1", currency_code: "EUR", price_def: { price: "2", amount_to: "10" } }],
        },
      }),
    });
    const result = await client.callTool({
      name: "search_products",
      arguments: { name: "majica", include_stock: true, include_prices: true },
    });
    expect(calls[0]!.body).toMatchObject({
      title: "majica",
      search_with_like: true,
      active: "true",
      return_warehause_stock: "true",
      return_pricelist: "true",
    });
    const data = json(result);
    expect(data.products[0]).toMatchObject({
      code: "art1",
      name: "Majica",
      stock: 10,
      stock_by_warehouse: { "moje skladisce": 10 },
      prices: [{ pricelist: "cenik1", currency: "EUR", price: 2, to_quantity: 10 }],
    });
  });

  it("search_partners requires a search term", async () => {
    const { client } = await setup({});
    const result = await client.callTool({ name: "search_partners", arguments: {} });
    expect(result.isError).toBe(true);
  });

  it("search_partners summarises contacts", async () => {
    const { client, calls } = await setup({
      get_partner: () => ({
        partner_list_count: "1",
        partner_list: [
          {
            mk_id: "228000009447",
            customer: "BAJEC JANEZ",
            count_code: "WE0003085",
            business_entity: "false",
            partner_contact_list: [{ gsm: "051123456", email: "test@test.si" }],
            partner_delivery_address_list: [{ address_type: "Račun", city: "Ljubljana", payment_due_days: "15" }],
          },
        ],
      }),
    });
    const result = await client.callTool({ name: "search_partners", arguments: { name: "janez" } });
    expect(calls[0]!.body).toMatchObject({ partner_name: "janez" });
    expect(json(result).partners[0]).toEqual({
      id: "228000009447",
      code: "WE0003085",
      name: "BAJEC JANEZ",
      business_entity: false,
      contacts: [{ email: "test@test.si", mobile: "051123456" }],
      addresses: [{ type: "Račun", city: "Ljubljana", payment_due_days: 15 }],
    });
  });

  it("get_unpaid_invoices pages through results and builds an aging report", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => invoice({ mk_id: `a${i}`, count_code: `R-${i}` }));
    const page2 = [invoice({ mk_id: "b", count_code: "R-100", partner: { customer: "Beta" }, duo_payment: "20.10.2026" })];
    const { client, calls } = await setup({
      search: (body) => {
        if (body.doc_type !== "sales_bill_domestic") return { opr_code: "0", result_all_records: "0", result: [] };
        return { opr_code: "0", result_all_records: "101", result: body.offset === 0 ? page1 : page2 };
      },
    });
    const result = await client.callTool({ name: "get_unpaid_invoices", arguments: { max_invoices_listed: 2 } });
    expect(result.isError).toBeFalsy();
    const searches = calls.filter((c) => c.endpoint === "search");
    expect(searches.map((c) => [c.body.doc_type, c.body.offset])).toEqual([
      ["sales_bill_domestic", 0],
      ["sales_bill_domestic", 100],
      ["sales_bill_foreign", 0],
    ]);
    expect(filterValue(searches[0]!.body, "payment_status")).toBe("false");

    const data = json(result);
    expect(data.as_of).toBe("2026-10-05");
    expect(data.invoice_count).toBe(101);
    expect(data.totals_by_currency.EUR.open_total).toBe(12322);
    expect(data.totals_by_currency.EUR.aging).toMatchObject({ not_due: 122, "31_60": 12200 });
    expect(data.invoices).toHaveLength(2);
    expect(data.invoices_not_listed).toBe(99);
    expect(data.warning).toBeUndefined();
  });

  it("sales_summary warns when results are truncated", async () => {
    const { client } = await setup({
      search: () => ({ opr_code: "0", result_all_records: "500", result: [invoice()] }),
    });
    const result = await client.callTool({
      name: "sales_summary",
      arguments: { date_from: "2026-09-01", date_to: "2026-09-30", doc_types: ["sales_bill_domestic"], max_documents: 1 },
    });
    const data = json(result);
    expect(data.totals_by_currency.EUR).toEqual({ documents: 1, net: 100, gross: 122 });
    expect(data.warning).toMatch(/incomplete/);
  });

  it("sales_summary rejects a reversed period", async () => {
    const { client } = await setup({});
    const result = await client.callTool({
      name: "sales_summary",
      arguments: { date_from: "2026-09-30", date_to: "2026-09-01" },
    });
    expect(result.isError).toBe(true);
  });

  it("sales_summary compares with the previous period in one call", async () => {
    const { client, calls } = await setup({
      search: (body) => {
        const from = filterValue(body, "doc_date_from");
        const docs =
          from === "01.09.2026"
            ? [invoice({ sum_basic: "300", sum_all: "366" })]
            : [invoice({ sum_basic: "100", sum_all: "122" }), invoice({ partner: { customer: "Lost Ltd" }, sum_basic: "80", sum_all: "97.6" })];
        return { opr_code: "0", result_all_records: String(docs.length), result: docs };
      },
    });
    const result = await client.callTool({
      name: "sales_summary",
      arguments: { date_from: "2026-09-01", date_to: "2026-09-30", doc_types: ["sales_bill_domestic"], compare_to: "previous_period" },
    });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => [filterValue(c.body, "doc_date_from"), filterValue(c.body, "doc_date_to")])).toEqual([
      ["01.09.2026", "30.09.2026"],
      ["01.08.2026", "31.08.2026"],
    ]);
    const data = json(result);
    expect(data.compared_with).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(data.totals_by_currency.EUR).toMatchObject({ net: 300, previous_net: 180, change_net: 120 });
    expect(data.groups[0]).toMatchObject({ partner: "ACME d.o.o.", net: 300, previous_net: 100 });
    expect(data.biggest_declines[0]).toMatchObject({ partner: "Lost Ltd", change_net: -80 });
  });

  it("purchase_summary reads received invoices", async () => {
    const { client, calls } = await setup({
      search: (body) => ({ opr_code: "0", result_all_records: "1", result: [invoice({ doc_type: body.doc_type })] }),
    });
    const result = await client.callTool({
      name: "purchase_summary",
      arguments: { date_from: "2026-09-01", date_to: "2026-09-30" },
    });
    expect(calls.map((c) => c.body.doc_type)).toEqual(["purchase_bill_domestic", "purchase_bill_foreign"]);
    expect(json(result).totals_by_currency.EUR).toEqual({ documents: 2, net: 200, gross: 244 });

    const wrong = await client.callTool({
      name: "purchase_summary",
      arguments: { date_from: "2026-09-01", date_to: "2026-09-30", doc_types: ["sales_bill_domestic"] },
    });
    expect(wrong.isError).toBe(true);
  });

  it("get_product looks a product up exactly and returns full detail", async () => {
    const { client, calls } = await setup({
      "json/product_list": () => ({
        opr_code: "0",
        product_list: [
          {
            count_code: "PA-1",
            code: "k1",
            name: "Kitchen",
            amount: "3",
            free_amount: "1",
            amount_detail: [{ warehouse_name: "Maribor", amount: "3" }],
            reservation_detail: [{ warehouse_name: "Maribor", amount: "2" }],
            order_in_delivery: [{ expect_order_amount: "10", export_order_delivery_date: "2026-10-20", warehouse_mark: "mb" }],
            last_purchase_price: "15.5600000000",
            compound_type: "compound",
            compounds: [{ product_count_code: "PA-2", product_code: "t1", product_title: "Table", amount: "1" }],
          },
        ],
      }),
    });
    const result = await client.callTool({ name: "get_product", arguments: { code: "K1" } });
    expect(calls[0]!.body).toMatchObject({
      code: "K1",
      return_warehause_stock: "true",
      return_pricelist: "true",
      return_warehouse_reservation: "true",
      return_expect_order_delivery_date: "true",
      return_last_purchase_price: "true",
      return_product_compound: "true",
    });
    expect(calls[0]!.body.search_with_like).toBeUndefined();
    expect(json(result)).toMatchObject({
      product_id: "PA-1",
      stock: 3,
      free_stock: 1,
      reserved_by_warehouse: { Maribor: 2 },
      incoming_orders: [{ amount: 10, expected_date: "2026-10-20", warehouse: "mb" }],
      last_purchase_price: 15.56,
      bill_of_materials: { type: "compound (kosovnica)", components: [{ product_id: "PA-2", name: "Table", amount: 1 }] },
    });
  });

  it("get_product says when nothing matches exactly", async () => {
    const { client } = await setup({ "json/product_list": () => ({ opr_code: "0", product_list: [{ count_code: "X", code: "k10" }] }) });
    const result = await client.callTool({ name: "get_product", arguments: { code: "k1" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/No product with code "k1"/);
  });

  const PARTNERS = {
    opr_code: "0",
    partner_list: [
      { mk_id: "11", customer: "Novak d.o.o.", tax_id_number: "SI111" },
      { mk_id: "22", customer: "Novak Trade d.o.o.", tax_id_number: "SI222" },
    ],
  };

  it("get_partner lists the candidates when a name is ambiguous", async () => {
    const { client } = await setup({ get_partner: () => PARTNERS });
    const result = await client.callTool({ name: "get_partner", arguments: { name: "novak" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/2 partners match name "novak": Novak d\.o\.o\. \(partner_id 11, SI111\)/);
  });

  it("get_partner returns detail and open balance, filtering by partner id", async () => {
    const { client, calls } = await setup({
      get_partner: () => PARTNERS,
      search: (body) =>
        body.doc_type === "sales_bill_domestic"
          ? { opr_code: "0", result_all_records: "1", result: [invoice({ sum_paid: "22" })] }
          : { opr_code: "0", result_all_records: "0", result: [] },
    });
    const result = await client.callTool({ name: "get_partner", arguments: { name: "Novak d.o.o." } });
    expect(result.isError).toBeFalsy();
    expect(calls[0]!.body).toMatchObject({ partner_name: "Novak d.o.o.", show_partner_discount: "true" });
    const searches = calls.filter((c) => c.endpoint === "search");
    expect(searches.map((c) => c.body.doc_type)).toEqual([
      "sales_bill_domestic",
      "sales_bill_foreign",
      "purchase_bill_domestic",
      "purchase_bill_foreign",
    ]);
    expect(filterValue(searches[0]!.body, "partner_mk_id")).toBe("11");
    expect(filterValue(searches[0]!.body, "payment_status")).toBe("false");
    const data = json(result);
    expect(data.partner).toMatchObject({ id: "11", name: "Novak d.o.o." });
    expect(data.they_owe_us).toMatchObject({ open_invoices: 1, totals_by_currency: { EUR: { open_total: 100, overdue_total: 100 } } });
    expect(data.they_owe_us.most_overdue).toMatchObject({ number: "PRD1_494", days_overdue: 41 });
    expect(data.we_owe_them).toEqual({ open_invoices: 0, totals_by_currency: {} });
  });

  it("partner_statement fetches the period and the older open documents", async () => {
    const { client, calls } = await setup({
      get_partner: () => PARTNERS,
      search: (body) => {
        if (body.doc_type !== "sales_bill_domestic") return { opr_code: "0", result_all_records: "0", result: [] };
        const older = filterValue(body, "payment_status") === "false";
        const docs = older
          ? [invoice({ count_code: "OLD", doc_date: "10.01.2025", sum_paid: "100" })]
          : [invoice({ count_code: "NEW", sum_paid: "122" })];
        return { opr_code: "0", result_all_records: "1", result: docs };
      },
    });
    const result = await client.callTool({ name: "partner_statement", arguments: { tax_number: "si 111" } });
    expect(result.isError).toBeFalsy();
    const searches = calls.filter((c) => c.endpoint === "search");
    expect(searches).toHaveLength(6);
    expect(filterValue(searches[0]!.body, "doc_date_from")).toBe("06.10.2025");
    expect(filterValue(searches[0]!.body, "doc_date_to")).toBe("05.10.2026");
    expect(filterValue(searches[3]!.body, "doc_date_to")).toBe("05.10.2025");
    expect(searches.map((c) => c.body.doc_type).slice(0, 3)).toEqual([
      "sales_bill_domestic",
      "sales_bill_foreign",
      "sales_bill_credit_note",
    ]);
    const data = json(result);
    expect(data.partner).toEqual({ id: "11", name: "Novak d.o.o.", tax_id: "SI111" });
    expect(data.opening_open_balance).toEqual({ EUR: 22 });
    expect(data.rows).toEqual([
      expect.objectContaining({ number: "NEW", amount: 122, paid: 122, open: 0, running_open_balance: 22 }),
    ]);
  });

  it("low_stock pages through products and flags what to reorder", async () => {
    const goods = Array.from({ length: 1000 }, (_, i) => ({ count_code: `G${i}`, amount: "50", free_amount: "50" }));
    const { client, calls } = await setup({
      "json/product_list": (body) => ({
        opr_code: "0",
        product_list:
          body.offset === 0
            ? goods
            : [
                { count_code: "LOW", name: "Low", amount: "2", free_amount: "2", safety_stock: "10" },
                { count_code: "OUT", name: "Out", amount: "0", free_amount: "0" },
              ],
      }),
    });
    const result = await client.callTool({ name: "low_stock", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.body.offset)).toEqual([0, 1000]);
    expect(calls[0]!.body).toMatchObject({ service: "false", active: "true", sales: "true", return_expect_order_delivery_date: "true" });
    const data = json(result);
    expect(data).toMatchObject({ products_checked: 1002, products_flagged: 2, flag_counts: { out_of_stock: 1, below_safety_stock: 1 } });
    expect(data.products.map((p: { product_id: string }) => p.product_id)).toEqual(["OUT", "LOW"]);
  });

  it("stock_valuation values one warehouse", async () => {
    const { client } = await setup({
      "json/warehouse_list": () => WAREHOUSES,
      "json/product_list": () => ({
        opr_code: "0",
        product_list: [
          {
            count_code: "A",
            last_purchase_price: "10",
            amount_detail: [
              { warehouse_mark: "oznaka2", warehouse_name: "Maribor", amount: "3" },
              { warehouse_mark: "oznaka1", warehouse_name: "Glavno skladišče", amount: "100" },
            ],
          },
        ],
      }),
    });
    const data = json(await client.callTool({ name: "stock_valuation", arguments: { warehouse: "maribor" } }));
    expect(data).toMatchObject({ warehouse: "Maribor", total_value: 30, by_warehouse: [{ warehouse: "Maribor", value: 30 }] });
  });

  it("stock_movements reads warehouse documents and keeps only the product's lines", async () => {
    const { client, calls } = await setup({
      "json/product_list": () => ({ opr_code: "0", product_list: [{ count_code: "P1", code: "wid", name: "Widget", amount: "17" }] }),
      search: (body) => {
        const docs =
          body.doc_type === "warehouse_acceptance_note"
            ? [{ count_code: "PRE-1", doc_date: "01.09.2026", warehouse: "oznaka1", product_list: [{ count_code: "P1", amount: "20" }] }]
            : body.doc_type === "warehouse_packing_list"
              ? [{ count_code: "DOB-1", doc_date: "05.09.2026", warehouse: "oznaka1", product_list: [{ code: "WID", amount: "3" }, { code: "X", amount: "1" }] }]
              : [];
        return { opr_code: "0", result_all_records: String(docs.length), result: docs };
      },
    });
    const result = await client.callTool({ name: "stock_movements", arguments: { product_id: "P1" } });
    expect(result.isError).toBeFalsy();
    const searches = calls.filter((c) => c.endpoint === "search");
    expect(searches.map((c) => c.body.doc_type)).toEqual(["warehouse_acceptance_note", "warehouse_packing_list", "transfer_order"]);
    expect(filterValue(searches[0]!.body, "doc_date_from")).toBe("07.07.2026");
    const data = json(result);
    expect(data).toMatchObject({ current_stock: 17, total_in: 20, total_out: 3, net_change: 17 });
    expect(data.movements.map((m: { number: string; quantity: number }) => [m.number, m.quantity])).toEqual([
      ["PRE-1", 20],
      ["DOB-1", -3],
    ]);
  });

  it("new prompts point at the new tools", async () => {
    const { client } = await setup({});
    const text = async (name: string, args: Record<string, string>) =>
      ((await client.getPrompt({ name, arguments: args })).messages[0]!.content as { text: string }).text;
    expect(await text("payment-reminders", {})).toMatch(/get_unpaid_invoices[\s\S]*partner_statement[\s\S]*in Slovenian/);
    expect(await text("payment-reminders", { customer: "ACME", language: "en" })).toMatch(/partner_statement for the customer "ACME"[\s\S]*in English/);
    expect(await text("customer-review", { customer: "ACME" })).toContain("get_partner");
    expect(await text("weekly-business-digest", { week_ending: "2026-10-04" })).toContain("7 days ending 2026-10-04");
    expect(await text("month-end-checklist", { month: "2026-09" })).toContain("purchase_summary");
    expect(await text("monthly-sales-report", { month: "2026-09" })).toContain("compare_to=previous_period");
  });

  it("explains missing configuration instead of crashing", async () => {
    const client = await connect(() => {
      throw new ConfigError(SETUP_HELP);
    });
    const result = await client.callTool({ name: "list_warehouses", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/METAKOCKA_COMPANY_ID/);
  });

  it("surfaces Metakocka error messages to the model", async () => {
    const { client } = await setup({
      search: () => ({ opr_code: "2", opr_desc: "Paramether 'status_list' has invalid value" }),
    });
    const result = await client.callTool({ name: "search_documents", arguments: { doc_type: "sales_order", status: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Paramether 'status_list' has invalid value");
  });
});
