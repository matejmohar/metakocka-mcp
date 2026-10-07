/**
 * Creating offers: drafting, linking only to existing records, confirmation
 * in the client, exactly-once saving, and checking what Metakocka stored.
 * A real MCP client talks to the server; the server talks to a fake Metakocka.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TtlCache } from "../src/cache.js";
import { ConfigError } from "../src/config.js";
import { createHttpApp } from "../src/http.js";
import { createServer } from "../src/server.js";
import { createWriteContext, type WriteContext } from "../src/tools/write.js";
import { DraftStore } from "../src/write/drafts.js";
import { toCatalogProduct } from "../src/write/catalog.js";
import { writeSettingsFromEnv, type WriteSettings } from "../src/write/settings.js";
import { fakeMetakocka, filterValue, type Body, type Handler } from "./fake-metakocka.js";

const NOW = new Date("2026-10-05T10:00:00Z");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SETTINGS: WriteSettings = { docTypes: ["sales_offer"], confirm: "client", timeoutMs: 120_000 };

/** A write context with a silent audit log. */
const quiet = (settings: WriteSettings = SETTINGS, drafts = new DraftStore()): WriteContext => ({ settings, drafts, journal: async () => {} });

const partner = (over: Record<string, unknown> = {}) => ({
  mk_id: "400068941553",
  customer: "ACME d.o.o.",
  tax_id_number: "SI12345678",
  foreign_county: "false",
  partner_delivery_address_list: [{ mk_id: "400079138037", address_type: "Račun", street: "Glavna 1", post_number: "1000", city: "Ljubljana", country: "Slovenia" }],
  ...over,
});

const priced = (tax = "EX4", rate = "22", price = "35", over: Record<string, unknown> = {}) => [
  { count_code: "1", sales_purchase: "sales", currency_code: "EUR", valid_from: "2026-01-28+02:00", price_def: { price, tax, tax_desc: rate, tax_factor: String(Number(rate) / 100) }, ...over },
];

const PRODUCTS = [
  { mk_id: "P1", count_code: "1", code: "SVC-H", name: "Svetovanje", unit: "ura", service: "true", sales: "true", activated: "true", pricelist: priced() },
  { mk_id: "P2", count_code: "2", code: "SVC-D", name: "Dokumentacija", unit: "kos", service: "true", sales: "true", activated: "true", pricelist: priced("EX4", "22", "20") },
  { mk_id: "P3", count_code: "3", code: "OLD", name: "Star artikel", sales: "true", activated: "false", pricelist: priced() },
  { mk_id: "P4", count_code: "4", code: "INT", name: "Interno", sales: "false", activated: "true", pricelist: priced() },
  { mk_id: "P5", count_code: "5", code: "NOPRICE", name: "Brez cene", sales: "true", activated: "true" },
  { mk_id: "P7", count_code: "7", code: "DOM", name: "Domene", unit: "kos", service: "false", sales: "false", purchasing: "true", activated: "true" },
  { mk_id: "P6", count_code: "6", code: "SUPPORT", name: "Support", unit: "h", service: "true", sales: "true", activated: "true", pricelist: priced("000", "0", "35") },
];

interface FakeOptions {
  partners?: Record<string, unknown>[];
  put?: Handler;
  stored?: (body: Body) => Record<string, unknown>;
  search?: Handler;
  /** Existing documents get_document returns, by id. */
  documents?: Record<string, Record<string, unknown>>;
  /** Products in the catalogue (default PRODUCTS); add_product adds to it. */
  products?: Record<string, unknown>[];
  /** More endpoints, or replacements for the ones above. */
  handlers?: Record<string, Handler>;
}

/** A Metakocka that knows one partner and a small catalogue, and stores offers it is given. */
function metakocka(o: FakeOptions = {}) {
  const partners = [...(o.partners ?? [partner()])];
  const products = [...(o.products ?? PRODUCTS)];
  const saved: Body[] = [];
  const has = (value: unknown, part: unknown) => String(value ?? "").toLowerCase().includes(String(part).toLowerCase());
  const handlers: Record<string, Handler> = {
    get_partner: (body) => {
      const list = partners.filter((p) =>
        body.partner_id ? p.mk_id === body.partner_id : body.partner_name ? has(p.customer, body.partner_name) : has(p.tax_id_number, body.partner_tax_number),
      );
      return list.length ? { opr_code: "0", partner_list: list } : { opr_code: "2", opr_desc: "No partner with such properties." };
    },
    "json/product_list": (body) => ({ opr_code: "0", product_list: Number(body.offset) > 0 ? [] : products }),
    add_partner: (body) => {
      const p = body.partner as Body;
      const id = `NEWP${partners.length}`;
      partners.push({ ...p, mk_id: id, partner_delivery_address_list: [{ mk_id: `${id}A`, address_type: "Račun", street: p.street, post_number: p.post_number, city: p.place, country: p.country }] });
      return { mk_id: id, mk_address_id_list: { mk_id: `${id}A`, street: p.street } };
    },
    "json/product_add": (body) => {
      const id = `NEWPR${products.length}`;
      products.push({ ...body, mk_id: id, count_code: String(products.length + 1), activated: "true" });
      return { opr_code: "0", mk_id: id, count_code: String(products.length) };
    },
    put_document: (body) => {
      saved.push(body);
      if (o.put) return o.put(body);
      return { opr_code: "0", mk_id: `OFFER${saved.length}`, count_code: `${saved.length + 2}/2026`, partner: { mk_id: (body.partner as Body).mk_id } };
    },
    get_document: (body) => {
      const existing = o.documents?.[String(body.doc_id)];
      if (existing) return { opr_code: "0", ...existing };
      const put = saved[Number(String(body.doc_id).replace("OFFER", "")) - 1] ?? saved[0]!;
      return { opr_code: "0", ...(o.stored ? o.stored(put) : storedFrom(put)) };
    },
    search: o.search ?? (() => ({ opr_code: "0", result_all_records: "0", result: [] })),
    ...o.handlers,
  };
  const fake = fakeMetakocka(handlers);
  return { ...fake, saved, partners, products, puts: () => fake.calls.filter((c) => c.endpoint === "put_document") };
}

/** What get_document would return for a put_document body. */
function storedFrom(put: Body) {
  const lines = put.product_list as Body[];
  const total = lines.reduce((s, l) => s + Number(l.amount) * Number(l.price) * (1 - Number(l.discount ?? 0) / 100) * (l.tax === "EX4" ? 1.22 : 1), 0);
  return {
    doc_type: "sales_offer",
    count_code: put.count_code ?? "3/2026",
    partner: { ...(put.partner as Body), customer: "ACME d.o.o." },
    product_list: lines.map((l) => (l.mk_id ? { ...l, code: PRODUCTS.find((p) => p.mk_id === l.mk_id)?.code } : l)),
    sum_all: String(Math.round(total * 100) / 100),
  };
}

type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, boolean> };

async function connect(
  fake: ReturnType<typeof metakocka>,
  { write = quiet(), elicit = true, answer = { action: "accept", content: { confirm: true } } as Answer } = {},
) {
  const prompts: { message: string }[] = [];
  const cache = new TtlCache(60_000);
  const handler = createMcpHandler(() => createServer({ getClient: () => fake.client, now: () => NOW, cache, write }));
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" }, capabilities: elicit ? { elicitation: { form: {} } } : {} },
  );
  if (elicit) {
    client.setRequestHandler("elicitation/create", async (request) => {
      prompts.push(request.params as { message: string });
      return answer;
    });
  }
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
    await handler.close();
  });
  return { client, prompts, write };
}

const parse = (r: Awaited<ReturnType<Client["callTool"]>>) => {
  const text = (r.content as { text: string }[])[0]!.text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const OFFER = { doc_type: "sales_offer", partner_id: "400068941553", lines: [{ product_id: "P1", quantity: 3 }, { code: "SVC-D", quantity: 1 }] };

async function draft(client: Client, args: Record<string, unknown> = OFFER) {
  const r = await client.callTool({ name: "draft_document", arguments: args });
  return { result: r, body: parse(r) };
}

describe("write tools are opt-in", () => {
  it("are absent without a write context, present with one, and the instructions change", async () => {
    const fake = metakocka();
    const readOnly = createMcpHandler(() => createServer({ getClient: () => fake.client }));
    const t = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), { fetch: (u, i) => readOnly.fetch(new Request(u, i)) });
    const c = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await c.connect(t);
    cleanups.push(async () => {
      await c.close();
      await readOnly.close();
    });
    const names = (await c.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain("draft_document");
    expect(names).not.toContain("commit_document");

    const { client } = await connect(fake);
    const tools = (await client.listTools()).tools;
    expect(tools.map((x) => x.name)).toEqual(expect.arrayContaining(["draft_document", "commit_document", "discard_draft"]));
    expect(tools.find((x) => x.name === "commit_document")!.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(client.getInstructions()).toMatch(/can create offers/);
    expect(client.getInstructions()).not.toMatch(/^Read-only/);
  });

  it("settings: off by default, offers and invoices enable, unknown values are refused", () => {
    expect(writeSettingsFromEnv({})).toBeUndefined();
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "off" })).toBeUndefined();
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "offers" })).toMatchObject({ docTypes: ["sales_offer"], confirm: "client", timeoutMs: 120_000 });
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "offers", METAKOCKA_WRITE_CONFIRM: "elicitation" })?.confirm).toBe("elicitation");
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "offers", METAKOCKA_WRITE_CONFIRM: "never" })?.confirm).toBe("never");
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "offers,invoices" })?.docTypes).toEqual(["sales_offer", "sales_bill_domestic", "sales_bill_foreign", "sales_bill_prepaid", "invoice_update"]);
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "invoices" })?.docTypes).toEqual(["sales_bill_domestic", "sales_bill_foreign", "sales_bill_prepaid", "invoice_update"]);
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_PURCHASE_INVOICES: "true" })?.docTypes).toEqual(["purchase_bill_domestic", "purchase_bill_foreign"]);
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "partners,products" })?.docTypes).toEqual(["partner", "partner_update", "product", "product_update"]);
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_PARTNERS: "true", METAKOCKA_WRITE_PRODUCTS: "false" })?.docTypes).toEqual(["partner", "partner_update"]);
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "payments,orders" })?.docTypes).toEqual(["payment", "sales_order", "order_update"]);
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_PAYMENTS: "true", METAKOCKA_WRITE_ORDERS: "true" })?.docTypes).toEqual(["sales_order", "order_update", "payment"]);
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_SHIPPING: "true", METAKOCKA_WRITE_MESSAGES: "true" })?.docTypes).toEqual(["shipping", "message"]);
    expect(() => writeSettingsFromEnv({ METAKOCKA_WRITE: "offers,order" })).toThrow(ConfigError);
    // The Claude Desktop extension's checkboxes.
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "false", METAKOCKA_WRITE_CONFIRM: "true" })).toBeUndefined();
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "true", METAKOCKA_WRITE_CONFIRM: "true" })).toMatchObject({ docTypes: ["sales_offer"], confirm: "client" });
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "true", METAKOCKA_WRITE_CONFIRM: "false" })?.confirm).toBe("never");
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "${user_config.allow_offers}" })).toBeUndefined();
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "false", METAKOCKA_WRITE_INVOICES: "true" })?.docTypes).toEqual(["sales_bill_domestic", "sales_bill_foreign", "sales_bill_prepaid", "invoice_update"]);
    expect(() => writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "yes please" })).toThrow(ConfigError);
    expect(() => writeSettingsFromEnv({ METAKOCKA_WRITE: "offers", METAKOCKA_WRITE_CONFIRM: "sometimes" })).toThrow(ConfigError);
    expect(() => writeSettingsFromEnv({ METAKOCKA_WRITE: "offers", METAKOCKA_WRITE_CONFIRM: "always" })).toThrow(ConfigError);
  });

  it("HTTP mode refuses to enable writing without a bearer token", () => {
    expect(() => createHttpApp({ env: { METAKOCKA_WRITE: "offers" } })).toThrow(/METAKOCKA_HTTP_TOKEN/);
    const app = createHttpApp({ env: { METAKOCKA_WRITE: "offers", METAKOCKA_HTTP_TOKEN: "t0ken" } });
    cleanups.push(app.close);
  });
});

