import { describe, expect, it } from "vitest";
import { addDays, addMonths, previousPeriod, samePeriodLastYear } from "../src/dates.js";

describe("addDays / addMonths", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-03-31", 1)).toBe("2026-04-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-01-15", -2)).toBe("2025-11-15");
  });

  it("clamps the day to the end of the month", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2024-03-31", -1)).toBe("2024-02-29");
  });
});

describe("previousPeriod", () => {
  it.each([
    ["2026-09-01", "2026-09-30", "2026-08-01", "2026-08-31"], // month
    ["2026-03-01", "2026-03-31", "2026-02-01", "2026-02-28"], // into a short month
    ["2026-07-01", "2026-09-30", "2026-04-01", "2026-06-30"], // quarter
    ["2026-01-01", "2026-12-31", "2025-01-01", "2025-12-31"], // year
    ["2026-09-28", "2026-10-04", "2026-09-21", "2026-09-27"], // week
    ["2026-03-10", "2026-03-31", "2026-02-16", "2026-03-09"], // ends on a month end but doesn't start on the 1st
  ])("%s – %s → %s – %s", (from, to, prevFrom, prevTo) => {
    expect(previousPeriod(from, to)).toEqual({ from: prevFrom, to: prevTo });
  });
});

describe("samePeriodLastYear", () => {
  it("shifts by a year and keeps month ends", () => {
    expect(samePeriodLastYear("2026-09-01", "2026-09-30")).toEqual({ from: "2025-09-01", to: "2025-09-30" });
    expect(samePeriodLastYear("2025-02-01", "2025-02-28")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(samePeriodLastYear("2024-02-29", "2024-03-05")).toEqual({ from: "2023-02-28", to: "2023-03-05" });
  });
});
