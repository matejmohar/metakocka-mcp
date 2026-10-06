/** Pure calculations for the reporting tools (easy to unit-test). */
import type { MkRecord } from "./api.js";
import { daysBetween, fromMkDate } from "./dates.js";
import { asArray, compact, num, numSl, round2, str } from "./util.js";

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

export interface Payment {
  date?: string;
  amount: number;
  method?: string;
  kind?: string;
  /** No payment detail was returned; the date is when the document was fully paid, or its own date. */
  date_estimated?: true;
}

/**
 * The payments on one document, from mark_paid (search with paymentDetail).
 * Amounts there are in Slovenian format; if they don't add up to sum_paid the
 * other format is tried, and failing that the payment is reported as one
 * lump sum without a reliable date.
 */
export function documentPayments(doc: MkRecord): Payment[] {
  const paid = Math.abs(num(doc.sum_paid) ?? 0);
  const raw = asArray<MkRecord>(doc.mark_paid);
  const lumpSum = (): Payment[] =>
    paid > 0 ? [{ date: fromMkDate(doc.sum_full_paid_when) ?? fromMkDate(doc.doc_date), amount: round2(paid), date_estimated: true }] : [];
  if (!raw.length) return lumpSum();

  const parse = (parseNumber: (v: unknown) => number | undefined) =>
    raw.map((p) => ({
      date: fromMkDate(p.date),
      amount: round2(Math.abs(parseNumber(p.amount) ?? 0)),
      method: str(p.payment_type),
      kind: str(p.payment_tip),
    }));
  const total = (ps: Payment[]) => ps.reduce((s, p) => s + p.amount, 0);
  for (const candidate of [parse(numSl), parse(num)]) {
    if (!paid || Math.abs(total(candidate) - paid) <= 0.01) return candidate.map((p) => compact(p) as Payment);
  }
  return lumpSum();
}

export interface LedgerEntry {
  date?: string;
  entry: "invoice" | "credit_note" | "payment" | "refund";
  number?: string;
  type?: string;
  due_date?: string;
  currency: string;
  /** What this entry adds to the balance: invoices +, credit notes and payments −, refunds +. */
  amount: number;
  method?: string;
  date_estimated?: true;
  running_balance: number;
}

/**
 * A partner's statement of account with dated payments: invoices and credit
 * notes on their dates, each payment on its own date, and a running balance
 * of what is owed. The opening balance is what older, still unpaid documents
 * were owed at the start of the period; payments after the period are left
 * out, so the closing balance is the balance on `period.to`.
 */
