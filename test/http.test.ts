/**
 * The HTTP server: credentials per request, the bearer token, host checks,
 * per-company isolation, and a full run over real sockets against a fake
 * Metakocka reached through the Metakocka URL setting.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { COMPANY_HEADER, createHttpApp, SECRET_HEADER, startHttpServer } from "../src/http.js";
import { fakeMetakocka, invoice, serveFakeMetakocka, type Handler } from "./fake-metakocka.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const CREDS = { [COMPANY_HEADER]: "16", [SECRET_HEADER]: "s3cret-key" };

/** Warehouses named after the company that asks, to see whose data comes back. */
const HANDLERS: Record<string, Handler> = {
  "json/warehouse_list": (body) => ({
    opr_code: "0",
    warehouse_list: [{ mk_id: "1", mark: "W", name: `Warehouse of ${String(body.company_id)}`, active: "true" }],
  }),
};

function app(env: NodeJS.ProcessEnv = {}, handlers = HANDLERS) {
  const fake = fakeMetakocka(handlers);
  const a = createHttpApp({ env, fetch: fake.fetch });
  cleanups.push(a.close);
  return { app: a, calls: fake.calls };
}

async function mcpClient(fetchImpl: (request: Request) => Promise<Response>, headers: Record<string, string>, url = "http://localhost:3000/mcp") {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: (u, init) => fetchImpl(new Request(u, init)),
    requestInit: { headers },
  });
  const client = new Client({ name: "test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

const post = (headers: Record<string, string> = {}, path = "/mcp", host = "localhost:3000") =>
  new Request(`http://${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

const firstText = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[])[0]!.text;

describe("HTTP server", () => {
  it("answers health checks and 404 elsewhere", async () => {
    const { app: a } = app();
    const health = await a.fetch(new Request("http://localhost:3000/health"));
    expect(await health.json()).toMatchObject({ status: "ok" });
    expect((await a.fetch(new Request("http://localhost:3000/other"))).status).toBe(404);
  });

  it("asks for credentials when a request has none", async () => {
    const { app: a } = app();
    const response = await a.fetch(post());
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).toContain("X-Metakocka-Company-Id");
  });

  it("serves tools with the credentials from the request headers", async () => {
    const { app: a, calls } = app();
    const client = await mcpClient(a.fetch, CREDS);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(15);
    const result = await client.callTool({ name: "list_warehouses", arguments: {} });
    expect(firstText(result)).toContain("Warehouse of 16");
    expect(calls[0]!.body).toMatchObject({ company_id: "16", secret_key: "s3cret-key" });
  });

  it("keeps companies apart: each has its own client and cache", async () => {
    const { app: a } = app();
    const one = await mcpClient(a.fetch, CREDS);
    const two = await mcpClient(a.fetch, { [COMPANY_HEADER]: "99", [SECRET_HEADER]: "other-key" });
    expect(firstText(await one.callTool({ name: "list_warehouses", arguments: {} }))).toContain("Warehouse of 16");
    expect(firstText(await two.callTool({ name: "list_warehouses", arguments: {} }))).toContain("Warehouse of 99");
    expect(firstText(await one.callTool({ name: "list_warehouses", arguments: {} }))).toContain("Warehouse of 16");
    expect(a.tenantCount()).toBe(2);
  });

  it("requires the bearer token when one is set, and then may use the server's own credentials", async () => {
    const env = { METAKOCKA_HTTP_TOKEN: "team-token", METAKOCKA_COMPANY_ID: "7", METAKOCKA_SECRET_KEY: "server-key" };
    const { app: a, calls } = app(env);

    expect((await a.fetch(post(CREDS))).status).toBe(401);
    expect((await a.fetch(post({ ...CREDS, Authorization: "Bearer wrong" }))).status).toBe(401);

    const server = await mcpClient(a.fetch, { Authorization: "Bearer team-token" });
    expect(firstText(await server.callTool({ name: "list_warehouses", arguments: {} }))).toContain("Warehouse of 7");
    const own = await mcpClient(a.fetch, { Authorization: "Bearer team-token", ...CREDS });
    expect(firstText(await own.callTool({ name: "list_warehouses", arguments: {} }))).toContain("Warehouse of 16");
    expect(calls.map((c) => c.body.secret_key)).toEqual(["server-key", "s3cret-key"]);
  });

  it("never uses the server's own credentials without a token", async () => {
    const { app: a } = app({ METAKOCKA_COMPANY_ID: "7", METAKOCKA_SECRET_KEY: "server-key" });
    expect((await a.fetch(post())).status).toBe(401);
  });

  it("only answers localhost names when bound to loopback (DNS rebinding)", async () => {
    const { app: a } = app();
    expect((await a.fetch(post(CREDS, "/mcp", "evil.example:3000"))).status).toBe(403);
    expect((await a.fetch(post({ ...CREDS, Origin: "https://evil.example" }))).status).toBe(403);
    expect((await a.fetch(post(CREDS, "/mcp", "127.0.0.1:3000"))).status).toBe(200);
  });

  it("checks METAKOCKA_HTTP_ALLOWED_HOSTS when set", async () => {
    const { app: a } = app({ METAKOCKA_HTTP_ALLOWED_HOSTS: "mcp.firma.si" });
    expect((await a.fetch(post(CREDS, "/mcp", "mcp.firma.si"))).status).toBe(200);
    expect((await a.fetch(post(CREDS, "/mcp", "localhost:3000"))).status).toBe(403);
  });

  it("refuses to start with an invalid Metakocka URL", () => {
    expect(() => createHttpApp({ env: { METAKOCKA_BASE_URL: "ftp://erp" } })).toThrow(/METAKOCKA_BASE_URL/);
  });
});

describe("HTTP server over real sockets, against an installation on its own URL", () => {
  const metakocka: Record<string, Handler> = {
    ...HANDLERS,
    search: (body) =>
      body.doc_type === "sales_bill_domestic"
        ? { opr_code: "0", result_all_records: "1", result: [invoice({ sum_paid: "22" })] }
        : { opr_code: "0", result_all_records: "0", result: [] },
  };

  async function start(baseUrl: string) {
    const http = await startHttpServer({ env: { METAKOCKA_BASE_URL: baseUrl }, port: 0, host: "127.0.0.1", log: () => {} });
    cleanups.push(http.close);
    const client = await mcpClient((request) => fetch(request), CREDS, http.url);
    return client;
  }

  it("reaches the installation through the URL setting, with structured output", async () => {
    const fake = await serveFakeMetakocka(metakocka, "/mk/rest/eshop/v1");
    cleanups.push(fake.close);
    const client = await start(`${fake.origin}/mk/rest/eshop/v1`);

    expect(client.getInstructions()).toContain(`installation at ${new URL(fake.origin).host}`);
    const result = await client.callTool({ name: "get_unpaid_invoices", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ invoice_count: 1, totals_by_currency: { EUR: { open_total: 100 } } });
    expect(fake.calls.map((c) => c.endpoint)).toEqual(["search", "search"]);
  });

  it("streams progress notifications while a report runs", async () => {
    const fake = await serveFakeMetakocka({
      search: (body) => ({ opr_code: "0", result_all_records: "150", result: Array.from({ length: body.offset === 0 ? 100 : 50 }, () => invoice()) }),
    });
    cleanups.push(fake.close);
    const client = await start(fake.origin);
    const messages: string[] = [];
    const result = await client.callTool(
      { name: "sales_summary", arguments: { date_from: "2026-09-01", date_to: "2026-09-30", doc_types: ["sales_bill_domestic"] } },
      { onprogress: (p) => messages.push(p.message ?? "") },
    );
    expect(result.structuredContent).toMatchObject({ totals_by_currency: { EUR: { documents: 150 } } });
    expect(messages).toHaveLength(2);
  });

  it("explains a wrong path in the Metakocka URL", async () => {
    const fake = await serveFakeMetakocka(metakocka, "/mk/rest/eshop/v1");
    cleanups.push(fake.close);
    const client = await start(fake.origin); // /rest/eshop/v1 is added, but this installation lives under /mk
    const result = await client.callTool({ name: "list_warehouses", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("web page");
    expect(firstText(result)).toContain("Check the Metakocka URL");
  });

  it("explains a refused connection", async () => {
    const fake = await serveFakeMetakocka(metakocka);
    await fake.close(); // nothing listens on that port any more
    const client = await start(fake.origin);
    const result = await client.callTool({ name: "list_warehouses", arguments: {} });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/127\.0\.0\.1:\d+ refused the connection/);
  });
});
