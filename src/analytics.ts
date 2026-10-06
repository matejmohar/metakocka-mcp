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

type Summary = ReturnType<typeof salesSummary>;

function changePercent(now: number, before: number): number | undefined {
  return before === 0 ? undefined : round2(((now - before) / Math.abs(before)) * 100);
}

/**
 * Compare two summaries made with the same grouping. Both must contain every
 * group (top = Infinity) so that a group missing from one period counts as 0;
 * `top` then limits what is shown.
 */
export function compareSummaries(current: Summary, previous: Summary, top: number) {
  const groupBy = current.group_by;
  const key = (g: SummaryGroup) => `${String(g[groupBy])}|${g.currency}`;

  const currencies = new Set([...Object.keys(current.totals_by_currency), ...Object.keys(previous.totals_by_currency)]);
  const totals: Record<string, Record<string, number | undefined>> = {};
  for (const c of currencies) {
    const now = current.totals_by_currency[c] ?? { documents: 0, net: 0, gross: 0 };
    const before = previous.totals_by_currency[c] ?? { documents: 0, net: 0, gross: 0 };
    totals[c] = {
      documents: now.documents,
      previous_documents: before.documents,
      net: now.net,
      previous_net: before.net,
      change_net: round2(now.net - before.net),
      change_percent: changePercent(now.net, before.net),
      gross: now.gross,
      previous_gross: before.gross,
    };
  }

  // Months never match between two periods; show both series side by side instead.
  if (groupBy === "month") {
    return { totals_by_currency: totals, group_by: groupBy, groups: current.groups, previous_groups: previous.groups };
  }

  const prevByKey = new Map(previous.groups.map((g) => [key(g), g]));
  const nowByKey = new Map(current.groups.map((g) => [key(g), g]));
  const withChange = (g: SummaryGroup) => {
    const before = prevByKey.get(key(g))?.net ?? 0;
    return { ...g, previous_net: before, change_net: round2(g.net - before), change_percent: changePercent(g.net, before) };
  };

  const shown = current.groups.slice(0, top).map(withChange);
  // Groups that fell the most, including ones with no sales at all this period (lost customers / products).
  const declines = [...new Set([...prevByKey.keys(), ...nowByKey.keys()])]
    .map((k) => {
      const now = nowByKey.get(k);
      const before = prevByKey.get(k);
      const g = (now ?? before)!;
      const net = now?.net ?? 0;
      const prevNet = before?.net ?? 0;
      return { [groupBy]: g[groupBy], currency: g.currency, net, previous_net: prevNet, change_net: round2(net - prevNet) };
    })
    .filter((g) => g.change_net < 0)
    .sort((a, b) => a.change_net - b.change_net)
    .slice(0, 10);

  return {
    totals_by_currency: totals,
    group_by: groupBy,
    groups: shown,
    groups_not_shown: current.groups.length - shown.length,
    biggest_declines: declines,
    ...(current.lines_without_net_price ? { lines_without_net_price: current.lines_without_net_price } : {}),
  };
}

const CREDIT_NOTE_TYPES = new Set(["sales_bill_credit_note", "purchase_bill_credit_note"]);

export interface StatementRow {
  date?: string;
  number?: string;
  type?: string;
  due_date?: string;
  currency: string;
  /** Negative for credit notes. */
  amount: number;
  paid: number;
  open: number;
  days_overdue?: number;
  running_open_balance: number;
}

/**
 * A partner's account for a period: every invoice and credit note in date
 * order, what is still open on each, and a running balance of open amounts
 * that starts from what was already open on older documents.
 * Metakocka's search results carry the amount paid per document but not the
 * payment dates, so payments are shown per document rather than as their own rows.
 */
export function partnerStatement(docs: MkRecord[], olderOpenDocs: MkRecord[], today: string) {
  const signed = (doc: MkRecord) => {
    const sign = CREDIT_NOTE_TYPES.has(str(doc.doc_type) ?? "") ? -1 : 1;
    const amount = sign * Math.abs(num(doc.sum_all) ?? 0);
    const paid = sign * Math.abs(num(doc.sum_paid) ?? 0);
    return { amount: round2(amount), paid: round2(paid), open: round2(amount - paid) };
  };

  const opening: Record<string, number> = {};
  for (const doc of olderOpenDocs) {
    const currency = str(doc.currency_code) ?? "EUR";
    opening[currency] = round2((opening[currency] ?? 0) + signed(doc).open);
  }

  const sorted = [...docs].sort(
    (a, b) =>
      (fromMkDate(a.doc_date) ?? "").localeCompare(fromMkDate(b.doc_date) ?? "") ||
      (str(a.count_code) ?? "").localeCompare(str(b.count_code) ?? "", undefined, { numeric: true }),
  );

  const balance: Record<string, number> = { ...opening };
  const totals: Record<string, { invoiced: number; credited: number; paid: number; open: number; overdue: number }> = {};
  const rows: StatementRow[] = sorted.map((doc) => {
    const currency = str(doc.currency_code) ?? "EUR";
    const { amount, paid, open } = signed(doc);
    const due = fromMkDate(doc.duo_payment);
    const daysOverdue = due && open > 0 ? Math.max(0, daysBetween(due, today)) : undefined;
    balance[currency] = round2((balance[currency] ?? 0) + open);
    const t = (totals[currency] ??= { invoiced: 0, credited: 0, paid: 0, open: 0, overdue: 0 });
    if (amount >= 0) t.invoiced = round2(t.invoiced + amount);
    else t.credited = round2(t.credited - amount);
    t.paid = round2(t.paid + paid);
    t.open = round2(t.open + open);
    if (daysOverdue) t.overdue = round2(t.overdue + open);
    return {
      date: fromMkDate(doc.doc_date),
      number: str(doc.count_code),
      type: str(doc.doc_type),
      due_date: due,
      currency,
      amount,
      paid,
      open,
      ...(daysOverdue ? { days_overdue: daysOverdue } : {}),
      running_open_balance: balance[currency]!,
    };
  });

  return { opening_open_balance: opening, totals_by_currency: totals, closing_open_balance: balance, rows };
}
