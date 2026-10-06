import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { fakeMetakocka, type Handler } from "./fake-metakocka.js";

const env = { METAKOCKA_COMPANY_ID: "16", METAKOCKA_SECRET_KEY: "s3cret-key" };
const WORKING: Record<string, Handler> = {
  "json/warehouse_list": () => ({ opr_code: "0", warehouse_list: [{ count_code: "1" }] }),
  search: () => ({ opr_code: "0", result_all_records: "0", result: [] }),
};

async function check(handlers: Record<string, Handler>, e: NodeJS.ProcessEnv = env, fetchOverride?: typeof fetch) {
  const { fetch } = fakeMetakocka(handlers);
  const lines: string[] = [];
  let clock = 0;
  const code = await runDoctor({ env: e, fetch: fetchOverride ?? fetch, log: (l) => lines.push(l), now: () => (clock += 400) });
  return { code, output: lines.join("\n") };
}

describe("doctor", () => {
  it("passes when credentials work, naming the installation and timing a search", async () => {
    const { code, output } = await check(WORKING);
    expect(code).toBe(0);
    expect(output).toContain("Installation: main.metakocka.si (public)");
    expect(output).toContain("Connected to main.metakocka.si (1 warehouse visible)");
    expect(output).toContain("Document search works (400 ms)");
  });

  it("warns when searches are slow", async () => {
    const lines: string[] = [];
    const { fetch } = fakeMetakocka(WORKING);
    let clock = 0;
    const code = await runDoctor({ env, fetch, log: (l) => lines.push(l), now: () => (clock += 12_000) });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/! Document search is slow \(12\.0 s\)[\s\S]*METAKOCKA_TIMEOUT_MS/);
  });

  it("names another installation and warns about plain HTTP over the internet", async () => {
    const { code, output } = await check(WORKING, { ...env, METAKOCKA_BASE_URL: "http://erp.firma.si:8080" });
    expect(code).toBe(0);
    expect(output).toContain("Installation: http://erp.firma.si:8080/rest/eshop/v1");
    expect(output).toContain("sent unencrypted over the internet");
    expect(output).toContain("Connected to erp.firma.si:8080");
  });

  it("only notes plain HTTP on a private network", async () => {
    const { output } = await check(WORKING, { ...env, METAKOCKA_BASE_URL: "http://192.168.1.20" });
    expect(output).toContain("not encrypted on your local network");
    expect(output).not.toContain("over the internet");
  });

  it("reports an invalid Metakocka URL", async () => {
    const { code, output } = await check(WORKING, { ...env, METAKOCKA_BASE_URL: "ftp://erp" });
    expect(code).toBe(1);
    expect(output).toContain("✗ METAKOCKA_BASE_URL");
    expect(output).not.toContain("Connected");
  });

  it("checks the extra CA certificate file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mk-ca-"));
    try {
      const pem = join(dir, "ca.pem");
      await writeFile(pem, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
      expect((await check(WORKING, { ...env, NODE_EXTRA_CA_CERTS: pem })).output).toContain(`✓ Extra CA certificate: ${pem}`);

      const missing = await check(WORKING, { ...env, NODE_EXTRA_CA_CERTS: join(dir, "nope.pem") });
      expect(missing.code).toBe(1);
      expect(missing.output).toContain("Cannot read the CA certificate file");

      const unfilled = await check(WORKING, { ...env, NODE_EXTRA_CA_CERTS: "${user_config.ca_cert}" });
      expect(unfilled.code).toBe(0);
      expect(unfilled.output).not.toContain("CA certificate");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("explains missing credentials", async () => {
    const { code, output } = await check({}, {});
    expect(code).toBe(1);
    expect(output).toContain("Credentials are missing");
  });

  it("explains rejected credentials without leaking the key", async () => {
    const { code, output } = await check({
      "json/warehouse_list": () => ({ opr_code: "1", opr_desc: "Invalid secret_key s3cret-key" }),
    });
    expect(code).toBe(1);
    expect(output).toContain("Check the company ID and secret key");
    expect(output).not.toContain("s3cret-key");
  });

  it("explains an untrusted certificate", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }) });
    };
    const { code, output } = await check({}, { ...env, METAKOCKA_BASE_URL: "https://erp.firma.local" }, fetch);
    expect(code).toBe(1);
    expect(output).toContain("TLS certificate of erp.firma.local is not trusted");
    expect(output).toMatch(/→ The CA certificate must be a PEM file/);
  });
});
