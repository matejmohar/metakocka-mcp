/**
 * An in-memory stand-in for the Metakocka API: a `fetch` implementation that
 * routes requests by endpoint to handler functions and records every call.
 */
import { MetakockaClient } from "../src/client.js";

export type Body = Record<string, unknown>;
export type Handler = (body: Body) => unknown | Promise<unknown>;

export interface RecordedCall {
  endpoint: string;
  body: Body;
}

export function fakeMetakocka(handlers: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const endpoint = url.replace(/^https?:\/\/[^/]+\/rest\/eshop\/v1\//, "");
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    calls.push({ endpoint, body });
    const handler = handlers[endpoint];
    if (!handler) return new Response("Not found", { status: 404 });
    const result = await handler(body);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new MetakockaClient({
    companyId: "16",
    secretKey: "s3cret-key",
    fetch: fetchImpl,
    sleep: async () => {},
  });
  return { client, calls, fetch: fetchImpl };
}

/** Value of an advanced-search filter in a recorded /search body. */
export function filterValue(body: Body, type: string): unknown {
  const filters = (body.query_advance ?? []) as { type: string; value: unknown }[];
  return filters.find((f) => f.type === type)?.value;
}

export const invoice = (over: Record<string, unknown> = {}) => ({
  mk_id: "1600203710",
  doc_type: "sales_bill_domestic",
  opr_code: "0",
  count_code: "PRD1_494",
  doc_date: "2026-08-10+02:00",
  partner: { customer: "ACME d.o.o.", tax_id_number: "SI12345678", country: "Slovenia" },
  duo_payment: "2026-08-25+02:00",
  currency_code: "EUR",
  product_list: [{ code: "A1", name: "Widget", amount: "2", price: "50", tax: "EX4" }],
  sum_basic: "100",
  sum_tax_ex4: "22",
  sum_all: "122",
  ...over,
});

/**
 * The same fake, served over real HTTP on 127.0.0.1, for tests that go through
 * the Metakocka URL setting and Node's own fetch.
 */
export async function serveFakeMetakocka(handlers: Record<string, Handler>, path = "/rest/eshop/v1") {
  const { createServer } = await import("node:http");
  const fake = fakeMetakocka(handlers);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (!req.url?.startsWith(`${path}/`)) {
        res.writeHead(404, { "Content-Type": "text/html" }).end("<html><body>Not found</body></html>");
        return;
      }
      const endpoint = req.url.slice(path.length + 1);
      void fake
        .fetch(`http://fake/rest/eshop/v1/${endpoint}`, { method: "POST", body: Buffer.concat(chunks).toString("utf8") })
        .then(async (r) => {
          res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    calls: fake.calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
