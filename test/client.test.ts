import { describe, expect, it } from "vitest";
import { MetakockaClient, MetakockaError, NetworkError } from "../src/client.js";
import { fakeMetakocka } from "./fake-metakocka.js";

describe("MetakockaClient", () => {
  it("posts JSON with credentials to the endpoint", async () => {
    const { client, calls } = fakeMetakocka({ search: () => ({ opr_code: "0", result: [] }) });
    await client.call("search", { doc_type: "sales_order" });
    expect(calls).toEqual([
      { endpoint: "search", body: { doc_type: "sales_order", company_id: "16", secret_key: "s3cret-key" } },
    ]);
  });

  it("turns opr_code errors into MetakockaError without retrying", async () => {
    const { client, calls } = fakeMetakocka({
      search: () => ({ opr_code: "2", opr_desc: "Unknown document type : foo" }),
    });
    const error = await client.call("search", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetakockaError);
    expect((error as MetakockaError).message).toContain("Unknown document type : foo");
    expect((error as MetakockaError).oprCode).toBe("2");
    expect(calls).toHaveLength(1);
  });

  it("never leaks the secret key in errors", async () => {
    const { client } = fakeMetakocka({
      search: () => ({ opr_code: "1", opr_desc: "Invalid secret_key s3cret-key for company 16" }),
    });
    const error = (await client.call("search", {}).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("s3cret-key");
    expect(error.message).toContain("***");
  });

  it("retries HTTP 5xx and then succeeds", async () => {
    let attempts = 0;
    const { client, calls } = fakeMetakocka({
      search: () => (++attempts < 3 ? new Response("busy", { status: 503 }) : { opr_code: "0", ok: true }),
    });
    await expect(client.call("search", {})).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxRetries", async () => {
    const { client, calls } = fakeMetakocka({ search: () => new Response("down", { status: 502 }) });
    await expect(client.call("search", {})).rejects.toThrow(/HTTP 502/);
    expect(calls).toHaveLength(3);
  });

  it("does not retry non-idempotent calls", async () => {
    const { client, calls } = fakeMetakocka({ put_document: () => new Response("down", { status: 502 }) });
    await expect(client.call("put_document", {}, { idempotent: false })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("does not retry HTTP 4xx", async () => {
    const { client, calls } = fakeMetakocka({});
    await expect(client.call("nope", {})).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(1);
  });

  it("retries network failures and reports timeouts clearly", async () => {
    let n = 0;
    const client = new MetakockaClient({
      companyId: "16",
      secretKey: "k",
      sleep: async () => {},
      fetch: async () => {
        n++;
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
      timeoutMs: 1000,
    });
    await expect(client.call("search", {})).rejects.toThrow(/timed out after 1 s/);
    expect(n).toBe(3);
  });

  it("runs calls one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const { client } = fakeMetakocka({
      search: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { opr_code: "0" };
      },
    });
    await Promise.all([client.call("search"), client.call("search"), client.call("search")]);
    expect(maxActive).toBe(1);
  });

  it("keeps working after a failed call", async () => {
    let first = true;
    const { client } = fakeMetakocka({
      search: () => {
        if (first) {
          first = false;
          return { opr_code: "2", opr_desc: "bad" };
        }
        return { opr_code: "0", fine: true };
      },
    });
    await expect(client.call("search")).rejects.toThrow();
    await expect(client.call("search")).resolves.toMatchObject({ fine: true });
  });

  it("requires credentials", () => {
    expect(() => new MetakockaClient({ companyId: "", secretKey: "x" })).toThrow(MetakockaError);
  });

  it("returns files from callBinary and turns a JSON answer into an error", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const { client } = fakeMetakocka({
      report: (body) =>
        body.report_id === "38"
          ? new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } })
          : { opr_code: "6", opr_desc: "Paramether 'report_id' must be valid number." },
    });
    const file = await client.callBinary("report", { report_id: "38" });
    expect(file.contentType).toBe("application/pdf");
    expect([...file.bytes]).toEqual([...pdf]);
    await expect(client.callBinary("report", {})).rejects.toThrow(/report_id' must be valid number/);
  });
  it("explains network errors by their code, and doesn't retry certificate or DNS failures", async () => {
    const failing = (code: string) => {
      let calls = 0;
      const client = new MetakockaClient({
        companyId: "16",
        secretKey: "s3cret-key",
        baseUrl: "https://erp.firma.local:8443",
        sleep: async () => {},
        fetch: async () => {
          calls++;
          throw new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code}`), { code }) });
        },
      });
      return { client, calls: () => calls };
    };

    const cert = failing("SELF_SIGNED_CERT_IN_CHAIN");
    const certError = (await cert.client.call("search").catch((e: unknown) => e)) as NetworkError;
    expect(certError).toBeInstanceOf(NetworkError);
    expect(certError.code).toBe("SELF_SIGNED_CERT_IN_CHAIN");
    expect(certError.message).toContain("erp.firma.local:8443");
    expect(certError.message).toContain("NODE_EXTRA_CA_CERTS");
    expect(cert.calls()).toBe(1);

    const dns = failing("ENOTFOUND");
    await expect(dns.client.call("search")).rejects.toThrow(/host name erp\.firma\.local was not found/);
    expect(dns.calls()).toBe(1);

    const refused = failing("ECONNREFUSED");
    await expect(refused.client.call("search")).rejects.toThrow(/refused the connection/);
    expect(refused.calls()).toBe(3);
  });

  it("points at the URL path when the installation answers with a web page", async () => {
    const page = () => new Response("<!DOCTYPE html><html>login</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const { client } = fakeMetakocka({ search: page });
    await expect(client.call("search")).rejects.toThrow(/web page .* instead of Metakocka API data.*\/rest\/eshop\/v1/);

    const { client: proxied, calls } = fakeMetakocka({ search: () => new Response("<html>Bad gateway</html>", { status: 502 }) });
    const error = (await proxied.call("search").catch((e: unknown) => e)) as MetakockaError;
    expect(error.message).toBe("Metakocka at main.metakocka.si returned HTTP 502 for search");
    expect(calls).toHaveLength(3);
  });
});