describe("draft_document", () => {
  it("builds the offer from Metakocka's own records and saves nothing", async () => {
    const fake = metakocka();
    const { client } = await connect(fake);
    const { body } = await draft(client);
    expect(body.draft_id).toMatch(/^d_[0-9a-f]{12}$/);
    expect(body.partner).toMatchObject({ id: "400068941553", name: "ACME d.o.o.", addressId: "400079138037" });
    expect(body.lines).toEqual([
      expect.objectContaining({ product_id: "P1", name: "Svetovanje", quantity: 3, price: 35, vat_percent: 22, net: 105, total: 128.1 }),
      expect.objectContaining({ product_id: "P2", name: "Dokumentacija", quantity: 1, price: 20, net: 20, total: 24.4 }),
    ]);
    expect(body.totals).toEqual({ net: 125, tax: 27.5, gross: 152.5, currency: "EUR" });
    expect(body.summary).toBe(
      [
        "Ustvari PONUDBO za ACME d.o.o. (SI12345678)",
        "Glavna 1, 1000 Ljubljana, Slovenia",
        "",
        "Postavke:",
        "  1. 3 × Svetovanje à 35,00 € = 105,00 €",
        "  2. 1 × Dokumentacija à 20,00 € = 20,00 €",
        "",
        "Osnova: 125,00 €",
        "DDV: 27,50 €",
        "Skupaj z DDV: 152,50 €",
        "",
        "Datum 2026-10-05 · velja 30 dni",
      ].join("\n"),
    );
    expect(fake.puts()).toHaveLength(0);
  });

  it("shows the title and note in the summary", async () => {
    const { client } = await connect(metakocka());
    const { body } = await draft(client, { ...OFFER, title: "Projekt", note: "Hvala\nza zaupanje" });
    expect(body.summary).toMatch(/\(SI12345678\)\nGlavna 1, 1000 Ljubljana, Slovenia\nNaziv: Projekt\nOpomba: Hvala za zaupanje\n\nPostavke:/);
  });

  it("refuses anything that isn't an existing, unambiguous record", async () => {
    const fake = metakocka({
      partners: [
        partner(),
        partner({ mk_id: "FOREIGN", customer: "GmbH", foreign_county: "true" }),
        partner({ mk_id: "DISC", customer: "Popust d.o.o.", discounts: [{ categories: "X", discount_percent: "10" }] }),
        partner({ mk_id: "TWO", customer: "Dva naslova", partner_delivery_address_list: [{ mk_id: "A1", street: "Prva 1" }, { mk_id: "A2", street: "Druga 2" }] }),
        partner({ mk_id: "NONE", customer: "Brez naslova", partner_delivery_address_list: [] }),
      ],
    });
    const { client } = await connect(fake);
    const err = async (args: Record<string, unknown>) => {
      const { result, body } = await draft(client, { ...OFFER, ...args });
      expect(result.isError).toBe(true);
      return String(body);
    };
    expect(await err({ partner_id: "999" })).toMatch(/No partner with id 999.*never creates partners/);
    expect(await err({ partner_id: "TWO" })).toMatch(/several addresses.*A1: .*Prva 1.*A2: .*Druga 2/);
    expect(await err({ partner_id: "NONE" })).toMatch(/no address/);
    expect(await err({ address_id: "A1" })).toMatch(/does not belong to ACME/);
    expect(await err({ lines: [{ product_id: "NOPE", quantity: 1 }] })).toMatch(/no product with id NOPE/);
    expect(await err({ lines: [{ code: "MISSING", quantity: 1 }] })).toMatch(/never creates products/);
    expect(await err({ lines: [{ product_id: "P3", quantity: 1 }] })).toMatch(/not active/);
    expect(await err({ lines: [{ product_id: "P4", quantity: 1 }] })).toMatch(/not marked for sale/);
    expect(await err({ lines: [{ product_id: "P5", quantity: 1, price: 10 }] })).toMatch(/no sales price in EUR/);
    expect(await err({ lines: [{ product_id: "P1" }] })).toMatch(/quantity/);
    // Metakocka's put_document has no description-only lines: every row is looked up (or created) as a product.
    expect(await err({ lines: [{ product_id: "P1", quantity: 1 }, { text: "Uvod" }] })).toMatch(/Line 2: .*no description-only lines/);
    expect(fake.puts()).toHaveLength(0);
  });

  it("takes the address the user picked among several", async () => {
    const fake = metakocka({ partners: [partner({ partner_delivery_address_list: [{ mk_id: "A1", street: "Prva 1" }, { mk_id: "A2", street: "Druga 2" }] })] });
    const { client } = await connect(fake);
    const { body } = await draft(client, { ...OFFER, address_id: "A2" });
    expect(body.partner).toMatchObject({ addressId: "A2", address: "Druga 2" });
  });

  it("writes quantities and discounts in the summary's language", async () => {
    const { client } = await connect(metakocka());
    const line = { product_id: "P1", quantity: 1.5, price: 10, discount_percent: 12.5 };
    const { body: sl } = await draft(client, { ...OFFER, lines: [line] });
    expect(sl.summary).toContain("  1. 1,5 × Svetovanje à 10,00 € −12,5 % = 13,13 €");
    const { body: en } = await draft(client, { ...OFFER, lines: [{ ...line, quantity: 1500 }], language: "en" });
    expect(en.summary).toContain("  1. 1500 × Svetovanje à 10.00 € −12.5 % = 13,125.00 €");
  });

  it("uses an explicit price and discount, and rounds per line", async () => {
    const { client } = await connect(metakocka());
    const { body } = await draft(client, { ...OFFER, lines: [{ product_id: "P1", quantity: 3, price: 33.33, discount_percent: 10 }] });
    // 3 × 33.33 × 0.9 = 89.991 → 89.99; VAT 22 % = 19.7978 → 19.80
    expect(body.totals).toEqual({ net: 89.99, tax: 19.8, gross: 109.79, currency: "EUR" });
  });
});

describe("price list rules", () => {
  it("uses a price and tax code only when exactly one entry applies", () => {
    const today = "2026-10-05";
    const base = { mk_id: "X", name: "X", sales: "true", activated: "true" };
    expect(toCatalogProduct({ ...base, pricelist: priced() }, today)).toMatchObject({ price: 35, taxCode: "EX4", taxRatePercent: 22 });
    expect(toCatalogProduct({ ...base, pricelist: priced("000", "0") }, today)).toMatchObject({ taxCode: "000", taxRatePercent: 0 });
    const two = toCatalogProduct({ ...base, pricelist: [...priced(), ...priced("EX4", "22", "40")] }, today);
    expect(two).toMatchObject({ price: undefined, taxCode: "EX4", problem: expect.stringMatching(/several applicable prices/) });
    const mixed = toCatalogProduct({ ...base, pricelist: [...priced(), ...priced("000", "0")] }, today);
    expect(mixed).toMatchObject({ taxCode: undefined, problem: expect.stringMatching(/several tax codes/) });
    expect(toCatalogProduct({ ...base, pricelist: priced("EX4", "22", "35", { valid_to: "2026-09-30+02:00" }) }, today).problem).toMatch(/no sales price/);
    expect(toCatalogProduct({ ...base, pricelist: priced("EX4", "22", "35", { buyer: "ACME" }) }, today).problem).toMatch(/no sales price/);
    expect(toCatalogProduct({ ...base, pricelist: priced("EX4", "22", "35", { currency_code: "USD" }) }, today).problem).toMatch(/no sales price/);
  });
});

describe("commit_document", () => {
  it("asks the user, then sends exactly the drafted request once, and checks what was stored", async () => {
    const fake = metakocka();
    const { client, prompts } = await connect(fake);
    const { body: d } = await draft(client, { ...OFFER, title: "Projekt", note: "Hvala" });
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.message).toBe(d.summary);
    expect(r).toEqual({ status: "created", number: "3/2026", mk_id: "OFFER1", total: 152.5, currency: "EUR", warnings: [] });

    const puts = fake.puts();
    expect(puts).toHaveLength(1);
    const { company_id, secret_key, ...sent } = puts[0]!.body;
    expect(company_id).toBe("16");
    expect(secret_key).toBe("s3cret-key");
    expect(sent).toEqual({
      doc_type: "sales_offer",
      doc_date: "05.10.2026",
      partner: { mk_id: "400068941553", mk_address_id: "400079138037" },
      currency_code: "EUR",
      valid_days: "30",
      title: "Projekt",
      notes: "Hvala",
      product_list: [
        { mk_id: "P1", code: "SVC-H", count_code: "1", amount: "3", price: "35", discount: "0", tax: "EX4" },
        { mk_id: "P2", code: "SVC-D", count_code: "2", amount: "1", price: "20", discount: "0", tax: "EX4" },
      ],
      document_change_log_notes: `metakocka-mcp ${d.draft_id}`,
    });

    // A second commit of the same draft creates nothing.
    const again = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }));
    expect(again).toMatchObject({ status: "already_created", number: "3/2026" });
    expect(fake.puts()).toHaveLength(1);
  });

  it("saves nothing when the user declines, and the draft can still be confirmed later", async () => {
    const fake = metakocka();
    const answers: Answer[] = [{ action: "decline" }, { action: "accept", content: { confirm: false } }, { action: "accept", content: { confirm: true } }];
    const { client } = await connect(fake, { answer: answers[0] });
    const { body: d } = await draft(client);
    const commit = () => client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }).then(parse);
    expect(await commit()).toMatchObject({ status: "cancelled" });
    expect(fake.puts()).toHaveLength(0);
    // Answer "accept" without ticking the box: still nothing.
    Object.assign(answers[0]!, answers[1]);
    expect(await commit()).toMatchObject({ status: "cancelled" });
    Object.assign(answers[0]!, answers[2]);
    expect(await commit()).toMatchObject({ status: "created" });
    expect(fake.puts()).toHaveLength(1);
  });

  it("confirm=elicitation refuses to save when the client can't show a confirmation prompt", async () => {
    const fake = metakocka();
    const { client } = await connect(fake, { write: quiet({ ...SETTINGS, confirm: "elicitation" }), elicit: false });
    const { body: d } = await draft(client);
    const r = await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } });
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatch(/Nothing was saved.*can't show confirmation prompts/);
    expect(fake.puts()).toHaveLength(0);
  });

  it("confirm=client without elicitation: saves only with the draft's exact summary, which the client shows when approving", async () => {
    const fake = metakocka();
    const { client, prompts } = await connect(fake, { elicit: false });
    expect(client.getInstructions()).toMatch(/confirm_summary/);
    const { body: d } = await draft(client);
    expect(d.next).toMatch(/confirm_summary set to the summary/);
    const commit = (args: Record<string, unknown>) => client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id, ...args } });

    const missing = await commit({});
    expect(missing.isError).toBe(true);
    expect(parse(missing)).toMatch(/Nothing was saved\. Pass confirm_summary/);
    const other = await commit({ confirm_summary: d.summary.replace("152,50", "15,25") });
    expect(parse(other)).toMatch(/does not match the draft/);
    expect(fake.puts()).toHaveLength(0);

    // Line endings, indentation and blank lines may change on the way through the client.
    const retyped = d.summary.replace(/\n+/g, "\r\n").replace(/^ +/gm, "");
    expect(parse(await commit({ confirm_summary: `  ${retyped}\n` }))).toMatchObject({ status: "created", number: "3/2026" });
    expect(fake.puts()).toHaveLength(1);
    expect(prompts).toHaveLength(0);
  });

  it("confirm=client prefers a confirmation prompt where the client has one, and ignores confirm_summary then", async () => {
    const fake = metakocka();
    const { client, prompts } = await connect(fake, { answer: { action: "decline" } });
    const { body: d } = await draft(client);
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id, confirm_summary: d.summary } }));
    expect(r).toMatchObject({ status: "cancelled" });
    expect(prompts).toHaveLength(1);
    expect(fake.puts()).toHaveLength(0);
  });

  it("with confirm=never saves without asking", async () => {
    const fake = metakocka();
    const { client, prompts } = await connect(fake, { write: quiet({ ...SETTINGS, confirm: "never" }), elicit: false });
    expect(client.getInstructions()).toMatch(/only after the user has agreed/);
    const { body: d } = await draft(client);
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }))).toMatchObject({ status: "created" });
    expect(prompts).toHaveLength(0);
  });

  it("also confirms over a long-lived 2025-era connection (stdio)", async () => {
    const fake = metakocka();
    const write = quiet();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = createServer({ getClient: () => fake.client, now: () => NOW, write });
    await server.connect(serverSide);
    const client = new Client({ name: "t", version: "1" }, { capabilities: { elicitation: {} } });
    let asked = 0;
    client.setRequestHandler("elicitation/create", async () => {
      asked++;
      return { action: "accept", content: { confirm: true } };
    });
    await client.connect(clientSide);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    const { body: d } = await draft(client);
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }))).toMatchObject({ status: "created" });
    expect(asked).toBe(1);
  });

  it("an unknown or expired draft can't be committed", async () => {
    let now = NOW.getTime();
    const write = quiet(SETTINGS, new DraftStore(() => now));
    const fake = metakocka();
    const { client } = await connect(fake, { write });
    const missing = await client.callTool({ name: "commit_document", arguments: { draft_id: "d_000000000000" } });
    expect(parse(missing)).toMatch(/No draft/);
    const { body: d } = await draft(client);
    now += 16 * 60_000;
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }))).toMatch(/expired/);
    expect(fake.puts()).toHaveLength(0);
  });

  it("a discarded draft can't be committed", async () => {
    const fake = metakocka();
    const { client } = await connect(fake);
    const { body: d } = await draft(client);
    expect(parse(await client.callTool({ name: "discard_draft", arguments: { draft_id: d.draft_id } }))).toEqual({ status: "discarded" });
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }))).toMatch(/discarded/);
    expect(fake.puts()).toHaveLength(0);
  });

  it("when Metakocka refuses, nothing is saved and the error is passed on", async () => {
    const fake = metakocka({ put: () => ({ opr_code: "2", opr_desc: "Product not found" }) });
    const { client } = await connect(fake);
    const { body: d } = await draft(client);
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }));
    expect(r).toMatchObject({ status: "rejected", message: expect.stringMatching(/nothing was saved.*Product not found/) });
    expect(fake.puts()).toHaveLength(1);
  });

  it("a lost answer is never retried; the next commit first looks for the document", async () => {
    let fail = true;
    let found: Body[] = [];
    const fake = metakocka({
      put: (body) => {
        if (fail) throw new TypeError("fetch failed");
        return { opr_code: "0", mk_id: "OFFER1", count_code: "3/2026", partner: body.partner };
      },
      search: () => ({ opr_code: "0", result_all_records: String(found.length), result: found }),
    });
    const { client, prompts } = await connect(fake);
    const { body: d } = await draft(client);
    const commit = () => client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }).then(parse);

    expect(await commit()).toMatchObject({ status: "unknown", message: expect.stringMatching(/Do NOT create it again/) });
    expect(fake.puts()).toHaveLength(1); // no automatic retry

    // Not in Metakocka: the draft may be saved again, after a new confirmation.
    expect(await commit()).toMatchObject({ status: "not_saved" });
    const search = fake.calls.find((c) => c.endpoint === "search")!.body;
    expect(search).toMatchObject({ doc_type: "sales_offer" });
    expect(filterValue(search, "partner_mk_id")).toBe("400068941553");
    // Metakocka can't filter offers by date ("cannot get beQueryParam"); the date is checked on our side.
    expect(filterValue(search, "doc_date_from")).toBeUndefined();
    expect(fake.puts()).toHaveLength(1);

    // Fails again; this time the document turns out to exist.
    expect(await commit()).toMatchObject({ status: "unknown" });
    const offer = { count_code: "3/2026", sum_all: "152.50", product_list: [{}, {}] };
    found = [{ ...offer, mk_id: "OLD", doc_date: "2026-10-04+02:00" }, { ...offer, mk_id: "OFFER1", doc_date: "2026-10-05+02:00" }];
    fail = false;
    const resolved = await commit();
    expect(resolved).toMatchObject({ status: "created", number: "3/2026", warnings: [expect.stringMatching(/found afterwards/)] });
    expect(fake.puts()).toHaveLength(2);
    expect(prompts).toHaveLength(2); // asked before each real attempt, not before the checks
  });

  it("several matching documents after a lost answer: the user decides", async () => {
    const twin = { count_code: "3/2026", doc_date: "2026-10-05+02:00", sum_all: "152.5", product_list: [{}, {}] };
    const fake = metakocka({
      put: () => {
        throw new TypeError("fetch failed");
      },
      search: () => ({ opr_code: "0", result: [{ ...twin, mk_id: "A" }, { ...twin, mk_id: "B", count_code: "4/2026" }] }),
    });
    const { client } = await connect(fake);
    const { body: d } = await draft(client);
    const commit = () => client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }).then(parse);
    await commit();
    expect(await commit()).toMatchObject({ status: "unknown", message: expect.stringMatching(/3\/2026, 4\/2026/) });
    expect(await commit()).toMatchObject({ status: "unknown" });
    expect(fake.puts()).toHaveLength(1);
  });

  it("warns loudly when Metakocka stored something else than was confirmed", async () => {
    const fake = metakocka({
      put: () => ({ opr_code: "0", mk_id: "OFFER1", count_code: "3/2026", partner: { mk_id: "OTHER" } }),
      stored: (put) => ({
        ...storedFrom(put),
        product_list: [{ mk_id: "P1", code: "SVC-H", amount: "3", price: "35", tax: "000" }, { name: "Dokumentacija", mk_id: "P9", code: "NEW", amount: "1", price: "20", tax: "EX4" }],
        sum_all: "125",
      }),
    });
    const { client } = await connect(fake);
    const { body: d } = await draft(client);
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } }));
    expect(r.status).toBe("created");
    expect(r.warnings[0]).toMatch(/CHECK IN METAKOCKA: the document was saved for partner OTHER/);
    expect(r.warnings[1]).toMatch(/line 1 tax 000, not EX4.*line 2 has product NEW.*total 125, not 152.5/);
  });

  it("writes every attempt and its outcome to the audit log, without the secret key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-write-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const logPath = join(dir, "sub", "writes.jsonl");
    const fake = metakocka();
    const { client } = await connect(fake, { write: createWriteContext({ ...SETTINGS, logPath }) });
    const { body: d } = await draft(client);
    await client.callTool({ name: "commit_document", arguments: { draft_id: d.draft_id } });
    const log = await readFile(logPath, "utf8");
    const entries = log.trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.map((e) => e.event)).toEqual(["attempt", "committed"]);
    expect(entries[0]).toMatchObject({ draft_id: d.draft_id, doc_type: "sales_offer", payload: { partner: { mk_id: "400068941553" } } });
    expect(entries[1]).toMatchObject({ mk_id: "OFFER1", number: "3/2026" });
    expect(log).not.toContain("s3cret-key");
  });
});

