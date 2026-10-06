import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { fakeMetakocka } from "./fake-metakocka.js";

const env = { METAKOCKA_COMPANY_ID: "16", METAKOCKA_SECRET_KEY: "s3cret-key" };

async function check(handlers: Parameters<typeof fakeMetakocka>[0], e: NodeJS.ProcessEnv = env) {
  const { fetch } = fakeMetakocka(handlers);
  const lines: string[] = [];
  const code = await runDoctor({ env: e, fetch, log: (l) => lines.push(l) });
  return { code, output: lines.join("\n") };
}

describe("doctor", () => {
  it("passes when credentials work", async () => {
    const { code, output } = await check({ "json/warehouse_list": () => ({ opr_code: "0", warehouse_list: [{ count_code: "1" }] }) });
    expect(code).toBe(0);
    expect(output).toContain("Connected to Metakocka (1 warehouse visible)");
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
});
