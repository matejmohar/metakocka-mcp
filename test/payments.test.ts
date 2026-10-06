import { describe, expect, it } from "vitest";
import { documentPayments, partnerLedger, paymentBehaviour } from "../src/analytics.js";
import { cleanDocument } from "../src/summarize.js";
import { numSl } from "../src/util.js";
import { invoice } from "./fake-metakocka.js";

describe("numSl", () => {
  it.each([
    ["5.985", 5985],
    ["38,98", 38.98],
    ["1.895,01", 1895.01],
    ["290", 290],
    ["-12,5", -12.5],
    ["1.234.567", 1234567],
  ])("parses %j", (input, expected) => {
    expect(numSl(input)).toBe(expected);
  });
});

// As Metakocka returns them: payment amounts in Slovenian format, everything else with a dot.
const paidInvoice = (over: Record<string, unknown> = {}) =>
  invoice({
    count_code: "1/2026",
    doc_date: "2026-02-06+02:00",
    duo_payment: "2026-02-20+02:00",
    sum_all: "5985",
    sum_paid: "5985",
    sum_full_paid_when: "2026-02-07+02:00",
    mark_paid: [{ payment_type: "Transakcijski račun", date: "2026-02-07+02:00", amount: "5.985", payment_tip: "Plačilo" }],
    ...over,
  });

describe("documentPayments", () => {
  it("reads Slovenian-format payment amounts", () => {
    expect(documentPayments(paidInvoice())).toEqual([
      { date: "2026-02-07", amount: 5985, method: "Transakcijski račun", kind: "Plačilo" },
    ]);
    expect(documentPayments(invoice({ sum_paid: "38.98", mark_paid: [{ date: "2026-09-30+02:00", amount: "38,98" }] }))[0]!.amount).toBe(38.98);
  });

  it("falls back to the other format when that is the one that adds up", () => {
    const doc = invoice({ sum_paid: "12.5", mark_paid: [{ date: "2026-09-01+02:00", amount: "12.5" }] });
    expect(documentPayments(doc)[0]!.amount).toBe(12.5);
  });

  it("reports one payment with an estimated date when there is no usable detail", () => {
    expect(documentPayments(invoice({ sum_paid: "122", sum_full_paid_when: "2026-09-03+02:00" }))).toEqual([
      { date: "2026-09-03", amount: 122, date_estimated: true },
    ]);
    expect(documentPayments(invoice({ sum_paid: "100", mark_paid: [{ date: "2026-09-01+02:00", amount: "7" }] }))).toEqual([
      { date: "2026-08-10", amount: 100, date_estimated: true },
    ]);
    expect(documentPayments(invoice())).toEqual([]);
  });
});

describe("cleanDocument", () => {
  it("parses payment amounts in Slovenian format and dates like sum_full_paid_when", () => {
    const doc = cleanDocument(paidInvoice({ additional_data: '{"customer_received":"2023-06-01"}' }));
    expect(doc.mark_paid).toEqual([{ payment_type: "Transakcijski račun", date: "2026-02-07", amount: 5985, payment_tip: "Plačilo" }]);
    expect(doc.sum_full_paid_when).toBe("2026-02-07");
    expect(doc.additional_data).toEqual({ customer_received: "2023-06-01" });
  });
});

describe("partnerLedger", () => {
  const period = { from: "2026-09-01", to: "2026-09-30" };

  it("puts payments on their own dates and keeps a running balance from the opening balance", () => {
    const older = [
      // 100 owed, 40 paid before the period, 30 during it, 10 after it
      invoice({
        count_code: "R-0",
        doc_date: "2026-07-01+02:00",
        sum_all: "100",
        sum_paid: "80",
        mark_paid: [
          { date: "2026-08-01+02:00", amount: "40" },
          { date: "2026-09-10+02:00", amount: "30" },
          { date: "2026-10-02+02:00", amount: "10" },
        ],
      }),
    ];
    const docs = [
      invoice({
        count_code: "R-1",
        doc_date: "2026-09-05+02:00",
        duo_payment: "2026-09-20+02:00",
        sum_all: "200",
        sum_paid: "200",
        mark_paid: [{ date: "2026-09-25+02:00", amount: "200", payment_type: "TRR" }],
      }),
      invoice({ count_code: "D-1", doc_type: "sales_bill_credit_note", doc_date: "2026-09-25+02:00", sum_all: "-20" }),
    ];
    const l = partnerLedger(docs, older, period, "2026-10-05");
    expect(l.opening_balance).toEqual({ EUR: 60 });
    expect(l.entries.map((e) => [e.date, e.entry, e.number, e.amount, e.running_balance])).toEqual([
      ["2026-09-05", "invoice", "R-1", 200, 260],
      ["2026-09-10", "payment", "R-0", -30, 230],
      ["2026-09-25", "credit_note", "D-1", -20, 210],
      ["2026-09-25", "payment", "R-1", -200, 10],
    ]);
    expect(l.closing_balance).toEqual({ EUR: 10 });
    expect(l.totals_by_currency.EUR).toEqual({ invoiced: 200, credited: 20, paid: 230, refunded: 0 });
    expect(l.payments_after_period).toBe(1);
    expect(l.open_today).toEqual({ EUR: { open: 0, overdue: 20 } });
    expect(l.payment_behaviour).toEqual({ paid_invoices: 1, average_days_to_pay: 20, average_days_late: 5, paid_late: 1, max_days_late: 5 });
  });
});

describe("paymentBehaviour", () => {
  it("ignores unpaid invoices and payments without real dates", () => {
    expect(paymentBehaviour([invoice(), invoice({ sum_paid: "122", sum_full_paid_when: "2026-09-01+02:00" })])).toBeUndefined();
  });

  it("averages over fully paid invoices", () => {
    const onTime = paidInvoice();
    const late = paidInvoice({ mark_paid: [{ date: "2026-03-02+01:00", amount: "5.985" }] });
    expect(paymentBehaviour([onTime, late])).toEqual({
      paid_invoices: 2,
      average_days_to_pay: 12.5,
      average_days_late: 5,
      paid_late: 1,
      max_days_late: 10,
    });
  });
});
