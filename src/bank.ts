/** Pure calculations for bank statements (izpiski) and cash register journals (blagajniški dnevniki), which have the same shape. */
import type { MkRecord } from "./api.js";
import { daysBetween, fromMkDate } from "./dates.js";
import { asArray, bool, compact, num, numSl, round2, str } from "./util.js";

export interface BankTransaction {
  date?: string;
  statement?: string;
  account?: string;
  direction: "in" | "out";
  amount: number;
  currency: string;
  partner?: string;
  partner_id?: string;
  document?: string;
  type?: string;
  description?: string;
  payment_type?: string;
}

/**
 * "Prejemek" (receipt) is money in, "Izdatek" (expense) money out; both may carry a suffix like " - avans".
 * In a cash register, "Vračilo - prodaja" refunds a customer (out) and "Vračilo - nabava" is a supplier's refund (in).
 */
function directionOf(type: string | undefined): "in" | "out" | undefined {
  const t = type?.toLowerCase() ?? "";
  if (t.startsWith("vračilo - prodaja")) return "out";
  if (t.startsWith("vračilo - nabava")) return "in";
  if (t.startsWith("prejemek") || t.startsWith("priliv")) return "in";
  if (t.startsWith("izdatek") || t.startsWith("odliv")) return "out";
  return undefined;
}

/**
 * Transactions of one statement with amounts parsed so that they reconcile
 * with the statement's own initial and final balance. Metakocka is not
 * consistent about number formats ("5.985" can mean 5985), so both readings
 * are tried; the statement's balance change decides.
 */
function statementTransactions(statement: MkRecord): { transactions: BankTransaction[]; reconciled: boolean } {
  const raw = asArray<MkRecord>(statement.transactions);
  const initial = num(statement.initial_state);
  const final = num(statement.final_state);
  const change = initial !== undefined && final !== undefined ? round2(final - initial) : undefined;

  const read = (parse: (v: unknown) => number | undefined) =>
    raw.map((t) => {
      const amount = parse(t.amount) ?? 0;
      const direction = directionOf(str(t.type)) ?? (amount < 0 ? "out" : "in");
      return { t, amount: round2(Math.abs(amount)), direction };
    });
  const net = (rows: { amount: number; direction: "in" | "out" }[]) =>
    round2(rows.reduce((s, r) => s + (r.direction === "in" ? r.amount : -r.amount), 0));

  let rows = read(num);
  let reconciled = change === undefined || Math.abs(net(rows) - change) <= 0.01;
  if (!reconciled) {
    const alt = read(numSl);
    if (Math.abs(net(alt) - change!) <= 0.01) {
      rows = alt;
      reconciled = true;
    }
  }

  const transactions = rows.map(({ t, amount, direction }) =>
    compact({
      date: fromMkDate(statement.doc_date),
      statement: str(statement.code),
      account: accountOf(statement),
      direction,
      amount,
      currency: str(statement.currency) ?? "EUR",
      partner: str(t.partner),
      partner_id: str(t.partner_id),
      document: str(t.document),
      type: str(t.type),
      description: str(t.description),
      payment_type: str(t.payment_type),
    }) as BankTransaction,
  );
  return { transactions, reconciled };
}

/** A bank statement's account, or a cash register journal's register. */
const accountOf = (statement: MkRecord) => str(statement.bank_account) ?? str(statement.cash_register);

export interface BankFilter {
  direction?: "in" | "out";
  /** Part of the partner name, case-insensitive. */
  partner?: string;
  minAmount?: number;
}

