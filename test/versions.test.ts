import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const json = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("release metadata", () => {
  it("keeps package.json, manifest.json and VERSION in sync", () => {
    const pkg = json("package.json");
    expect(json("manifest.json").version).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });
});