describe("invoices", () => {
  const INVOICES: WriteSettings = { docTypes: ["sales_offer", "sales_bill_domestic", "sales_bill_foreign"], confirm: "never", timeoutMs: 120_000 };
  const write = () => quiet(INVOICES);
  const DOMESTIC = { doc_type: "sales_bill_domestic", partner_id: "400068941553", lines: [{ product_id: "P1", quantity: 2 }] };
  const withTerm = (days: string) =>
    partner({ partner_delivery_address_list: [{ mk_id: "400079138037", street: "Glavna 1", post_number: "1000", city: "Ljubljana", country: "Slovenia", payment_due_days: days }] });
  const FOREIGN_PARTNER = partner({
    mk_id: "400066072082",
    customer: "Codeer Limited",
    tax_id_number: "CY10383869C",
    foreign_county: "true",
    taxpayer: "true",
    partner_delivery_address_list: [{ mk_id: "400075425335", street: "Theodorou Kolokotroni 3", post_number: "8300", city: "Konia", country: "Cyprus" }],
  });
  const FOREIGN = { doc_type: "sales_bill_foreign", partner_id: "400066072082", lines: [{ code: "SUPPORT", quantity: 10 }] };
  /** Earlier invoices to a partner, as /search returns them. */
  const history = (partnerId: string, docs: Record<string, unknown>[]) => (body: Body) =>
    filterValue(body, "partner_mk_id") === partnerId
      ? { opr_code: "0", result_all_records: String(docs.length), result: docs.map((d) => ({ partner: { mk_id: partnerId }, ...d })) }
      : { opr_code: "0", result_all_records: "0", result: [] };

  it("drafts a domestic invoice: not issued, service date today, payment term from the partner", async () => {
    const fake = metakocka({ partners: [withTerm("15")] });
    const { client } = await connect(fake, { write: write() });
    const { body } = await draft(client, DOMESTIC);
    expect(body).toMatchObject({ due_date: "2026-10-20", due_from: "partner's payment term in Metakocka", service_to: "2026-10-05" });
    expect(body.summary).toBe(
      [
        "Ustvari RAČUN (neizdan) za ACME d.o.o. (SI12345678)",
        "Glavna 1, 1000 Ljubljana, Slovenia",
        "",
        "Postavke:",
        "  1. 2 × Svetovanje à 35,00 € = 70,00 €",
        "",
        "Osnova: 70,00 €",
        "DDV: 15,40 €",
        "Skupaj z DDV: 85,40 €",
        "",
        "Datum 2026-10-05 · storitev 2026-10-05 · rok plačila 2026-10-20",
      ].join("\n"),
    );
    // Nothing had to be looked up in earlier invoices.
    expect(fake.calls.filter((c) => c.endpoint === "search")).toHaveLength(0);

    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r.status).toBe("created");
    const { company_id: _c, secret_key: _s, ...sent } = fake.puts()[0]!.body;
    expect(sent).toEqual({
      doc_type: "sales_bill_domestic",
      doc_date: "05.10.2026",
      service_to_date: "05.10.2026",
      duo_payment: "20.10.2026",
      partner: { mk_id: "400068941553", mk_address_id: "400079138037" },
      currency_code: "EUR",
      product_list: [{ mk_id: "P1", code: "SVC-H", count_code: "1", amount: "2", price: "35", discount: "0", tax: "EX4" }],
      document_change_log_notes: `metakocka-mcp ${body.draft_id}`,
    });
  });

  it("takes the payment term of the partner's last invoice, and asks when there is none", async () => {
    const fake = metakocka({
      search: history("400068941553", [
        { count_code: "RD-1/2026", doc_date: "2026-07-21+02:00", duo_payment: "2026-08-20+02:00" },
        { count_code: "RD-3/2026", doc_date: "2026-09-24+02:00", duo_payment: "2026-10-01+02:00" },
      ]),
    });
    const { client } = await connect(fake, { write: write() });
    const { body } = await draft(client, DOMESTIC);
    expect(body).toMatchObject({ due_date: "2026-10-12", due_from: "7 days, as on the partner's last invoice RD-3/2026" });

    const none = metakocka();
    const { client: c2 } = await connect(none, { write: write() });
    const { result } = await draft(c2, DOMESTIC);
    expect(result.isError).toBe(true);
    expect(parse(result)).toMatch(/no payment term in Metakocka and no earlier invoice.*due_days/);
    const { body: given } = await draft(c2, { ...DOMESTIC, due_days: 8, service_from: "2026-09-01", service_to: "2026-09-30" });
    expect(given).toMatchObject({ due_date: "2026-10-13", due_from: "given" });
    expect(given.summary).toMatch(/storitev 2026-09-01 – 2026-09-30 · rok plačila 2026-10-13$/);
  });

  it("foreign invoices: only for foreign partners, without VAT unless a line asks for it, with the VAT note of the last foreign invoice", async () => {
    const note = "VAT is not calculated in accordance with Article 25 ZDDV-1. Reverse charge.";
    const fake = metakocka({
      partners: [partner(), FOREIGN_PARTNER],
      search: history("400066072082", [{ count_code: "9/2026", doc_date: "2026-10-01+02:00", duo_payment: "2026-10-15+02:00", notes: note }]),
    });
    const { client } = await connect(fake, { write: write() });

    expect(parse((await draft(client, { ...FOREIGN, doc_type: "sales_bill_domestic" })).result)).toMatch(/Codeer Limited is a foreign partner: use doc_type sales_bill_foreign/);
    expect(parse((await draft(client, { ...DOMESTIC, doc_type: "sales_bill_foreign" })).result)).toMatch(/domestic partner: use doc_type sales_bill_domestic/);
    // Without vat_percent a foreign partner's line takes the 0 % code; with it, VAT is charged and questioned for a business.
    const { body: zero } = await draft(client, { ...FOREIGN, lines: [{ product_id: "P1", quantity: 1 }] });
    expect(zero.lines[0]).toMatchObject({ vat_percent: 0, total: 35 });
    const { body: vat } = await draft(client, { ...FOREIGN, lines: [{ product_id: "P1", quantity: 1, vat_percent: 22 }], note: "" });
    expect(vat.lines[0]).toMatchObject({ vat_percent: 22, total: 42.7 });
    expect(vat.warnings[0]).toMatch(/VAT-registered foreign business, yet 1 line\(s\) charge VAT/);
    expect(parse((await draft(client, { ...FOREIGN, lines: [{ product_id: "P1", quantity: 1, vat_percent: 5 }] })).result)).toMatch(/no price list uses a tax code with 5 % VAT/);

    const { body } = await draft(client, FOREIGN);
    expect(body).toMatchObject({ due_date: "2026-10-19", totals: { net: 350, tax: 0, gross: 350 } });
    expect(body.warnings).toEqual(["The note is copied from the partner's last foreign invoice 9/2026."]);
    expect(body.summary).toMatch(/^Ustvari TUJI RAČUN \(neizdan\) za Codeer Limited \(CY10383869C\)\nTheodorou Kolokotroni 3, 8300 Konia, Cyprus\nOpomba: VAT is not calculated/);

    // A product without a price list takes the catalogue's only 0 % tax code.
    const { body: noPrice } = await draft(client, { ...FOREIGN, lines: [{ code: "NOPRICE", quantity: 1, price: 5 }], note: "" });
    expect(noPrice.lines[0]).toMatchObject({ vat_percent: 0, total: 5 });
    await client.callTool({ name: "commit_document", arguments: { draft_id: noPrice.draft_id } });
    const sent = fake.puts()[0]!.body;
    expect(sent.notes).toBeUndefined();
    expect(sent.product_list).toEqual([{ mk_id: "P5", code: "NOPRICE", count_code: "5", amount: "1", price: "5", discount: "0", tax: "000" }]);
  });

  it("a foreign invoice without a note and no earlier one to copy it from asks for the note", async () => {
    const fake = metakocka({ partners: [FOREIGN_PARTNER] });
    const { client } = await connect(fake, { write: write() });
    const { result } = await draft(client, { ...FOREIGN, due_days: 14 });
    expect(parse(result)).toMatch(/needs the VAT note.*no earlier foreign invoice/);
  });

  it("invoices an offer: its partner, its lines as they are, linked to it", async () => {
    const offer = {
      mk_id: "OF4",
      doc_type: "sales_offer",
      count_code: "4/2026",
      partner: { mk_id: "400068941553", mk_address_id: "400079138037", customer: "ACME d.o.o." },
      currency_code: "EUR",
      product_list: [{ mk_id: "P1", code: "SVC-H", amount: "3", price: "30", discount: "10", tax: "EX4" }],
    };
    const fake = metakocka({
      partners: [withTerm("8"), partner({ mk_id: "OTHER", customer: "Other" })],
      documents: { OF4: offer, OF5: { ...offer, mk_id: "OF5", count_code: "5/2026", product_list: [{ name: "Prosta vrstica", amount: "1", price: "5", tax: "EX4" }] } },
      search: (body) => {
        if (body.doc_type === "sales_offer") {
          const hit = [offer, { mk_id: "OF5", count_code: "5/2026" }].find((o) => o.count_code === body.query);
          return { opr_code: "0", result: hit ? [hit] : [] };
        }
        return history("400068941553", [{ count_code: "RD-2/2026", doc_date: "2026-09-15+02:00", offer_list: [{ mk_id: "OF4", count_code: "4/2026" }] }])(body);
      },
    });
    const { client } = await connect(fake, { write: write() });
    const { body } = await draft(client, { doc_type: "sales_bill_domestic", from_offer: "4/2026" });
    expect(body.lines).toEqual([expect.objectContaining({ product_id: "P1", quantity: 3, price: 30, discount_percent: 10, vat_percent: 22, net: 81, total: 98.82 })]);
    expect(body.warnings).toEqual(["Offer 4/2026 already has an invoice: RD-2/2026."]);
    expect(body.summary).toMatch(/\nIz ponudbe: 4\/2026\n/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    expect(fake.puts()[0]!.body).toMatchObject({ offer_list: [{ count_code: "4/2026" }], partner: { mk_id: "400068941553" }, duo_payment: "13.10.2026" });

    expect(parse((await draft(client, { doc_type: "sales_bill_domestic", from_offer: "4/2026", partner_id: "OTHER" })).result)).toMatch(/for another partner/);
    expect(parse((await draft(client, { doc_type: "sales_bill_domestic", from_offer: "5/2026" })).result)).toMatch(/line 1 \(Prosta vrstica\) is not a product/);
    expect(parse((await draft(client, { doc_type: "sales_bill_domestic", from_offer: "99/2026" })).result)).toMatch(/No offer 99\/2026/);
    expect(parse((await draft(client, { ...DOMESTIC, from_offer: "4/2026" })).result)).toMatch(/either lines or from_offer/);
  });

  it("keeps offer and invoice fields apart", async () => {
    const { client } = await connect(metakocka({ partners: [withTerm("8")] }), { write: write() });
    expect(parse((await draft(client, { ...OFFER, due_days: 8 })).result)).toMatch(/due_days: not for sales_offer/);
    expect(parse((await draft(client, { ...DOMESTIC, valid_days: 8 })).result)).toMatch(/valid_days: not for sales_bill_domestic/);
    expect(parse((await draft(client, { ...DOMESTIC, service_from: "2026-10-09", service_to: "2026-10-01" })).result)).toMatch(/service_from is after service_to/);
  });

  it("warns when the saved invoice is already issued or has another due date", async () => {
    const fake = metakocka({
      partners: [withTerm("15")],
      stored: (put) => ({ ...storedFrom(put), duo_payment: "2026-10-30+01:00", publish_ts: "2026-10-05T12:00:00+02:00" }),
    });
    const { client } = await connect(fake, { write: write() });
    const { body } = await draft(client, DOMESTIC);
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r.warnings[0]).toMatch(/due date 2026-10-30, not 2026-10-20; the invoice is already issued/);
  });

  it("the tools describe invoices only when they are on", async () => {
    const { client } = await connect(metakocka(), { write: write() });
    const tool = (await client.listTools()).tools.find((t) => t.name === "draft_document")!;
    expect(tool.title).toBe("Draft a document (offer, invoice)");
    expect(tool.description).toMatch(/saved NOT issued/);
    expect(client.getInstructions()).toMatch(/can create offers \(ponudba \/ predračun\) and invoices/);

    const { client: offersOnly } = await connect(metakocka());
    const offerTool = (await offersOnly.listTools()).tools.find((t) => t.name === "draft_document")!;
    expect(offerTool.description).not.toMatch(/invoice/i);
    expect(Object.keys((offerTool.inputSchema as { properties: object }).properties)).not.toContain("from_offer");
  });
});

