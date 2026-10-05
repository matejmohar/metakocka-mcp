import { describe, expect, it } from "vitest";
import { agingReport, lineNetValue, salesSummary, toOpenInvoice } from "../src/analytics.js";
import { invoice } from "./fake-metakocka.js";

describe("toOpenInvoice", () => {
  it("computes open amount and days overdue", () => {
    const inv = toOpenInvoice(invoice({ sum_paid: "22" }), "2026-10-05");
    expect(inv).toMatchObject({ number: "PRD1_494", total: 122, paid: 22, open_amount: 100, days_overdue: 41, due_date: "2026-08-25" });
  });

  it("is not overdue before the due date", () => {
    expect(toOpenInvoice(invoice(), "2026-08-20")?.days_overdue).toBe(0);
  });

  it("skips fully paid invoices", () => {
    expect(toOpenInvoice(invoice({ sum_paid: "122" }), "2026-10-05")).toBeUndefined();
  });
});

describe("agingReport", () => {
  it("buckets by days overdue and ranks partners", () => {
    const today = "2026-10-05";
    const invoices = [
      toOpenInvoice(invoice({ duo_payment: "2026-10-10+02:00" }), today)!, // not due
      toOpenInvoice(invoice({ duo_payment: "2026-09-20+02:00" }), today)!, // 15
      toOpenInvoice(invoice({ duo_payment: "2026-06-01+02:00", partner: { customer: "Beta" }, sum_all: "500" }), today)!, // 126
    ];
    const r = agingReport(invoices);
    expect(r.totals_by_currency.EUR).toEqual({
      open_total: 744,
      overdue_total: 622,
      count: 3,
      aging: { not_due: 122, "1_30": 122, "31_60": 0, "61_90": 0, over_90: 500 },
    });
    expect(r.top_partners[0]).toMatchObject({ partner: "Beta", open_total: 500, max_days_overdue: 126 });
  });
});

describe("lineNetValue", () => {
  it("applies chained discounts", () => {
    expect(lineNetValue({ amount: "2", price: "100", discount: "10;5" })).toBeCloseTo(171);
  });

  it("derives net from gross with a tax factor", () => {
    expect(lineNetValue({ amount: "1", price_with_tax: "122", tax_factor: "0.22" })).toBeCloseTo(100);
  });

  it("returns undefined when the net price can't be known", () => {
    expect(lineNetValue({ amount: "1", price_with_tax: "122" })).toBeUndefined();
  });
});

describe("salesSummary", () => {
  const docs = [
    invoice(),
    invoice({ doc_date: "2026-09-02+02:00", partner: { customer: "Beta" }, sum_basic: "300", sum_all: "366",
      product_list: [{ code: "B2", name: "Gadget", amount: "3", price: "100" }] }),
    invoice({ currency_code: "USD", sum_basic: "10", sum_all: "10" }),
  ];

  it("groups by partner, per currency", () => {
    const r = salesSummary(docs, "partner", 10);
    expect(r.totals_by_currency).toEqual({
      EUR: { documents: 2, net: 400, gross: 488 },
      USD: { documents: 1, net: 10, gross: 10 },
    });
    expect(r.groups[0]).toEqual({ partner: "Beta", currency: "EUR", documents: 1, net: 300, gross: 366 });
  });

  it("groups by month in date order", () => {
    const r = salesSummary(docs, "month", 1);
    expect(r.groups.map((g) => g.month)).toEqual(["2026-08", "2026-09", "2026-08"].sort());
    expect(r.groups_not_shown).toBe(0);
  });

  it("groups by product from line items", () => {
    const r = salesSummary(docs, "product", 1);
    expect(r.groups).toEqual([{ product: "B2 – Gadget", currency: "EUR", documents: 1, net: 300, quantity: 3 }]);
    expect(r.groups_not_shown).toBe(2);
  });
});
