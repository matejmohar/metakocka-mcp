import { describe, expect, it } from "vitest";
import { daysBetween, fromMkDate, isIsoDate, toMkDate, todayInLjubljana } from "../src/dates.js";
import { asArray, compact, num } from "../src/util.js";

describe("num", () => {
  it.each([
    ["24.8", 24.8],
    ["4", 4],
    ["7,3", 7.3],
    ["1.895,01", 1895.01],
    ["1,895.01", 1895.01],
    ["-3", -3],
    [" 12 ", 12],
    [5, 5],
  ])("parses %j", (input, expected) => {
    expect(num(input)).toBe(expected);
  });

  it.each([[""], ["abc"], [undefined], [null], [{}]])("returns undefined for %j", (input) => {
    expect(num(input)).toBeUndefined();
  });
});

describe("dates", () => {
  it("adds the Ljubljana offset, respecting summer time", () => {
    expect(toMkDate("2026-01-15")).toBe("2026-01-15+01:00");
    expect(toMkDate("2026-07-15")).toBe("2026-07-15+02:00");
  });

  it("rejects invalid dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("15.1.2026")).toBe(false);
    expect(() => toMkDate("2026-13-01")).toThrow();
  });

  it("reads Metakocka dates and timestamps", () => {
    expect(fromMkDate("2015-05-10+02:00")).toBe("2015-05-10");
    expect(fromMkDate("2015-05-07T12:53:27+02:00")).toBe("2015-05-07");
    expect(fromMkDate("15.03.2017")).toBe("2017-03-15");
    expect(fromMkDate(undefined)).toBeUndefined();
  });

  it("uses the Ljubljana calendar day for today", () => {
    // 23:30 UTC on 5 Oct is already 6 Oct in Ljubljana (UTC+2).
    expect(todayInLjubljana(new Date("2026-10-05T23:30:00Z"))).toBe("2026-10-06");
  });

  it("counts days", () => {
    expect(daysBetween("2026-08-25", "2026-10-05")).toBe(41);
    expect(daysBetween("2026-10-05", "2026-10-01")).toBe(-4);
  });
});

describe("compact / asArray", () => {
  it("drops empty values recursively", () => {
    expect(compact({ a: 1, b: "", c: null, d: [], e: { f: undefined }, g: [{ h: "" }, { i: 0 }] })).toEqual({
      a: 1,
      g: [{ i: 0 }],
    });
  });

  it("wraps single objects", () => {
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray([1, 2])).toEqual([1, 2]);
  });
});
