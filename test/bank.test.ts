import { describe, expect, it } from "vitest";
import { bankSummary } from "../src/bank.js";

const statement = (over: Record<string, unknown> = {}) => ({
  doc_date: "2026-09-10+02:00",
  code: "34",
  initial_state: "11318.04",
  final_state: "11296.04",
  currency: "EUR",
  bank_account: "SI56 1111 1160 1111 645",
  transactions: [
    { type: "Prejemek", partner: "ACME d.o.o.", document: "1-MK-2064", amount: "100", partner_id: "1" },
    { type: "Izdatek - avans", partner: "Supplier", amount: "122" },
  ],
  ...over,
});

describe("bankSummary", () => {
  it("totals money in and out per account and lists transactions", () => {
    const r = bankSummary([statement(), statement({ doc_date: "2026-09-01+02:00", code: "33", initial_state: "11218.04", final_state: "11318.04", transactions: [{ type: "Prejemek", partner: "ACME d.o.o.", amount: "100" }] })]);
    expect(r.accounts).toEqual([
      { account: "SI56 1111 1160 1111 645", currency: "EUR", statements: 2, opening: 11218.04, closing: 11296.04, money_in: 200, money_out: 122, net_change: 78 },
    ]);
    expect(r.transactions.map((t) => [t.date, t.direction, t.amount])).toEqual([
      ["2026-09-01", "in", 100],
      ["2026-09-10", "in", 100],
      ["2026-09-10", "out", 122],
    ]);
    expect(r.top_partners[0]).toEqual({ partner: "ACME d.o.o.", currency: "EUR", money_in: 200, money_out: 0, count: 2 });
    expect(r.statements_not_reconciled).toBeUndefined();
  });

  it("reads Slovenian-format amounts when that is what reconciles with the balance", () => {
    const r = bankSummary([statement({ initial_state: "0", final_state: "5985", transactions: [{ type: "Prejemek", amount: "5.985" }] })]);
    expect(r.transactions[0]!.amount).toBe(5985);
  });

  it("flags statements that don't reconcile either way", () => {
    const r = bankSummary([statement({ final_state: "0" })]);
    expect(r.statements_not_reconciled).toEqual(["34"]);
  });

  it("filters transactions but keeps account totals complete", () => {
    const r = bankSummary([statement()], { direction: "in", partner: "acme" });
    expect(r.transactions).toHaveLength(1);
    expect(r.accounts[0]!.money_out).toBe(122);
  });
});