describe("purchase invoices", () => {
  const PURCHASES: WriteSettings = { docTypes: ["purchase_bill_domestic", "purchase_bill_foreign"], confirm: "never", timeoutMs: 120_000 };
  const write = (localFiles = false): WriteContext => ({ ...quiet(PURCHASES), localFiles });
  const SUPPLIER = partner({ mk_id: "400072814957", customer: "AVANT.SI d.o.o.", tax_id_number: "SI50709429" });
  const FOREIGN_SUPPLIER = partner({
    mk_id: "400072815162",
    customer: "OpenAI Ireland Limited",
    tax_id_number: "IE3255131SH",
    foreign_county: "true",
    partner_delivery_address_list: [{ mk_id: "400084317622", street: "1st Floor, The Liffey Trust Centre", city: "Dublin", country: "Ireland" }],
  });
  const AVANT = {
    doc_type: "purchase_bill_domestic",
    partner_id: "400072814957",
    supplier_invoice_number: "126-039951",
    invoice_date: "2026-09-30",
    due_date: "2026-10-01",
    invoice_total: 38.98,
    lines: [
      { code: "DOM", quantity: 1, price: 17.21, discount_percent: 4.77, vat_percent: 22, description: "smaragdna.com" },
      { code: "DOM", quantity: 1, price: 16.38, discount_percent: 4.98, vat_percent: 22, description: "martej.si" },
    ],
  };
  const OPENAI = {
    doc_type: "purchase_bill_foreign",
    partner_id: "400072815162",
    supplier_invoice_number: "TYJI3TBO-0007",
    invoice_date: "2026-09-30",
    due_date: "2026-09-30",
    invoice_total: 145.43,
    lines: [
      { code: "DOM", quantity: 1, price: 187.7, vat_percent: 0, description: "Sep 30–Oct 30, 2026" },
      { code: "DOM", quantity: 1, price: -42.27, vat_percent: 0, description: "Unused time after 30 Sep 2026" },
    ],
  };
  const earlier = (partnerId: string, docs: Record<string, unknown>[]) => (body: Body) =>
    filterValue(body, "partner_mk_id") === partnerId
      ? { opr_code: "0", result_all_records: String(docs.length), result: docs.map((d) => ({ partner: { mk_id: partnerId }, ...d })) }
      : { opr_code: "0", result_all_records: "0", result: [] };

  it("copies the supplier's invoice: its number, dates, lines with their text, checked against its total", async () => {
    const fake = metakocka({ partners: [SUPPLIER] });
    const { client } = await connect(fake, { write: write() });
    const { body } = await draft(client, AVANT);
    expect(body).toMatchObject({ supplier_invoice_number: "126-039951", invoice_date: "2026-09-30", received_date: "2026-09-30", due_date: "2026-10-01", due_from: "given" });
    expect(body.totals).toEqual({ net: 31.95, tax: 7.03, gross: 38.98, currency: "EUR" });
    expect(body.summary).toBe(
      [
        "Vnesi PREJETI RAČUN 126-039951 od AVANT.SI d.o.o. (SI50709429)",
        "Glavna 1, 1000 Ljubljana, Slovenia",
        "",
        "Postavke:",
        "  1. 1 × Domene (smaragdna.com) à 17,21 € −4,77 % = 16,39 €",
        "  2. 1 × Domene (martej.si) à 16,38 € −4,98 % = 15,56 €",
        "",
        "Osnova: 31,95 €",
        "DDV: 7,03 €",
        "Skupaj z DDV: 38,98 €",
        "",
        "Datum računa 2026-09-30 · prejeto 2026-09-30 · rok plačila 2026-10-01",
      ].join("\n"),
    );
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    const { company_id: _c, secret_key: _s, ...sent } = fake.puts()[0]!.body;
    expect(sent).toEqual({
      doc_type: "purchase_bill_domestic",
      count_code: "126-039951",
      doc_date: "30.09.2026",
      receive_date: "30.09.2026",
      duo_payment: "01.10.2026",
      partner: { mk_id: "400072814957", mk_address_id: "400079138037" },
      currency_code: "EUR",
      product_list: [
        { mk_id: "P7", code: "DOM", count_code: "7", amount: "1", price: "17.21", discount: "4.77", tax: "EX4", doc_desc: "smaragdna.com" },
        { mk_id: "P7", code: "DOM", count_code: "7", amount: "1", price: "16.38", discount: "4.98", tax: "EX4", doc_desc: "martej.si" },
      ],
      document_change_log_notes: `metakocka-mcp ${body.draft_id}`,
    });

    // The same number again is refused, even before Metakocka shows it.
    expect(parse((await draft(client, AVANT)).result)).toMatch(/126-039951 from AVANT.SI d.o.o. is already in Metakocka/);
  });

  it("refuses what doesn't add up or isn't there", async () => {
    const fake = metakocka({
      partners: [SUPPLIER, FOREIGN_SUPPLIER],
      search: earlier("400072814957", [{ count_code: "126 - 039951".replace(/ /g, ""), doc_date: "2026-09-30+02:00", duo_payment: "2026-10-01+02:00" }]),
    });
    const { client } = await connect(fake, { write: write() });
    const err = async (args: Record<string, unknown>) => parse((await draft(client, args)).result);
    expect(await err(AVANT)).toMatch(/already in Metakocka/);
    const fresh = { ...AVANT, supplier_invoice_number: "126-040000" };
    expect(await err({ ...fresh, invoice_total: 39.98 })).toMatch(/lines add up to 38.98 with VAT, but invoice_total is 39.98/);
    expect(await err({ ...fresh, lines: [{ code: "SVC-H", quantity: 1, price: 1, vat_percent: 22 }], invoice_total: 1.22 })).toMatch(/Svetovanje is not marked for purchasing/);
    expect(await err({ ...fresh, lines: [{ code: "DOM", quantity: 1, price: 1, vat_percent: 9.5 }], invoice_total: 1.1 })).toMatch(/no tax code with 9.5 % VAT/);
    expect(await err({ ...fresh, lines: [{ code: "DOM", quantity: 1, price: 1 }], invoice_total: 1.22 })).toMatch(/give vat_percent/);
    expect(await err({ ...fresh, lines: [{ quantity: 1, price: 1, vat_percent: 22 }], invoice_total: 1.22 })).toMatch(/give product_id \(or code\) of the product this cost is booked to/);
    expect(await err({ ...fresh, supplier_invoice_number: undefined })).toMatch(/Give supplier_invoice_number/);
    expect(await err({ ...fresh, invoice_total: undefined })).toMatch(/Give invoice_total/);
    expect(await err({ ...fresh, invoice_date: "2026-11-01" })).toMatch(/invoice_date is in the future/);
    expect(await err({ ...fresh, doc_type: "purchase_bill_foreign" })).toMatch(/domestic partner: use doc_type purchase_bill_domestic/);

    // Without a due date, the supplier's last invoice gives the term.
    const { body } = await draft(client, { ...fresh, due_date: undefined, invoice_date: "2026-10-03" });
    expect(body).toMatchObject({ due_date: "2026-10-04", due_from: "1 day, as on the supplier's last invoice 126-039951" });
  });

  it("leaves out a negative line, and says so on the invoice and in the summary", async () => {
    const fake = metakocka({ partners: [FOREIGN_SUPPLIER] });
    const { client } = await connect(fake, { write: write() });
    const { body } = await draft(client, OPENAI);
    expect(body.totals).toMatchObject({ gross: 187.7 });
    expect(body.left_out).toEqual([{ description: "Unused time after 30 Sep 2026 (Domene)", net: -42.27, total: -42.27 }]);
    expect(body.warnings[0]).toMatch(/^1 negative line\(s\) are left out/);
    expect(body.summary).toMatch(/^Vnesi TUJI PREJETI RAČUN TYJI3TBO-0007 od OpenAI Ireland Limited \(IE3255131SH\)\n[^\n]+\n\nPostavke:/);
    expect(body.summary).toMatch(
      /\n⚠ NI VNESENO — dodaj ročno v Metakocki \(navedeno tudi v opombi računa\):\n {2}− Unused time after 30 Sep 2026 \(Domene\) −42,27 €\n/,
    );
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    const sent = fake.puts()[0]!.body;
    expect(sent.product_list).toEqual([{ mk_id: "P7", code: "DOM", count_code: "7", amount: "1", price: "187.7", discount: "0", tax: "000", doc_desc: "Sep 30–Oct 30, 2026" }]);
    expect(sent.notes).toBe("Ročno dodaj vrstice, ki jih API ne sprejme: Unused time after 30 Sep 2026 (Domene) −42,27 €");
  });

  it("attaches the supplier's file once saved, only when the server runs locally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-att-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const pdf = join(dir, "racun.pdf");
    await writeFile(pdf, "%PDF-1.1 test");
    const attached: Body[] = [];
    // add_attachment lives next to the API's base path, outside the fake's routes.
    const withAttach = metakocka({ partners: [SUPPLIER] });
    const original = withAttach.client.call.bind(withAttach.client);
    withAttach.client.call = (async (endpoint: string, params: Body, options: unknown) => {
      if (endpoint === "../add_attachment") {
        attached.push(params);
        return { opr_code: "0" };
      }
      return original(endpoint, params, options as never);
    }) as typeof withAttach.client.call;

    const remote = await connect(withAttach, { write: write(false) });
    expect(parse((await draft(remote.client, { ...AVANT, attachment_path: pdf })).result)).toMatch(/only possible when the server runs on the user's computer/);

    const { client } = await connect(withAttach, { write: write(true) });
    expect(parse((await draft(client, { ...AVANT, attachment_path: "racun.pdf" })).result)).toMatch(/absolute path/);
    expect(parse((await draft(client, { ...AVANT, attachment_path: join(dir, "x.exe") })).result)).toMatch(/only .pdf/);
    const { body } = await draft(client, { ...AVANT, attachment_path: pdf });
    expect(body.attachment).toBe("racun.pdf");
    expect(body.summary).toMatch(/\nPriloga: racun.pdf$/);
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r.warnings).toEqual([]);
    expect(attached).toEqual([
      { doc_type: "purchase_bill_domestic", mk_id: "OFFER1", attachment_list: [{ file_name: "racun.pdf", data_b64: Buffer.from("%PDF-1.1 test").toString("base64") }] },
    ]);
  });
});

