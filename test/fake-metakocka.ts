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
