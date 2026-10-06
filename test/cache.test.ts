import { describe, expect, it } from "vitest";
import { TtlCache } from "../src/cache.js";

describe("TtlCache", () => {
  it("reuses a value until it expires, sharing concurrent loads", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache(1000, () => now);
    const load = async () => ++loads;
    expect(await Promise.all([cache.getOrLoad("k", load), cache.getOrLoad("k", load)])).toEqual([1, 1]);
    now = 999;
    expect(await cache.getOrLoad("k", load)).toBe(1);
    now = 1000;
    expect(await cache.getOrLoad("k", load)).toBe(2);
  });

  it("does not keep failures", async () => {
    const cache = new TtlCache(1000, () => 0);
    await expect(cache.getOrLoad("k", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cache.getOrLoad("k", async () => "up")).toBe("up");
  });

  it("does nothing with a TTL of 0", async () => {
    let loads = 0;
    const cache = new TtlCache(0);
    await cache.getOrLoad("k", async () => ++loads);
    await cache.getOrLoad("k", async () => ++loads);
    expect(loads).toBe(2);
  });
});