describe("new partners and products", () => {
  const ALL: WriteSettings = { docTypes: ["purchase_bill_domestic", "purchase_bill_foreign", "partner", "product"], confirm: "never", timeoutMs: 120_000 };
  const SHOP = {
    name: "Big Bang, d.o.o.",
    street: "Šmartinska cesta 152",
    post_number: "1000",
    city: "Ljubljana",
    tax_id: "SI42678013",
    business_entity: true,
    taxpayer: true,
    role: "supplier",
  };
  const RADIO = { name: "Drobni inventar", code: "DI", unit: "kos", service: false, purchasing: true };

  it("drafts a supplier from its invoice, saves it once, and it can be used right away", async () => {
    const fake = metakocka();
    const { client } = await connect(fake, { write: quiet(ALL) });
    const before = await client.callTool({ name: "search_partners", arguments: { tax_number: "SI42678013" } });
    expect(JSON.stringify(parse(before))).not.toContain("Big Bang");

    const { body } = parseDraft(await client.callTool({ name: "draft_partner", arguments: SHOP }));
    expect(body.summary).toBe(
      ["Dodaj PARTNERJA Big Bang, d.o.o. (SI42678013)", "Šmartinska cesta 152, 1000 Ljubljana, Slovenija", "dobavitelj · pravna oseba · davčni zavezanec: da · tujina: ne"].join("\n"),
    );
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r).toMatchObject({ status: "created", mk_id: "NEWP1", address_id: "NEWP1A", warnings: [] });
    const sent = fake.calls.find((c) => c.endpoint === "add_partner")!.body.partner;
    expect(sent).toEqual({
      business_entity: "true",
      taxpayer: "true",
      foreign_county: "false",
      supplier: "true",
      buyer: "false",
      customer: "Big Bang, d.o.o.",
      tax_id_number: "SI42678013",
      street: "Šmartinska cesta 152",
      post_number: "1000",
      place: "Ljubljana",
      country: "Slovenija",
    });
    // The cached "not found" is gone.
    const after = await client.callTool({ name: "search_partners", arguments: { tax_number: "SI42678013" } });
    expect(JSON.stringify(parse(after))).toContain("Big Bang");
    // Saved once; the same tax number again is refused, with or without the SI prefix.
    expect(parse((await client.callTool({ name: "draft_partner", arguments: { ...SHOP, tax_id: "42678013", name: "BigBang" } })))).toMatch(
      /Big Bang, d.o.o. \(id NEWP1\) already has the tax number SI42678013/,
    );
  });

  it("partners: refuses what is already there or incomplete, shows similar names", async () => {
    const fake = metakocka({ partners: [partner(), partner({ mk_id: "P-BB", customer: "Big Bang trgovina", tax_id_number: "SI11111111" })] });
    const { client } = await connect(fake, { write: quiet(ALL) });
    const draftP = async (args: Record<string, unknown>) => parseDraft(await client.callTool({ name: "draft_partner", arguments: args }));
    expect((await draftP({ ...SHOP, tax_id: undefined })).text).toMatch(/A company needs its tax_id/);
    expect((await draftP({ ...SHOP, name: "ACME d.o.o.", tax_id: undefined, business_entity: false })).text).toMatch(/ACME d.o.o. \(id 400068941553\) is already in Metakocka/);
    const { body } = await draftP(SHOP);
    expect(body.warnings[0]).toMatch(/Similar partners already exist: Big Bang trgovina \(id P-BB\)/);
    expect(body.summary).toMatch(/\n\n⚠ Podobni partnerji že obstajajo: Big Bang trgovina$/);
    const foreign = await draftP({ ...SHOP, name: "OpenAI Ireland Limited", tax_id: "IE3255131SH", country: "Ireland", taxpayer: true });
    expect(foreign.body.summary).toMatch(/tujina: da/);
  });

  it("drafts a product for purchasing, refuses a used code or name, and the catalogue sees it at once", async () => {
    const fake = metakocka({ partners: [partner({ mk_id: "SUP", customer: "Big Bang, d.o.o." })] });
    const { client } = await connect(fake, { write: quiet(ALL) });
    const draftPr = async (args: Record<string, unknown>) => parseDraft(await client.callTool({ name: "draft_product", arguments: args }));
    expect((await draftPr({ ...RADIO, code: "SVC-H" })).text).toMatch(/code SVC-H is already used by Svetovanje/);
    expect((await draftPr({ ...RADIO, name: "svetovanje", code: "X" })).text).toMatch(/Svetovanje \(code SVC-H, id P1\) is already in Metakocka/);
    expect((await draftPr({ ...RADIO, purchasing: false })).text).toMatch(/for purchasing, for sales, or both/);

    const purchase = {
      doc_type: "purchase_bill_domestic",
      partner_id: "SUP",
      supplier_invoice_number: "BB-1",
      invoice_date: "2026-10-05",
      due_days: 0,
      invoice_total: 89.99,
      lines: [{ code: "DI", quantity: 1, price: 73.76, vat_percent: 22, description: "Prenosni radio JBL Tuner 3" }],
    };
    // Before: the line's product is missing, and the error points to draft_product.
    expect(parse((await draft(client, purchase)).result)).toMatch(/no product DI.*add it with draft_product/);

    const { body } = await draftPr(RADIO);
    expect(body.summary).toBe("Dodaj IZDELEK Drobni inventar (šifra DI)\nenota kos · blago · nabavni");
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r).toMatchObject({ status: "created", mk_id: "NEWPR7" });
    expect(fake.calls.find((c) => c.endpoint === "json/product_add")!.body).toMatchObject({
      code: "DI",
      name: "Drobni inventar",
      unit: "kos",
      service: "false",
      sales: "false",
      purchasing: "true",
    });
    // After: the catalogue (cached for the day) has it.
    const { body: inv } = await draft(client, purchase);
    expect(inv.totals).toMatchObject({ net: 73.76, tax: 16.23, gross: 89.99 });
  });

  it("only the tools that are turned on are there, and a missing partner points to draft_partner only then", async () => {
    const recordsOnly = await connect(metakocka(), { write: quiet({ ...ALL, docTypes: ["partner"] }) });
    const names = (await recordsOnly.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["draft_partner", "commit_document"]));
    expect(names).not.toContain("draft_document");
    expect(names).not.toContain("draft_product");
    expect(recordsOnly.client.getInstructions()).toMatch(/can create partners\. .*use draft_partner.*products are never created here/);

    const withPartners = await connect(metakocka(), { write: quiet(ALL) });
    const missing = { doc_type: "purchase_bill_domestic", partner_id: "NOPE", supplier_invoice_number: "1", invoice_date: "2026-10-01", invoice_total: 1, lines: [] };
    expect(parse((await draft(withPartners.client, { ...missing, lines: [{ code: "DOM", quantity: 1, price: 1, vat_percent: 0 }] })).result)).toMatch(
      /never creates partners.*add it with draft_partner/,
    );
    const without = await connect(metakocka(), { write: quiet({ ...ALL, docTypes: ["purchase_bill_domestic"] }) });
    expect(parse((await draft(without.client, { ...missing, lines: [{ code: "DOM", quantity: 1, price: 1, vat_percent: 0 }] })).result)).not.toMatch(/draft_partner/);
  });
});

function parseDraft(r: Awaited<ReturnType<Client["callTool"]>>) {
  const body = parse(r);
  return { body, text: typeof body === "string" ? body : JSON.stringify(body) };
}

describe("sales orders", () => {
  const ORDERS: WriteSettings = { docTypes: ["sales_bill_domestic", "sales_order", "order_update"], confirm: "never", timeoutMs: 120_000 };
  const ORDER = { doc_type: "sales_order", partner_id: "400068941553", lines: [{ product_id: "P1", quantity: 2 }] };

  it("drafts and saves a sales order with the customer's order number and delivery date", async () => {
    const fake = metakocka();
    const { client } = await connect(fake, { write: quiet(ORDERS) });
    expect(client.getInstructions()).toMatch(/can create sales orders \(prodajno naročilo\) and invoices \(račun, saved not issued; also from an offer or order\)/);
    expect(parse((await draft(client, { ...ORDER, delivery_date: "2026-10-01" })).result)).toMatch(/delivery_date is in the past/);
    expect(parse((await draft(client, { ...ORDER, due_days: 5 })).result)).toMatch(/due_days: not for sales_order/);
    const { body } = await draft(client, { ...ORDER, buyer_order: "PO-77", delivery_date: "2026-10-20", title: "Jesen" });
    expect(body.summary).toBe(
      [
        "Ustvari PRODAJNO NAROČILO za ACME d.o.o. (SI12345678)",
        "Glavna 1, 1000 Ljubljana, Slovenia",
        "Naročilo kupca: PO-77",
        "Naziv: Jesen",
        "",
        "Postavke:",
        "  1. 2 × Svetovanje à 35,00 € = 70,00 €",
        "",
        "Osnova: 70,00 €",
        "DDV: 15,40 €",
        "Skupaj z DDV: 85,40 €",
        "",
        "Datum 2026-10-05 · rok dobave 2026-10-20",
      ].join("\n"),
    );
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r).toMatchObject({ status: "created", warnings: [] });
    const { company_id: _c, secret_key: _s, ...sent } = fake.puts()[0]!.body;
    expect(sent).toEqual({
      doc_type: "sales_order",
      doc_date: "05.10.2026",
      partner: { mk_id: "400068941553", mk_address_id: "400079138037" },
      currency_code: "EUR",
      title: "Jesen",
      buyer_order: "PO-77",
      delivery_deadline: "20.10.2026",
      product_list: [{ mk_id: "P1", code: "SVC-H", count_code: "1", amount: "2", price: "35", discount: "0", tax: "EX4" }],
      document_change_log_notes: `metakocka-mcp ${body.draft_id}`,
    });
  });

  it("invoices a sales order, linked to it through sales_order_list", async () => {
    const order = {
      mk_id: "SO1",
      doc_type: "sales_order",
      count_code: "1/2026",
      partner: { mk_id: "400068941553", mk_address_id: "400079138037", customer: "ACME d.o.o." },
      currency_code: "EUR",
      product_list: [{ mk_id: "P2", code: "SVC-D", amount: "1", price: "20", discount: "0", tax: "EX4" }],
    };
    const fake = metakocka({
      documents: { SO1: order },
      search: (body) =>
        body.doc_type === "sales_order"
          ? { opr_code: "0", result: body.query === "1/2026" ? [order] : [] }
          : { opr_code: "0", result_all_records: "1", result: [{ partner: { mk_id: "400068941553" }, count_code: "RD-1/2026", doc_date: "2026-09-01+02:00", duo_payment: "2026-09-09+02:00", sales_order_list: [{ count_code: "1/2026" }] }] },
    });
    const { client } = await connect(fake, { write: quiet(ORDERS) });
    const { body } = await draft(client, { doc_type: "sales_bill_domestic", from_order: "1/2026" });
    expect(body).toMatchObject({ from_order: "1/2026", totals: { gross: 24.4 } });
    expect(body.warnings).toEqual(["Sales order 1/2026 already has an invoice: RD-1/2026."]);
    expect(body.summary).toMatch(/\nIz prodajnega naročila: 1\/2026\n/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    const sent = fake.puts()[0]!.body;
    expect(sent.sales_order_list).toEqual([{ count_code: "1/2026" }]);
    expect(sent.offer_list).toBeUndefined();
    expect(parse((await draft(client, { doc_type: "sales_bill_domestic", from_order: "1/2026", from_offer: "4/2026" })).result)).toMatch(/either from_offer or from_order/);

    // Without orders turned on, invoices can't be made from them.
    const invoicesOnly = await connect(metakocka(), { write: quiet({ ...ORDERS, docTypes: ["sales_bill_domestic"] }) });
    const tool = (await invoicesOnly.client.listTools()).tools.find((t) => t.name === "draft_document")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).not.toContain("from_order");
  });

  it("changes an order's status and tracking code with draft_update, checking statuses in use and reading it back", async () => {
    let order: Record<string, unknown> = { mk_id: "SO9", count_code: "PP-9", status_code: "Novo naročilo", partner: { mk_id: "400068941553", customer: "ACME d.o.o." } };
    const updates: Body[] = [];
    const fake = metakocka({
      search: (body) =>
        body.query === "PP-9"
          ? { opr_code: "0", result: [{ mk_id: "SO9", count_code: "PP-9" }] }
          : { opr_code: "0", result: [{ count_code: "PP-1", status_code: "Novo naročilo" }, { count_code: "PP-2", status_code: "Odpremljen" }] },
      handlers: {
        get_document: () => ({ opr_code: "0", ...order }),
        update_document: (body) => {
          updates.push(body);
          if (body.status_code === "Izgubljen") return { opr_code: "1", opr_desc: "Dinamični šifrant z vrednostjo ''Izgubljen'' tipa ''Prodajna naročila - status'' mora biti nastavljen" };
          const { company_id: _c, secret_key: _s, doc_type: _t, mk_id: _m, ...fields } = body;
          order = { ...order, ...fields, ...(fields.shipped_date ? { shipped_date: "2026-10-05+02:00" } : {}) };
          return { opr_code: "0" };
        },
      },
    });
    const { client } = await connect(fake, { write: quiet(ORDERS) });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("draft_update");
    expect(names).not.toContain("draft_shipping");
    const update = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_update", arguments: { doc_type: "sales_order", number: "PP-9", ...args } }));

    expect(await update({ status: "novo naročilo" })).toMatch(/already has all of that/);
    expect(await update({})).toMatch(/Nothing to change\. sales_order takes: status, tracking_code/);

    const bad = await update({ status: "Izgubljen" });
    expect(bad.warnings[0]).toMatch(/statuses in use: Novo naročilo, Odpremljen/);
    const refused = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: bad.draft_id } }));
    expect(refused).toMatchObject({ status: "rejected" });

    const ok = await update({ status: "Odpremljen", tracking_code: "TC1", shipped_date: "2026-10-05" });
    expect(ok.summary).toBe(
      "Spremeni sales_order PP-9 (ACME d.o.o.)\n  status: Novo naročilo → Odpremljen\n  tracking_code: (prazno) → TC1\n  shipped_date: (prazno) → 2026-10-05",
    );
    const done = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: ok.draft_id } }));
    expect(done).toMatchObject({ status: "created", number: "PP-9", warnings: [] });
    const { company_id: _c, secret_key: _s, ...sent } = updates.at(-1)!;
    expect(sent).toEqual({ doc_type: "sales_order", mk_id: "SO9", status_code: "Odpremljen", tracking_code: "TC1", shipped_date: "05.10.2026" });
  });

  it("create_invoice can't be read back: a lost answer leaves it to the user", async () => {
    const fake = metakocka({
      search: () => ({ opr_code: "0", result: [{ mk_id: "SO9", count_code: "PP-9" }] }),
      handlers: {
        get_document: () => ({ opr_code: "0", mk_id: "SO9", count_code: "PP-9", partner: { customer: "ACME d.o.o." } }),
        update_document: () => new Response("", { status: 502 }),
      },
    });
    const { client } = await connect(fake, { write: quiet(ORDERS) });
    const body = parse(await client.callTool({ name: "draft_update", arguments: { doc_type: "sales_order", number: "PP-9", create_invoice: true } }));
    expect(body.warnings[0]).toMatch(/use draft_document with from_order/);
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }))).toMatchObject({ status: "unknown" });
    const again = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(again.status).toBe("unknown");
    expect(fake.calls.filter((c) => c.endpoint === "update_document")).toHaveLength(1);
  });
});

