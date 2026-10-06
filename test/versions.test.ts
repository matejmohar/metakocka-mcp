import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("release metadata", () => {
  it("keeps package.json, manifest.json and VERSION in sync", () => {
    const pkg = json("package.json");
    expect(json("manifest.json").version).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  it("maps every extension setting to an environment variable the server reads", () => {
    const manifest = json("manifest.json") as {
      user_config: Record<string, { required?: boolean; default?: unknown }>;
      server: { mcp_config: { env: Record<string, string> } };
    };
    const env = manifest.server.mcp_config.env;
    const mapped = Object.values(env).map((v) => /^\$\{user_config\.([a-z_]+)\}$/.exec(v)?.[1]);
    expect(mapped.sort()).toEqual(Object.keys(manifest.user_config).sort());

    const srcDir = new URL("../src/", import.meta.url);
    const source = readdirSync(srcDir, { recursive: true })
      .filter((f) => String(f).endsWith(".ts"))
      .map((f) => readFileSync(new URL(String(f), srcDir), "utf8"))
      .join("\n");
    for (const name of Object.keys(env)) expect(source, name).toContain(`"${name}"`);
  });
});