export function partnerLedger(docs: MkRecord[], olderOpenDocs: MkRecord[], period: { from: string; to: string }, today: string) {
  const sign = (doc: MkRecord) => (CREDIT_NOTE_TYPES.has(str(doc.doc_type) ?? "") ? -1 : 1);
  const currencyOf = (doc: MkRecord) => str(doc.currency_code) ?? "EUR";
  const opening: Record<string, number> = {};
  const raw: Omit<LedgerEntry, "running_balance">[] = [];
  let paymentsAfterPeriod = 0;

  const addPayments = (doc: MkRecord, inPeriodOnly: boolean) => {
    const s = sign(doc);
    for (const p of documentPayments(doc)) {
      const date = p.date ?? fromMkDate(doc.doc_date);
      if (date && date > period.to) {
        paymentsAfterPeriod++;
        continue;
      }
      if (inPeriodOnly && date && date < period.from) continue; // already in the opening balance
      raw.push(
        compact({
          date,
          entry: s > 0 ? "payment" : "refund",
          number: str(doc.count_code),
          type: str(doc.doc_type),
          currency: currencyOf(doc),
          amount: round2(-s * p.amount),
          method: p.method,
          date_estimated: p.date_estimated,
        }) as Omit<LedgerEntry, "running_balance">,
      );
    }
  };

  for (const doc of olderOpenDocs) {
    const s = sign(doc);
    const paidBefore = documentPayments(doc)
      .filter((p) => (p.date ?? "") < period.from)
      .reduce((sum, p) => sum + p.amount, 0);
    const currency = currencyOf(doc);
    opening[currency] = round2((opening[currency] ?? 0) + s * (Math.abs(num(doc.sum_all) ?? 0) - paidBefore));
    addPayments(doc, true);
  }

  for (const doc of docs) {
    const s = sign(doc);
    raw.push(
      compact({
        date: fromMkDate(doc.doc_date),
        entry: s > 0 ? "invoice" : "credit_note",
        number: str(doc.count_code),
        type: str(doc.doc_type),
        due_date: fromMkDate(doc.duo_payment),
        currency: currencyOf(doc),
        amount: round2(s * Math.abs(num(doc.sum_all) ?? 0)),
      }) as Omit<LedgerEntry, "running_balance">,
    );
    addPayments(doc, false);
  }

  const isDocument = (e: { entry: string }) => e.entry === "invoice" || e.entry === "credit_note";
  raw.sort(
    (a, b) =>
      (a.date ?? "").localeCompare(b.date ?? "") ||
      Number(isDocument(b)) - Number(isDocument(a)) || // documents before payments on the same day
      (a.number ?? "").localeCompare(b.number ?? "", undefined, { numeric: true }),
  );

  const balance: Record<string, number> = { ...opening };
  const totals: Record<string, { invoiced: number; credited: number; paid: number; refunded: number }> = {};
  const entries: LedgerEntry[] = raw.map((e) => {
    balance[e.currency] = round2((balance[e.currency] ?? 0) + e.amount);
    const t = (totals[e.currency] ??= { invoiced: 0, credited: 0, paid: 0, refunded: 0 });
    if (e.entry === "invoice") t.invoiced = round2(t.invoiced + e.amount);
    else if (e.entry === "credit_note") t.credited = round2(t.credited - e.amount);
    else if (e.entry === "payment") t.paid = round2(t.paid - e.amount);
    else t.refunded = round2(t.refunded + e.amount);
    return { ...e, running_balance: balance[e.currency]! };
  });

  // Still open today, across the period's documents and older open ones.
  const openNow: Record<string, { open: number; overdue: number }> = {};
  for (const doc of [...olderOpenDocs, ...docs]) {
    const open = round2(sign(doc) * (Math.abs(num(doc.sum_all) ?? 0) - Math.abs(num(doc.sum_paid) ?? 0)));
    if (open === 0) continue;
    const o = (openNow[currencyOf(doc)] ??= { open: 0, overdue: 0 });
    o.open = round2(o.open + open);
    const due = fromMkDate(doc.duo_payment);
    if (open > 0 && due && due < today) o.overdue = round2(o.overdue + open);
  }

  return {
    opening_balance: opening,
    totals_by_currency: totals,
    closing_balance: balance,
    open_today: openNow,
    payment_behaviour: paymentBehaviour(docs),
    entries,
    ...(paymentsAfterPeriod ? { payments_after_period: paymentsAfterPeriod } : {}),
  };
}

/** How quickly a partner pays: over invoices (not credit notes) that are fully paid with dated payments. */
export function paymentBehaviour(docs: MkRecord[]) {
  const daysToPay: number[] = [];
  const daysLate: number[] = [];
  for (const doc of docs) {
    if (CREDIT_NOTE_TYPES.has(str(doc.doc_type) ?? "")) continue;
    const total = Math.abs(num(doc.sum_all) ?? 0);
    const payments = documentPayments(doc);
    if (!total || payments.some((p) => p.date_estimated || !p.date)) continue;
    if (Math.abs(payments.reduce((s, p) => s + p.amount, 0) - total) > 0.01) continue; // not fully paid
    const lastPaid = payments.map((p) => p.date!).sort().at(-1)!;
    const docDate = fromMkDate(doc.doc_date);
    const due = fromMkDate(doc.duo_payment);
    if (docDate) daysToPay.push(Math.max(0, daysBetween(docDate, lastPaid)));
    if (due) daysLate.push(Math.max(0, daysBetween(due, lastPaid)));
  }
  if (!daysToPay.length) return undefined;
  const avg = (xs: number[]) => Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10;
  return compact({
    paid_invoices: daysToPay.length,
    average_days_to_pay: avg(daysToPay),
    average_days_late: daysLate.length ? avg(daysLate) : undefined,
    paid_late: daysLate.filter((d) => d > 0).length,
    max_days_late: daysLate.length ? Math.max(...daysLate) : undefined,
  });
}
