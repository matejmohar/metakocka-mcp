/**
 * Creating offers: drafting, linking only to existing records, confirmation
 * in the client, exactly-once saving, and checking what Metakocka stored.
 * A real MCP client talks to the server; the server talks to a fake Metakocka.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
];

interface FakeOptions {
  partners?: Record<string, unknown>[];
  put?: Handler;
  stored?: (body: Body) => Record<string, unknown>;
  search?: Handler;
}

/** A Metakocka that knows one partner and a small catalogue, and stores offers it is given. */
function metakocka(o: FakeOptions = {}) {
  const partners = o.partners ?? [partner()];
  const saved: Body[] = [];
  const handlers: Record<string, Handler> = {
    get_partner: (body) => ({ opr_code: "0", partner_list: partners.filter((p) => p.mk_id === body.partner_id) }),
    "json/product_list": (body) => ({ opr_code: "0", product_list: Number(body.offset) > 0 ? [] : PRODUCTS }),
    put_document: (body) => {
      saved.push(body);
      if (o.put) return o.put(body);
      return { opr_code: "0", mk_id: `OFFER${saved.length}`, count_code: `${saved.length + 2}/2026`, partner: { mk_id: (body.partner as Body).mk_id } };
    },
    get_document: (body) => {
      const put = saved[Number(String(body.doc_id).replace("OFFER", "")) - 1] ?? saved[0]!;
      return { opr_code: "0", ...(o.stored ? o.stored(put) : storedFrom(put)) };
    },
    search: o.search ?? (() => ({ opr_code: "0", result_all_records: "0", result: [] })),
  };
  const fake = fakeMetakocka(handlers);
  return { ...fake, saved, puts: () => fake.calls.filter((c) => c.endpoint === "put_document") };
}

/** What get_document would return for a put_document body. */
function storedFrom(put: Body) {
  const lines = put.product_list as Body[];
  const total = lines.reduce((s, l) => s + Number(l.amount) * Number(l.price) * (1 - Number(l.discount ?? 0) / 100) * (l.tax === "EX4" ? 1.22 : 1), 0);
  return {
    doc_type: "sales_offer",
    count_code: "3/2026",
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

  it("settings: off by default, offers enables, unknown values are refused", () => {
    expect(writeSettingsFromEnv({})).toBeUndefined();
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "off" })).toBeUndefined();
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "offers" })).toMatchObject({ docTypes: ["sales_offer"], confirm: "client", timeoutMs: 120_000 });
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "offers", METAKOCKA_WRITE_CONFIRM: "elicitation" })?.confirm).toBe("elicitation");
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE: "offers", METAKOCKA_WRITE_CONFIRM: "never" })?.confirm).toBe("never");
    expect(() => writeSettingsFromEnv({ METAKOCKA_WRITE: "offers,invoices" })).toThrow(ConfigError);
    // The Claude Desktop extension's checkboxes.
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "false", METAKOCKA_WRITE_CONFIRM: "true" })).toBeUndefined();
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "true", METAKOCKA_WRITE_CONFIRM: "true" })).toMatchObject({ docTypes: ["sales_offer"], confirm: "client" });
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "true", METAKOCKA_WRITE_CONFIRM: "false" })?.confirm).toBe("never");
    expect(writeSettingsFromEnv({ METAKOCKA_WRITE_OFFERS: "${user_config.allow_offers}" })).toBeUndefined();
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
    expect(await err({ partner_id: "FOREIGN" })).toMatch(/foreign partner/);
    expect(await err({ partner_id: "DISC" })).toMatch(/partner discounts/);
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
