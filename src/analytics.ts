/** Pure calculations for the reporting tools (easy to unit-test). */
import type { MkRecord } from "./api.js";
import { daysBetween, fromMkDate } from "./dates.js";
import { asArray, num, round2, str } from "./util.js";

export interface OpenInvoice {
  id?: string;
  number?: string;
  type?: string;
  partner?: string;
  partner_tax_id?: string;
  date?: string;
  due_date?: string;
  currency: string;
  total: number;
  paid: number;
  open_amount: number;
  days_overdue: number; // 0 when not yet due
}

export function toOpenInvoice(doc: MkRecord, today: string): OpenInvoice | undefined {
  const partner = (doc.partner ?? {}) as MkRecord;
  const total = num(doc.sum_all) ?? 0;
  const paid = num(doc.sum_paid) ?? 0;
  const open = round2(total - paid);
  if (open <= 0) return undefined; // fully paid after all (or a credit)
  const due = fromMkDate(doc.duo_payment);
  return {
    id: str(doc.mk_id),
    number: str(doc.count_code),
    type: str(doc.doc_type),
    partner: str(partner.customer),
    partner_tax_id: str(partner.tax_id_number),
    date: fromMkDate(doc.doc_date),
    due_date: due,
    currency: str(doc.currency_code) ?? "EUR",
    total: round2(total),
    paid: round2(paid),
    open_amount: open,
    days_overdue: due ? Math.max(0, daysBetween(due, today)) : 0,
  };
}

export interface AgingBuckets {
  not_due: number;
  "1_30": number;
  "31_60": number;
  "61_90": number;
  over_90: number;
}

export function agingReport(invoices: OpenInvoice[]) {
  const byCurrency: Record<string, { open_total: number; overdue_total: number; count: number; aging: AgingBuckets }> = {};
  const byPartner = new Map<string, { partner: string; currency: string; open_total: number; count: number; max_days_overdue: number }>();

  for (const inv of invoices) {
    const c = (byCurrency[inv.currency] ??= {
      open_total: 0,
      overdue_total: 0,
      count: 0,
      aging: { not_due: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 },
    });
    c.open_total = round2(c.open_total + inv.open_amount);
    c.count++;
    if (inv.days_overdue > 0) c.overdue_total = round2(c.overdue_total + inv.open_amount);
    const bucket: keyof AgingBuckets =
      inv.days_overdue <= 0 ? "not_due" : inv.days_overdue <= 30 ? "1_30" : inv.days_overdue <= 60 ? "31_60" : inv.days_overdue <= 90 ? "61_90" : "over_90";
    c.aging[bucket] = round2(c.aging[bucket] + inv.open_amount);

    const partnerName = inv.partner ?? "(unknown partner)";
    const key = `${partnerName}|${inv.currency}`;
    const p = byPartner.get(key) ?? { partner: partnerName, currency: inv.currency, open_total: 0, count: 0, max_days_overdue: 0 };
    p.open_total = round2(p.open_total + inv.open_amount);
    p.count++;
    p.max_days_overdue = Math.max(p.max_days_overdue, inv.days_overdue);
    byPartner.set(key, p);
  }

  return {
    totals_by_currency: byCurrency,
    top_partners: [...byPartner.values()].sort((a, b) => b.open_total - a.open_total),
  };
}

export type SalesGroupBy = "partner" | "product" | "month" | "document_type";

/** One row of a sales summary; the grouping value sits under the group_by name (e.g. `partner`). */
export interface SummaryGroup {
  [dimension: string]: string | number | undefined;
  currency: string;
  documents: number;
  net: number;
  gross?: number;
  quantity?: number;
}

/**
 * Net value of one document line. Metakocka lines carry either `price` (net
 * unit price) or `price_with_tax`, plus an optional discount that may be a
 * chain like "10;5" (10 %, then 5 %).
 */
export function lineNetValue(line: MkRecord): number | undefined {
  const amount = num(line.amount) ?? 0;
  let unit = num(line.price);
  if (unit === undefined) {
    const gross = num(line.price_with_tax);
    const factor = num(line.tax_factor);
    if (gross === undefined) return undefined;
    unit = factor !== undefined ? gross / (1 + factor) : undefined;
    if (unit === undefined) return undefined;
  }
  let value = amount * unit;
  for (const d of String(line.discount ?? "").split(";")) {
    const pct = num(d);
    if (pct) value *= 1 - pct / 100;
  }
  return value;
}

export function salesSummary(docs: MkRecord[], groupBy: SalesGroupBy, top: number) {
  const totals: Record<string, { documents: number; net: number; gross: number }> = {};
  const groups = new Map<string, { key: string; currency: string; documents: number; net: number; gross: number; quantity?: number }>();
  let linesWithoutPrice = 0;

  for (const doc of docs) {
    const currency = str(doc.currency_code) ?? "EUR";
    const net = num(doc.sum_basic) ?? 0;
    const gross = num(doc.sum_all) ?? 0;
    const t = (totals[currency] ??= { documents: 0, net: 0, gross: 0 });
    t.documents++;
    t.net = round2(t.net + net);
    t.gross = round2(t.gross + gross);

    if (groupBy === "product") {
      for (const line of asArray<MkRecord>(doc.product_list)) {
        const value = lineNetValue(line);
        if (value === undefined) linesWithoutPrice++;
        const name = [str(line.code) ?? str(line.count_code), str(line.name) ?? str(line.name_desc)].filter(Boolean).join(" – ") || "(unknown product)";
        const key = `${name}|${currency}`;
        const g = groups.get(key) ?? { key: name, currency, documents: 0, net: 0, gross: 0, quantity: 0 };
        g.documents++;
        g.quantity = round2((g.quantity ?? 0) + (num(line.amount) ?? 0));
        g.net = round2(g.net + (value ?? 0));
        groups.set(key, g);
      }
      continue;
    }

    const name =
      groupBy === "partner"
        ? str(((doc.partner ?? {}) as MkRecord).customer) ?? "(unknown partner)"
        : groupBy === "month"
          ? (fromMkDate(doc.doc_date) ?? "unknown").slice(0, 7)
          : str(doc.doc_type) ?? "unknown";
    const key = `${name}|${currency}`;
    const g = groups.get(key) ?? { key: name, currency, documents: 0, net: 0, gross: 0 };
    g.documents++;
    g.net = round2(g.net + net);
    g.gross = round2(g.gross + gross);
    groups.set(key, g);
  }

  let rows = [...groups.values()];
  rows = groupBy === "month" ? rows.sort((a, b) => a.key.localeCompare(b.key)) : rows.sort((a, b) => b.net - a.net);
  const shown = groupBy === "month" ? rows : rows.slice(0, top);
  return {
    totals_by_currency: totals,
    group_by: groupBy,
    groups: shown.map(({ key, gross, ...rest }): SummaryGroup => ({
      [groupBy]: key,
      ...rest,
      // Line-level gross isn't reliable (tax per line varies), so products report net only.
      ...(groupBy === "product" ? {} : { gross }),
    })),
    groups_not_shown: rows.length - shown.length,
    ...(linesWithoutPrice ? { lines_without_net_price: linesWithoutPrice } : {}),
  };
}