export function bankSummary(statements: MkRecord[], filter: BankFilter = {}) {
  const sorted = [...statements].sort(
    (a, b) =>
      (fromMkDate(a.doc_date) ?? "").localeCompare(fromMkDate(b.doc_date) ?? "") ||
      (str(a.code) ?? "").localeCompare(str(b.code) ?? "", undefined, { numeric: true }),
  );

  const accounts = new Map<string, { account: string; currency: string; statements: number; opening?: number; closing?: number; money_in: number; money_out: number }>();
  const all: BankTransaction[] = [];
  const unreconciled: string[] = [];

  for (const st of sorted) {
    const currency = str(st.currency) ?? "EUR";
    const account = accountOf(st) ?? "(unknown account)";
    const key = `${account}|${currency}`;
    const a = accounts.get(key) ?? { account, currency, statements: 0, money_in: 0, money_out: 0 };
    a.statements++;
    a.opening ??= num(st.initial_state);
    a.closing = num(st.final_state) ?? a.closing;
    const { transactions, reconciled } = statementTransactions(st);
    if (!reconciled) unreconciled.push(str(st.code) ?? "?");
    for (const t of transactions) {
      if (t.direction === "in") a.money_in = round2(a.money_in + t.amount);
      else a.money_out = round2(a.money_out + t.amount);
    }
    accounts.set(key, a);
    all.push(...transactions);
  }

  const wanted = filter.partner?.toLowerCase();
  const matching = all.filter(
    (t) =>
      (!filter.direction || t.direction === filter.direction) &&
      (!wanted || t.partner?.toLowerCase().includes(wanted)) &&
      (filter.minAmount === undefined || t.amount >= filter.minAmount),
  );

  const byPartner = new Map<string, { partner: string; currency: string; money_in: number; money_out: number; count: number }>();
  for (const t of matching) {
    const name = t.partner ?? "(no partner)";
    const key = `${name}|${t.currency}`;
    const p = byPartner.get(key) ?? { partner: name, currency: t.currency, money_in: 0, money_out: 0, count: 0 };
    if (t.direction === "in") p.money_in = round2(p.money_in + t.amount);
    else p.money_out = round2(p.money_out + t.amount);
    p.count++;
    byPartner.set(key, p);
  }

  return {
    accounts: [...accounts.values()].map((a) => ({ ...a, net_change: round2(a.money_in - a.money_out) })),
    top_partners: [...byPartner.values()]
      .sort((x, y) => y.money_in + y.money_out - (x.money_in + x.money_out))
      .slice(0, 15),
    transactions: matching,
    ...(unreconciled.length ? { statements_not_reconciled: unreconciled } : {}),
  };
}

/**
 * A cash register journal as a statement bankSummary understands. Its deposit
 * (polog) is cash taken from the register to the bank: money out, which the
 * journal lists apart from its transactions.
 */
export function cashJournalAsStatement(journal: MkRecord): MkRecord {
  const deposit = num(journal.deposit);
  const transactions = asArray<MkRecord>(journal.transactions);
  return {
    ...journal,
    transactions: deposit ? [...transactions, { type: "Izdatek - polog na banko", amount: String(deposit), description: "Deposit to the bank (polog)" }] : transactions,
  };
}

/** Bank account balances from get_bank_statement_status, with how old the last statement is. */
export function bankBalances(rows: MkRecord[], today: string) {
  const accounts = rows.map((r) => {
    const lastDate = fromMkDate(r.last_statement_date);
    return compact({
      account: str(r.ttr),
      currency: str(r.currency) ?? "EUR",
      balance: num(r.finished_state),
      last_statement: str(r.last_statement_count_code),
      last_statement_date: lastDate,
      days_since_last_statement: lastDate ? daysBetween(lastDate, today) : undefined,
    });
  });
  const totals = new Map<string, number>();
  for (const a of accounts) if (a.balance !== undefined) totals.set(a.currency, round2((totals.get(a.currency) ?? 0) + a.balance));
  return { accounts, total_by_currency: Object.fromEntries(totals) };
}

export interface CompensationBill {
  number?: string;
  date?: string;
  due_date?: string;
  currency: string;
  total?: number;
  compensated?: number;
}

/** Compensations (kompenzacije): which of our invoices and the partner's were set off against each other. */
export function compensationSummary(records: MkRecord[], filter: { partner?: string } = {}) {
  const bills = (list: unknown): CompensationBill[] =>
    asArray<MkRecord>(list).map(
      (b) =>
        compact({
          number: str(b.count_code),
          date: fromMkDate(b.doc_date),
          due_date: fromMkDate(b.duo_payment),
          currency: str(b.currency_code) ?? "EUR",
          total: num(b.sum_all),
          compensated: num(b.compensation_amount),
        }) as CompensationBill,
    );
  const wanted = filter.partner?.toLowerCase();
  const compensations = records
    .filter((r) => !wanted || str(r.partner_desc)?.toLowerCase().includes(wanted))
    .map((r) =>
      compact({
        number: str(r.count_code),
        id: str(r.doc_id),
        date: fromMkDate(r.doc_date),
        partner: str(r.partner_desc),
        partner_id: str(r.partner_id),
        amount: num(r.compensation_amount) ?? 0,
        confirmed: bool(r.confirmed),
        confirmation_date: fromMkDate(r.confirmation_date),
        // Our invoices the partner's debt was set off against, and the partner's invoices to us.
        our_invoices: bills(r.sales_bill_list),
        their_invoices: bills(r.purchase_bill_list),
      }),
    )
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  return {
    compensations,
    total: round2(compensations.reduce((s, c) => s + (c.amount ?? 0), 0)),
    unconfirmed: compensations.filter((c) => c.confirmed === false).length,
  };
}