describe("payments", () => {
  const PAYMENTS: WriteSettings = { docTypes: ["payment"], confirm: "client", timeoutMs: 120_000 };

  /** A Metakocka holding one invoice whose payments put_transaction adds to. */
  function withInvoice(over: Record<string, unknown> = {}, { lose = false } = {}) {
    const invoice = {
      mk_id: "INV2",
      doc_type: "sales_bill_domestic",
      count_code: "RD-2/2026",
      doc_date: "2026-09-20+02:00",
      currency_code: "EUR",
      partner: { mk_id: "400068941553", customer: "ACME d.o.o." },
      sum_all: "2000",
      sum_paid: "500",
      mark_paid: [{ payment_type: "Transakcijski račun", date: "2026-09-25+02:00", amount: "500", payment_tip: "Plačilo" }],
      ...over,
    } as Record<string, unknown>;
    const transactions: Body[] = [];
    const fake = metakocka({
      search: (body) =>
        body.query === "RD-2/2026"
          ? { opr_code: "0", result: [{ mk_id: "INV2", count_code: "RD-2/2026" }] }
          : { opr_code: "0", result: [{ mark_paid: [{ payment_type: "Gotovina" }, { payment_type: "Kartica" }, { payment_type: "Kartica" }] }] },
      handlers: {
        get_document: (body) => {
          expect(body.show_payment_detail).toBe("true");
          return { opr_code: "0", ...invoice };
        },
        put_transaction: (body) => {
          transactions.push(body);
          const change = (body.payment_mode === "return" ? -1 : 1) * Number(body.price);
          invoice.sum_paid = String(Number(invoice.sum_paid ?? 0) + change);
          if (lose) return new Response("", { status: 502 });
          return { opr_code: "0" };
        },
      },
    });
    return { fake, transactions, invoice };
  }

  it("drafts the open amount with the usual payment type, saves it once and checks the paid amount", async () => {
    const { fake, transactions } = withInvoice();
    const { client, prompts } = await connect(fake, { write: quiet(PAYMENTS) });
    expect(client.getInstructions()).toMatch(/it can record payments\. draft_payment records a payment/);
    const body = parse(await client.callTool({ name: "draft_payment", arguments: { doc_type: "sales_bill_domestic", number: "RD-2/2026", date: "2026-10-03" } }));
    expect(body.summary).toBe(
      [
        "Zabeleži PLAČILO 1500,00 € na RD-2/2026 (ACME d.o.o.)",
        "Datum 2026-10-03 · Transakcijski račun",
        "",
        "Skupaj: 2000,00 € · plačano doslej: 500,00 € · odprto po vnosu: 0,00 €",
      ].join("\n"),
    );
    expect(transactions).toHaveLength(0);
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(prompts).toHaveLength(1);
    expect(r).toMatchObject({ status: "created", number: "RD-2/2026", paid_now: 2000, warnings: [] });
    const { company_id: _c, secret_key: _s, ...sent } = transactions[0]!;
    expect(sent).toEqual({
      doc_type: "sales_bill_domestic",
      mk_id: "INV2",
      payment_mode: "payment",
      payment_type: "Transakcijski račun",
      date: "03.10.2026",
      price: "1500.00",
    });
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }))).toMatchObject({ status: "already_created" });
    expect(transactions).toHaveLength(1);
  });

  it("refuses more than is open, a paid invoice, a future date, and a prepayment on an invoice", async () => {
    const { fake } = withInvoice();
    const { client } = await connect(fake, { write: quiet(PAYMENTS) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_payment", arguments: { doc_type: "sales_bill_domestic", number: "RD-2/2026", ...args } }));
    expect(await call({ amount: 1600 })).toMatch(/has 1500 open.*can't be more than that/);
    expect(await call({ date: "2026-10-06" })).toMatch(/can't be in the future/);
    expect(await call({ mode: "prepayment" })).toMatch(/prepayment \(avans\) goes on an offer or a sales order/);
    expect(await call({ mode: "return", amount: 600 })).toMatch(/Only 500 has been paid/);
    expect(await call({ number: "RD-99/2026" })).toMatch(/No sales_bill_domestic with number RD-99\/2026/);

    const paid = withInvoice({ sum_paid: "2000" });
    const { client: c2 } = await connect(paid.fake, { write: quiet(PAYMENTS) });
    expect(parse(await c2.callTool({ name: "draft_payment", arguments: { doc_type: "sales_bill_domestic", number: "RD-2/2026" } }))).toMatch(/already paid in full/);
  });

  it("without earlier payments on the document takes the most common type from others, and warns of a likely duplicate", async () => {
    const { fake } = withInvoice({ mark_paid: [{ payment_type: "", date: "2026-10-05+02:00", amount: "100,00" }] });
    const { client } = await connect(fake, { write: quiet(PAYMENTS) });
    const body = parse(await client.callTool({ name: "draft_payment", arguments: { doc_type: "sales_bill_domestic", number: "RD-2/2026", amount: 100, note: "nakazilo" } }));
    expect(body.summary).toMatch(/^Zabeleži PLAČILO 100,00 € na RD-2\/2026 \(ACME d.o.o.\)\nDatum 2026-10-05 · Kartica\nOpomba: nakazilo\n/);
    expect(body.warnings).toEqual(["RD-2/2026 already has a payment of 100 on 2026-10-05. Make sure this is another one."]);
  });

  it("refuses to save when the paid amount changed since drafting", async () => {
    const { fake, invoice, transactions } = withInvoice();
    const { client } = await connect(fake, { write: quiet({ ...PAYMENTS, confirm: "never" }) });
    const body = parse(await client.callTool({ name: "draft_payment", arguments: { doc_type: "sales_bill_domestic", number: "RD-2/2026" } }));
    invoice.sum_paid = "2000";
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r.status).toBe("rejected");
    expect(r.message).toMatch(/paid amount of RD-2\/2026 changed since this was drafted/);
    expect(transactions).toHaveLength(0);
  });

  it("a lost answer is never retried; the next commit finds the payment on the document", async () => {
    const { fake, transactions } = withInvoice({}, { lose: true });
    const { client } = await connect(fake, { write: quiet({ ...PAYMENTS, confirm: "never" }) });
    const body = parse(await client.callTool({ name: "draft_payment", arguments: { doc_type: "sales_bill_domestic", number: "RD-2/2026", amount: 200 } }));
    const first = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(first.status).toBe("unknown");
    expect(transactions).toHaveLength(1);
    const second = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(second).toMatchObject({ status: "created", paid_now: 700, warnings: ["The save had not answered; the payment was found on the document afterwards."] });
    expect(transactions).toHaveLength(1);
  });
});

describe("credit notes, prepayment invoices, purchase and warehouse documents", () => {
  const SETTINGS_ALL: WriteSettings = {
    docTypes: ["sales_bill_domestic", "sales_bill_prepaid", "sales_bill_credit_note", "purchase_order", "warehouse_packing_list", "warehouse_acceptance_note", "transfer_order", "workorder"],
    confirm: "never",
    timeoutMs: 120_000,
  };
  const INVOICE = {
    mk_id: "INV7",
    doc_type: "sales_bill_domestic",
    count_code: "RD-7/2026",
    partner: { mk_id: "400068941553", mk_address_id: "400079138037", customer: "ACME d.o.o." },
    currency_code: "EUR",
    product_list: [
      { mk_id: "P1", code: "SVC-H", amount: "3", price: "30", discount: "0", tax: "EX4" },
      { mk_id: "P8", code: "BOX", amount: "2", price: "10", discount: "0", tax: "EX4" },
    ],
    sum_all: "134.2",
  };
  const ORDER = { ...INVOICE, mk_id: "SO3", doc_type: "sales_order", count_code: "3/2026" };
  const WAREHOUSES = { opr_code: "0", warehouse_list: [{ mk_id: "W1", mark: "glavno", name: "Glavno skladišče" }, { mk_id: "W2", mark: "mb", name: "Maribor" }] };
  const BOX = { mk_id: "P8", count_code: "8", code: "BOX", name: "Škatla", unit: "kos", service: "false", sales: "true", purchasing: "true", activated: "true", pricelist: priced("EX4", "22", "10") };
  const fake = () =>
    metakocka({
      products: [...PRODUCTS, BOX],
      documents: { INV7: INVOICE, SO3: ORDER },
      search: (body) => {
        const hit = [INVOICE, ORDER].find((d) => d.doc_type === body.doc_type && d.count_code === body.query);
        return { opr_code: "0", result_all_records: hit ? "1" : "0", result: hit ? [hit] : [] };
      },
      handlers: { "json/warehouse_list": () => WAREHOUSES },
    });

  it("credits returned goods at the invoice's prices, at most what was invoiced", async () => {
    const f = fake();
    const { client } = await connect(f, { write: quiet(SETTINGS_ALL) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_credit_note", arguments: args }));
    expect(await call({ credit_type: "goods", from_invoice: "RD-7/2026", lines: [{ code: "BOX", quantity: 3 }] })).toMatch(/at most 2, as invoiced/);
    expect(await call({ credit_type: "goods", from_invoice: "RD-7/2026", lines: [{ code: "SVC-D", quantity: 1 }] })).toMatch(/SVC-D is not on invoice RD-7\/2026/);
    expect(await call({ credit_type: "financial", from_invoice: "RD-7/2026", lines: [{ code: "BOX", quantity: 1 }] })).toMatch(/financial credit note takes only services/);
    expect(await call({ credit_type: "financial", from_invoice: "RD-7/2026", lines: [{ code: "SVC-H", quantity: 10 }] })).toMatch(/more than invoice RD-7\/2026/);

    const body = await call({ credit_type: "goods", from_invoice: "RD-7/2026", lines: [{ code: "BOX", quantity: 1 }] });
    expect(body.summary).toMatch(/^Ustvari DOBROPIS \(neizdan\) — vračilo blaga — za ACME d\.o\.o\. \(SI12345678\)\nGlavna 1, 1000 Ljubljana, Slovenia\nK računu: RD-7\/2026\n/);
    expect(body.totals).toMatchObject({ net: 10, gross: 12.2 });
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    const { company_id: _c, secret_key: _s, document_change_log_notes: _n, ...sent } = f.puts()[0]!.body;
    expect(sent).toEqual({
      doc_type: "sales_bill_credit_note",
      doc_date: "05.10.2026",
      service_to_date: "05.10.2026",
      duo_payment: "05.10.2026",
      credit_note_type: "goods",
      credit_note_bill: "RD-7/2026",
      partner: { mk_id: "400068941553", mk_address_id: "400079138037" },
      currency_code: "EUR",
      product_list: [{ mk_id: "P8", code: "BOX", count_code: "8", amount: "1", price: "10", discount: "0", tax: "EX4" }],
    });
    const whole = await call({ credit_type: "goods", from_invoice: "RD-7/2026" });
    expect(whole.warnings).toEqual(["This credits invoice RD-7/2026 in full."]);
  });

  it("drafts a prepayment invoice like an invoice", async () => {
    const f = fake();
    const { client } = await connect(f, { write: quiet(SETTINGS_ALL) });
    const { body } = await draft(client, { doc_type: "sales_bill_prepaid", partner_id: "400068941553", lines: [{ product_id: "P1", quantity: 1 }], due_days: 8 });
    expect(body.summary).toMatch(/^Ustvari AVANSNI RAČUN \(neizdan\) za ACME/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    expect(f.puts()[0]!.body.doc_type).toBe("sales_bill_prepaid");
  });

  it("makes a packing list from a sales order, linked to it, and says it takes the goods out of stock", async () => {
    const f = fake();
    const { client } = await connect(f, { write: quiet(SETTINGS_ALL) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_stock_document", arguments: args }));
    expect(await call({ doc_type: "warehouse_packing_list", from_order: "3/2026" })).toMatch(/Give the warehouse: Glavno skladišče, Maribor/);
    expect(await call({ doc_type: "warehouse_packing_list", from_order: "3/2026", warehouse: "mb", to_warehouse: "glavno" })).toMatch(/to_warehouse: not for warehouse_packing_list/);
    const body = await call({ doc_type: "warehouse_packing_list", from_order: "3/2026", warehouse: "Maribor" });
    expect(body.warnings).toEqual(["Saving it takes the goods out of stock in Maribor."]);
    expect(body.summary).toMatch(/^Ustvari DOBAVNICO za ACME d\.o\.o\. \(SI12345678\)\nGlavna 1, 1000 Ljubljana, Slovenia\nIz prodajnega naročila: 3\/2026\nSkladišče: Maribor\n/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    expect(f.puts()[0]!.body).toMatchObject({
      doc_type: "warehouse_packing_list",
      warehouse: "mb",
      sales_order_list: [{ count_code: "3/2026" }],
      product_list: [expect.objectContaining({ mk_id: "P1", amount: "3", price: "30" }), expect.objectContaining({ mk_id: "P8", amount: "2" })],
    });
  });

  it("purchase orders and goods received notes take purchase prices and VAT rates", async () => {
    const f = fake();
    const { client } = await connect(f, { write: quiet(SETTINGS_ALL) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_stock_document", arguments: args }));
    expect(await call({ doc_type: "purchase_order", partner_id: "400068941553", lines: [{ code: "BOX", quantity: 5, price: 4 }] })).toMatch(/give vat_percent/);
    const po = await call({ doc_type: "purchase_order", partner_id: "400068941553", lines: [{ code: "BOX", quantity: 5, price: 4, vat_percent: 22 }], delivery_date: "2026-10-20", warehouse: "glavno" });
    expect(po.summary).toMatch(/^Ustvari NAROČILNICO za ACME/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: po.draft_id } });
    expect(f.puts()[0]!.body).toMatchObject({ doc_type: "purchase_order", warehouse_delivery: "glavno", delivery_date: "20.10.2026", product_list: [{ mk_id: "P8", amount: "5", price: "4", tax: "EX4" }] });

    const gr = await call({ doc_type: "warehouse_acceptance_note", partner_id: "400068941553", warehouse: "glavno", supplier_document: "DOB-55", lines: [{ code: "BOX", quantity: 5, price: 4, vat_percent: 22 }] });
    expect(gr.warnings).toEqual(["Saving it puts the goods into stock in Glavno skladišče."]);
    await client.callTool({ name: "commit_document", arguments: { draft_id: gr.draft_id } });
    expect(f.puts()[1]!.body).toMatchObject({ doc_type: "warehouse_acceptance_note", warehouse: "glavno", packlist_code: "DOB-55" });
  });

  it("transfers between warehouses and work orders go to their own endpoints", async () => {
    const f = metakocka({
      products: [...PRODUCTS, BOX],
      documents: { SO3: ORDER },
      search: (body) => ({ opr_code: "0", result: body.query === "3/2026" ? [ORDER] : [] }),
      handlers: {
        "json/warehouse_list": () => WAREHOUSES,
        put_document_transfer_order: () => ({ opr_code: "0", mk_id: "T1" }),
        put_document_workorder: () => ({ opr_code: "0", mk_id: "WO1", count_code: "DN-1" }),
        get_document: (body) =>
          body.doc_id === "T1"
            ? { opr_code: "0", product_list: [{ mk_id: "P8", amount: "2" }] }
            : body.doc_id === "SO3"
              ? { opr_code: "0", ...ORDER }
              : { opr_code: "0", partner: { mk_id: "400068941553", mk_address_id: "400079138037" }, product_list: [] },
      },
    });
    const { client } = await connect(f, { write: quiet(SETTINGS_ALL) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_stock_document", arguments: args }));
    expect(await call({ doc_type: "transfer_order", warehouse: "glavno", to_warehouse: "Glavno skladišče", lines: [{ code: "BOX", quantity: 2 }] })).toMatch(/are the same/);
    expect(await call({ doc_type: "transfer_order", warehouse: "glavno", to_warehouse: "mb", lines: [{ code: "SVC-H", quantity: 2 }] })).toMatch(/is a service/);
    const t = await call({ doc_type: "transfer_order", warehouse: "glavno", to_warehouse: "mb", confirm: true, lines: [{ code: "BOX", quantity: 2 }] });
    expect(t.summary).toMatch(/^Ustvari MEDSKLADIŠČNI PRENOS Glavno skladišče → Maribor \(potrjen: premakne zalogo\)\n\n  1\. 2 × Škatla kos\n/);
    const saved = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: t.draft_id } }));
    expect(saved).toMatchObject({ status: "created", mk_id: "T1", warnings: [] });
    const transfer = f.calls.find((c) => c.endpoint === "put_document_transfer_order")!.body;
    expect(transfer).toMatchObject({ doc_date: "05.10.2026", warehouseIdFrom: "W1", warehouseIdTo: "W2", confirmed: "true", product_list: [{ mk_id: "P8", amount: "2" }] });

    const wo = await call({ doc_type: "workorder", from_order: "3/2026", title: "Izdelava", delivery_date: "2026-10-30" });
    await client.callTool({ name: "commit_document", arguments: { draft_id: wo.draft_id } });
    expect(f.calls.find((c) => c.endpoint === "put_document_workorder")!.body).toMatchObject({
      start_date: "05.10.2026",
      produce_deadline_date: "30.10.2026",
      title: "Izdelava",
      sales_order_list: [{ count_code: "3/2026" }],
      partner: { mk_id: "400068941553" },
    });
  });
});

describe("changing partners and products", () => {
  const RECORDS: WriteSettings = { docTypes: ["partner", "partner_update", "product", "product_update"], confirm: "never", timeoutMs: 120_000 };

  it("changes only the partner fields given, shows old and new, and reads it back", async () => {
    const updates: Body[] = [];
    const f = metakocka({
      handlers: {
        update_partner: (body) => {
          updates.push(body);
          const p = body.partner as Body;
          Object.assign(f.partners[0]!, { supplier: p.supplier, buyer: p.buyer });
          return { opr_code: "0" };
        },
      },
    });
    Object.assign(f.partners[0]!, { buyer: "true", supplier: "false" });
    const { client } = await connect(f, { write: quiet(RECORDS) });
    expect(parse(await client.callTool({ name: "draft_partner_update", arguments: { partner_id: "400068941553", role: "buyer" } }))).toMatch(/Nothing to change/);
    const body = parse(await client.callTool({ name: "draft_partner_update", arguments: { partner_id: "400068941553", role: "both" } }));
    expect(body.summary).toBe("Spremeni PARTNERJA ACME d.o.o. (SI12345678)\n  vloga: buyer → both");
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r).toMatchObject({ status: "created", mk_id: "400068941553", warnings: [] });
    expect(updates[0]!.partner).toEqual({ mk_id: "400068941553", supplier: "true", buyer: "true" });
  });

  it("changes a product's price on its one price list, and refuses tiered prices", async () => {
    const products = [
      { ...PRODUCTS[0], safety_stock: "2" },
      { mk_id: "PT", count_code: "9", code: "TIER", name: "Stopnje", sales: "true", activated: "true", pricelist: [{ count_code: "1", sales_purchase: "sales", price_def: [{ amount_from: "0", amount_to: "10", price: "5", tax: "EX4" }, { amount_from: "10", price: "4", tax: "EX4" }] }] },
    ];
    const f = metakocka({
      products,
      handlers: {
        "json/product_update": (body) => {
          const p = products.find((x) => x.mk_id === body.mk_id) as Record<string, unknown>;
          if (body.safety_stock) p.safety_stock = body.safety_stock;
          if (body.pricelist) p.pricelist = priced("EX4", "22", String(((body.pricelist as Body[])[0]!.price_def as Body[])[0]!.price));
          return { opr_code: "0", mk_id: body.mk_id };
        },
      },
    });
    const { client } = await connect(f, { write: quiet(RECORDS) });
    expect(parse(await client.callTool({ name: "draft_product_update", arguments: { product_id: "PT", price: 3 } }))).toMatch(/has a tiered price/);
    const body = parse(await client.callTool({ name: "draft_product_update", arguments: { product_id: "P1", price: 40, safety_stock: 5 } }));
    expect(body.summary).toBe("Spremeni IZDELEK Svetovanje (šifra SVC-H)\n  varnostna zaloga: 2 → 5\n  cena (1): 35,00 € → 40,00 €");
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r).toMatchObject({ status: "created", warnings: [] });
    const sent = f.calls.find((c) => c.endpoint === "json/product_update")!.body;
    expect(sent).toMatchObject({ mk_id: "P1", safety_stock: "5", pricelist: [{ count_code: "1", price_def: [{ amount_from: "0", amount_to: null, tax: "EX4", price: "40" }] }] });
  });
});

describe("shipping, complaints and messages", () => {
  const OUT: WriteSettings = { docTypes: ["shipping", "complaint", "message"], confirm: "never", timeoutMs: 120_000 };
  const order = (n: string, over: Record<string, unknown> = {}) => ({
    mk_id: `SO${n}`,
    count_code: `PP-${n}`,
    buyer_order: `WEB-${n}`,
    partner: { mk_id: "400068941553", customer: "ACME d.o.o." },
    product_list: [{ mk_id: "P8", code: "BOX", name: "Škatla", amount: "2" }],
    ...over,
  });

  it("labels: reports per order, and after a lost answer checks the tracking codes instead of printing again", async () => {
    const orders: Record<string, Record<string, unknown>> = { SO1: order("1"), SO2: order("2") };
    let lose = false;
    const f = metakocka({
      search: (body) => ({ opr_code: "0", result: Object.values(orders).filter((o) => o.count_code === body.query) }),
      handlers: {
        get_document: (body) => ({ opr_code: "0", ...orders[String(body.doc_id)] }),
        generate_sticker: () => {
          orders.SO1!.tracking_code = "CF1SI";
          if (lose) return new Response("", { status: 502 });
          return {
            opr_code: "0",
            generate_sticker: [
              { opr_code: "0", mk_id: "SO1", sales_order_count_code: "PP-1", sticker_public_url: "https://s3/l1.pdf", tracking_code: "CF1SI" },
              { opr_code: "1", mk_id: "SO2", sales_order_count_code: "PP-2", error_desc: "Napačna poštna številka | " },
            ],
            generate_sticker_join_document: "https://s3/all.pdf",
          };
        },
      },
    });
    const { client } = await connect(f, { write: quiet(OUT) });
    const body = parse(await client.callTool({ name: "draft_shipping", arguments: { action: "labels", orders: ["PP-1", "PP-2"] } }));
    expect(body.summary).toBe("Natisni NALEPKE dostavne službe za 2 naročil(a): PP-1, PP-2");
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(r).toMatchObject({
      status: "created",
      details: { labels: [{ order: "PP-1", tracking_code: "CF1SI", label_url: "https://s3/l1.pdf" }], failed: [{ order: "PP-2", error: "Napačna poštna številka" }], all_labels_pdf: "https://s3/all.pdf" },
    });
    expect(r.warnings).toContain("No label for PP-2 (Napačna poštna številka).");

    delete orders.SO1!.tracking_code;
    lose = true;
    const again = parse(await client.callTool({ name: "draft_shipping", arguments: { action: "labels", orders: ["PP-1"] } }));
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: again.draft_id } }))).toMatchObject({ status: "unknown" });
    const resolved = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: again.draft_id } }));
    expect(resolved).toMatchObject({ status: "created" });
    expect(f.calls.filter((c) => c.endpoint === "generate_sticker")).toHaveLength(2);
  });

  it("complaints: products must be on the order; updates need a status", async () => {
    const f = metakocka({
      search: (body) => ({ opr_code: "0", result: body.doc_type === "sales_order" && body.query === "PP-1" ? [order("1")] : body.doc_type === "complaint" && body.query === "RK-4" ? [{ mk_id: "C4", count_code: "RK-4" }] : [] }),
      handlers: {
        get_document: (body) => (body.doc_type === "complaint" ? { opr_code: "0", mk_id: "C4", count_code: "RK-4", claim_type: "return", claim_status: "draft" } : { opr_code: "0", ...order("1") }),
        "../create_complaint": () => ({ opr_code: "0" }),
        "../update_complaint": () => ({ opr_code: "0" }),
      },
    });
    const { client } = await connect(f, { write: quiet(OUT) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_complaint", arguments: args }));
    expect(await call({ action: "create", claim_type: "return", order_number: "PP-1", products: [{ code: "BOX", quantity: 3 }] })).toMatch(/only 2 of Škatla were ordered/);
    expect(await call({ action: "update", complaint_number: "RK-4" })).toMatch(/Give status/);
    const body = await call({ action: "create", claim_type: "return", order_number: "PP-1", products: [{ code: "BOX", quantity: 1, reason: "poškodovano" }], iban: "SI56 0201 0001 2345 678" });
    expect(body.summary).toMatch(/^Ustvari VRAČILO za naročilo PP-1 \(ACME d\.o\.o\.\)\nIzdelki:\n  1\. 1 × Škatla — poškodovano\nIBAN: SI56 0201 0001 2345 678/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    const { company_id: _c, secret_key: _s, ...sent } = f.calls.find((c) => c.endpoint === "../create_complaint")!.body;
    expect(sent).toEqual({
      claim_type: "return",
      sales_order_count_code: "PP-1",
      partner: { iban: "SI56020100012345678" },
      complaint_products: [{ mk_id: "P8", code: "BOX", amount: "1", complaint_reason: "poškodovano" }],
    });
    const upd = await call({ action: "update", complaint_number: "RK-4", status: "completed", note: "Vrnjeno" });
    expect(upd.summary).toBe("Spremeni REKLAMACIJO RK-4\n  status: draft → completed\n  opomba: Vrnjeno");
    await client.callTool({ name: "commit_document", arguments: { draft_id: upd.draft_id } });
    expect(f.calls.find((c) => c.endpoint === "../update_complaint")!.body).toMatchObject({ claim_id: "C4", claim_type: "return", claim_status: "completed", claim_note: "Vrnjeno" });
  });

  it("messages: shows exactly what is sent, reports a refused message, and never resends after a lost answer", async () => {
    let answer: unknown = { opr_code: "0", message_list: [{ mk_id: "19", sender_message_id: "m1", status: "ok" }] };
    const f = metakocka({ handlers: { "../send_message": () => answer } });
    const { client } = await connect(f, { write: quiet(OUT) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_message", arguments: args }));
    expect(await call({ channel: "sms", to_number: "041 111 222", text: "x", subject: "y" })).toMatch(/subject is only for e-mail/);
    const sms = await call({ channel: "sms", to_number: "041 111 222", country: "SI", text: "Paket je na poti." });
    expect(sms.summary).toBe("POŠLJI SMS (takoj, ni ga mogoče preklicati)\nZa: 041 111 222 (SI)\n\nPaket je na poti.");
    expect(parse(await client.callTool({ name: "commit_document", arguments: { draft_id: sms.draft_id } }))).toMatchObject({ status: "created", mk_id: "19" });
    expect(f.calls.at(-1)!.body.message_list).toEqual([{ type: "sms", to_number: "041 111 222", receiver_country: "SI", message: "Paket je na poti.", message_type: "transactional" }]);

    const mail = await call({ channel: "email", to_emails: ["janez@example.com"], from_email: "shop@martej.com", subject: "Naročilo", body: "Pozdravljeni,\n\nhvala <3" });
    answer = { opr_code: "0", message_list: [{ sender_message_id: "m1", status: "error", error_desc: "email_to_list : ni veljaven" }] };
    const refused = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: mail.draft_id } }));
    expect(refused).toMatchObject({ status: "rejected", message: "Metakocka did not send the message: email_to_list : ni veljaven" });
    expect((f.calls.at(-1)!.body.message_list as Body[])[0]!.email_html_body).toBe("<p>Pozdravljeni,</p><p>hvala &lt;3</p>");

    answer = new Response("", { status: 502 });
    const lost = await call({ channel: "sms", to_number: "041 111 222", text: "Še enkrat." });
    const first = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: lost.draft_id } }));
    expect(first.status).toBe("unknown");
    expect(first.message).toMatch(/can't be checked automatically: check with get_messages/);
    const second = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: lost.draft_id } }));
    expect(second.status).toBe("unknown");
    expect(f.calls.filter((c) => c.endpoint === "../send_message")).toHaveLength(3);
  });
});

describe("foreign partners and other currencies", () => {
  const ALL: WriteSettings = {
    docTypes: ["sales_offer", "sales_order", "sales_bill_domestic", "sales_bill_foreign", "sales_bill_prepaid", "sales_bill_credit_note", "purchase_bill_credit_note", "payment"],
    confirm: "never",
    timeoutMs: 120_000,
  };
  const GMBH = partner({
    mk_id: "DE1",
    customer: "Kunde GmbH",
    tax_id_number: "DE123456789",
    foreign_county: "true",
    taxpayer: "true",
    partner_delivery_address_list: [{ mk_id: "DEA", street: "Hauptstraße 1", post_number: "10115", city: "Berlin", country: "Germany", payment_due_days: "14" }],
  });
  const PERSON = partner({ mk_id: "AT1", customer: "Hans Huber", tax_id_number: "", foreign_county: "true", taxpayer: "false", partner_delivery_address_list: [{ mk_id: "ATA", street: "Ring 1", post_number: "1010", city: "Wien", country: "Austria", payment_due_days: "0" }] });

  it("offers and orders to foreign partners: no VAT by default, VAT when a line asks for it", async () => {
    const f = metakocka({ partners: [GMBH, PERSON] });
    const { client } = await connect(f, { write: quiet(ALL) });
    const { body: offer } = await draft(client, { doc_type: "sales_offer", partner_id: "DE1", lines: [{ product_id: "P1", quantity: 2 }] });
    expect(offer.lines[0]).toMatchObject({ vat_percent: 0, total: 70 });
    expect(offer.warnings ?? []).toEqual([]);
    const { body: order } = await draft(client, { doc_type: "sales_order", partner_id: "AT1", lines: [{ product_id: "P1", quantity: 1 }] });
    expect(order.warnings[0]).toMatch(/Hans Huber is a foreign private person/);
    const { body: withVat } = await draft(client, { doc_type: "sales_order", partner_id: "AT1", lines: [{ product_id: "P1", quantity: 1, vat_percent: 22 }] });
    expect(withVat.lines[0]).toMatchObject({ vat_percent: 22, total: 42.7 });
    expect(withVat.warnings ?? []).toEqual([]);
  });

  it("documents in another currency need every price, and show and send that currency", async () => {
    const f = metakocka({ partners: [GMBH] });
    const { client } = await connect(f, { write: quiet(ALL) });
    expect(parse((await draft(client, { doc_type: "sales_offer", partner_id: "DE1", currency: "usd", lines: [{ product_id: "P1", quantity: 1 }] })).result)).toMatch(/give the price of Svetovanje in USD/);
    expect(parse((await draft(client, { doc_type: "sales_offer", partner_id: "DE1", currency: "us1", lines: [{ product_id: "P1", quantity: 1, price: 1 }] })).result)).toMatch(/is not an ISO code/);
    const { body } = await draft(client, { doc_type: "sales_bill_foreign", partner_id: "DE1", currency: "USD", note: "Reverse charge.", lines: [{ product_id: "P1", quantity: 2, price: 40 }] });
    expect(body.totals).toEqual({ net: 80, tax: 0, gross: 80, currency: "USD" });
    expect(body.summary).toMatch(/2 × Svetovanje à 40,00 USD = 80,00 USD/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    expect(f.puts()[0]!.body).toMatchObject({ doc_type: "sales_bill_foreign", currency_code: "USD", product_list: [expect.objectContaining({ price: "40", tax: "000" })] });
  });

  it("an invoice from an offer in another currency takes that currency", async () => {
    const offer = { mk_id: "OFU", doc_type: "sales_offer", count_code: "8/2026", currency_code: "GBP", partner: { mk_id: "DE1", mk_address_id: "DEA" }, product_list: [{ mk_id: "P1", amount: "1", price: "30", tax: "000" }] };
    const f = metakocka({
      partners: [GMBH],
      documents: { OFU: offer },
      search: (body) => (body.doc_type === "sales_offer" ? { opr_code: "0", result: [offer] } : { opr_code: "0", result: [{ partner: { mk_id: "DE1" }, count_code: "5/2026", notes: "Reverse charge." }] }),
    });
    const { client } = await connect(f, { write: quiet(ALL) });
    expect(parse((await draft(client, { doc_type: "sales_bill_foreign", from_offer: "8/2026", currency: "EUR" })).result)).toMatch(/is in GBP; the invoice takes its currency/);
    const { body } = await draft(client, { doc_type: "sales_bill_foreign", from_offer: "8/2026" });
    expect(body.totals).toMatchObject({ gross: 30, currency: "GBP" });
  });

  it("payments are in the document's currency", async () => {
    const f = metakocka({
      search: () => ({ opr_code: "0", result: [{ mk_id: "INVU", count_code: "3/2026" }] }),
      handlers: { get_document: () => ({ opr_code: "0", mk_id: "INVU", count_code: "3/2026", currency_code: "USD", partner: { customer: "Codeer" }, sum_all: "100", sum_paid: "0", mark_paid: [{ payment_type: "Transakcijski račun" }] }) },
    });
    const { client } = await connect(f, { write: quiet(ALL) });
    const body = parse(await client.callTool({ name: "draft_payment", arguments: { doc_type: "sales_bill_foreign", number: "3/2026" } }));
    expect(body.summary).toMatch(/^Zabeleži PLAČILO 100,00 USD na 3\/2026/);
  });

  it("enters a supplier's credit note as printed, checked against its total and never twice", async () => {
    const supplierInvoice = {
      mk_id: "PB1",
      doc_type: "purchase_bill_domestic",
      count_code: "126-0399",
      currency_code: "EUR",
      partner: { mk_id: "400068941553", mk_address_id: "400079138037", customer: "ACME d.o.o." },
      product_list: [{ mk_id: "P7", code: "DOM", amount: "1", price: "31.95", tax: "EX4" }],
      sum_all: "38.98",
    };
    let entered: Record<string, unknown>[] = [];
    const f = metakocka({
      documents: { PB1: supplierInvoice },
      search: (body) =>
        body.doc_type === "purchase_bill_domestic" && body.query === "126-0399"
          ? { opr_code: "0", result: [supplierInvoice] }
          : body.doc_type === "purchase_bill_credit_note"
            ? { opr_code: "0", result_all_records: String(entered.length), result: entered }
            : { opr_code: "0", result: [] },
    });
    const { client } = await connect(f, { write: quiet(ALL) });
    const call = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "draft_credit_note", arguments: { side: "purchase", ...args } }));
    expect(await call({ credit_type: "goods", from_invoice: "126-0399" })).toMatch(/Give supplier_number/);
    expect(await call({ credit_type: "goods", from_invoice: "126-0399", supplier_number: "CN-5", credit_note_total: 10 })).toMatch(/add up to 38\.98 with VAT, but credit_note_total is 10\.00/);
    const body = await call({ credit_type: "goods", from_invoice: "126-0399", supplier_number: "CN-5", credit_note_date: "2026-10-02", credit_note_total: -38.98 });
    expect(body.summary).toMatch(/^Vnesi PREJETI DOBROPIS CN-5 — vračilo blaga — od ACME d\.o\.o\. \(SI12345678\)\n.*\nK računu: 126-0399\n/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    expect(f.puts()[0]!.body).toMatchObject({
      doc_type: "purchase_bill_credit_note",
      count_code: "CN-5",
      doc_date: "02.10.2026",
      receive_date: "05.10.2026",
      credit_note_type: "goods",
      credit_note_bill: "126-0399",
      product_list: [expect.objectContaining({ mk_id: "P7", amount: "1", price: "31.95" })],
    });
    entered = [{ count_code: "CN-5", partner: { mk_id: "400068941553" } }];
    expect(await call({ credit_type: "goods", from_invoice: "126-0399", supplier_number: "cn-5" })).toMatch(/already in Metakocka/);
    expect(parse(await client.callTool({ name: "draft_credit_note", arguments: { credit_type: "goods", from_invoice: "126-0399", supplier_number: "X" } }))).toMatch(/only for side purchase/);
  });
});

describe("partner discounts per product category", () => {
  it("applies the partner's best category discount to price-list lines, and says where it didn't", async () => {
    const tree = (...labels: string[]) => [{ tree_node_label: labels[0], tree_node_list: labels.slice(1).map((l) => ({ tree_node_label: l })) }];
    const products = [
      { ...PRODUCTS[0], category_tree_list: tree("Storitve", "Svetovanje") },
      { ...PRODUCTS[1], category_tree_list: tree("Storitve"), pricelist: priced("EX4", "22", "20", { price_def: { price: "20", tax: "EX4", tax_desc: "22", discount: "5" } }) },
      { mk_id: "P9", count_code: "9", code: "HW", name: "Strojna oprema", unit: "kos", sales: "true", activated: "true", pricelist: priced(), category_tree_list: tree("Oprema") },
    ];
    const discounted = partner({
      discounts: [
        { categories: ["Storitve"], discount_percent: "10.00", override_existing: "false" },
        { categories: "Svetovanje", discount_percent: "15.00", override_existing: "true" },
      ],
    });
    const f = metakocka({ partners: [discounted], products });
    const { client } = await connect(f, { write: quiet({ docTypes: ["sales_offer"], confirm: "never", timeoutMs: 1000 }) });
    const { body } = await draft(client, {
      doc_type: "sales_offer",
      partner_id: "400068941553",
      lines: [{ code: "SVC-H", quantity: 1 }, { code: "SVC-D", quantity: 1 }, { code: "HW", quantity: 1 }, { code: "SVC-H", quantity: 1, price: 30 }],
    });
    // Svetovanje: the best match (15 %, Svetovanje); Dokumentacija keeps its price list's 5 % (no override); no discount for Oprema.
    expect(body.lines.map((l: { discount_percent: number }) => l.discount_percent)).toEqual([15, 5, 0, 0]);
    expect(body.warnings).toEqual([
      "ACME d.o.o.'s category discounts applied: line 1 −15 % (Svetovanje).",
      "ACME d.o.o. has a category discount for line 4 (Svetovanje −15 %), not applied because the price was given; pass discount_percent if it should be.",
    ]);
    expect(body.summary).toMatch(/1 × Svetovanje à 35,00 € −15 % = 29,75 €/);
  });
});

describe("sales order receiver and delivery type", () => {
  it("sends an existing partner as receiver in full, checks the delivery type, and verifies both were stored", async () => {
    const receiver = partner({ mk_id: "R1", customer: "Prejemnik d.o.o.", tax_id_number: "SI87654321", taxpayer: "true", business_entity: "true", partner_delivery_address_list: [{ mk_id: "RA", street: "Druga 2", post_number: "2000", city: "Maribor", country: "Slovenija" }] });
    let storeDelivery = true;
    const f = metakocka({
      partners: [partner(), receiver],
      search: () => ({ opr_code: "0", result: [{ count_code: "PP-1", delivery_type: "GLS" }] }),
      stored: (put) => ({ ...put, partner: { ...(put.partner as Body), customer: "ACME d.o.o." }, receiver: { mk_id: "R1", customer: "Prejemnik d.o.o." }, ...(storeDelivery ? {} : { delivery_type: undefined }), sum_all: "42.7" }),
      handlers: { get_delivery_service_pricelist: () => ({ opr_code: "0", pricelist_list: [{ delivery_type: "Pošta Slovenije" }] }) },
    });
    const { client } = await connect(f, { write: quiet({ docTypes: ["sales_order"], confirm: "never", timeoutMs: 1000 }) });
    const order = { doc_type: "sales_order", partner_id: "400068941553", lines: [{ product_id: "P1", quantity: 1 }], receiver_partner_id: "R1" };
    const { body } = await draft(client, { ...order, delivery_type: "gls" });
    expect(body.warnings ?? []).toEqual([]);
    expect(body.summary).toMatch(/\nPrejemnik: Prejemnik d\.o\.o\., Druga 2, 2000 Maribor, Slovenija\nDostava: gls\n/);
    const saved = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } }));
    expect(saved).toMatchObject({ status: "created", warnings: [] });
    expect(f.puts()[0]!.body).toMatchObject({
      delivery_type: "gls",
      receiver: { mk_id: "R1", mk_address_id: "RA", customer: "Prejemnik d.o.o.", tax_id_number: "SI87654321", street: "Druga 2", post_number: "2000", place: "Maribor", country: "Slovenija", taxpayer: "true" },
    });

    storeDelivery = false;
    const { body: unknown } = await draft(client, { ...order, delivery_type: "Dron" });
    expect(unknown.warnings[0]).toMatch(/"Dron" is not a delivery type in use \(GLS, Pošta Slovenije\)/);
    const r = parse(await client.callTool({ name: "commit_document", arguments: { draft_id: unknown.draft_id } }));
    expect(r.warnings[0]).toMatch(/delivery type not set, not Dron/);
  });
});

describe("e-mail attachments", () => {
  it("attaches an invoice as PDF and a local file, shows them in the summary and keeps them out of the audit log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-att-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "pogoji.txt");
    await writeFile(file, "Splošni pogoji");
    const log: Record<string, unknown>[] = [];
    const f = metakocka({
      search: () => ({ opr_code: "0", result: [{ mk_id: "INV2", count_code: "RD-2/2026" }] }),
      handlers: {
        report: () => new Response(new Uint8Array([37, 80, 68, 70, 45]), { status: 200, headers: { "Content-Type": "application/pdf" } }),
        "../send_message": () => ({ opr_code: "0", message_list: [{ mk_id: "884", status: "ok" }] }),
      },
    });
    const settings: WriteSettings = { docTypes: ["message"], confirm: "never", timeoutMs: 1000 };
    const { client } = await connect(f, { write: { settings, drafts: new DraftStore(), journal: async (e) => void log.push(e), localFiles: true } });
    const args = { channel: "email", to_emails: ["janez@example.com"], from_email: "info@martej.com", subject: "Račun", body: "V prilogi je račun." };
    expect(parse(await client.callTool({ name: "draft_message", arguments: { ...args, attach_documents: [{ doc_type: "sales_order", number: "PP-1" }] } }))).toMatch(/give its report_id/);
    const body = parse(await client.callTool({ name: "draft_message", arguments: { ...args, attach_documents: [{ doc_type: "sales_bill_domestic", number: "RD-2/2026" }], attachment_paths: [file] } }));
    expect(body.summary).toMatch(/\nPriponke: RD-2-2026\.pdf \(1 KB\), pogoji\.txt \(1 KB\)\n/);
    await client.callTool({ name: "commit_document", arguments: { draft_id: body.draft_id } });
    const sent = (f.calls.find((c) => c.endpoint === "../send_message")!.body.message_list as Body[])[0]!;
    expect(sent.attached_file_list).toEqual([
      { file_name: "RD-2-2026.pdf", content_type: "application/pdf", file_data_base64: Buffer.from([37, 80, 68, 70, 45]).toString("base64") },
      { file_name: "pogoji.txt", content_type: "text/plain", file_data_base64: Buffer.from("Splošni pogoji").toString("base64") },
    ]);
    expect(JSON.stringify(log)).not.toContain(Buffer.from("Splošni pogoji").toString("base64"));
    expect(JSON.stringify(log)).toContain('"file_name":"pogoji.txt"');

    // Without local files (HTTP mode) only Metakocka's own documents can be attached.
    const remote = await connect(f, { write: { settings, drafts: new DraftStore(), journal: async () => {} } });
    expect(parse(await remote.client.callTool({ name: "draft_message", arguments: { ...args, attachment_paths: [file] } }))).toMatch(/only possible when the server runs on the user's computer/);
  });
});
