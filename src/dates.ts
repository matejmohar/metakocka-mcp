/**
 * Metakocka dates look like "2025-05-07+02:00" (date + Central European
 * offset) and timestamps like "2025-05-07T12:53:27+02:00". Tools accept plain
 * ISO dates (YYYY-MM-DD) and convert them here.
 *
 * Search filters are sent as "dd.MM.yyyy": Metakocka rejects the documented
 * "yyyy-MM-dd+01:00" form for winter dates ("Cannot find value … for condition
 * doc_date_from") and only parses a literal "+02:00" offset.
 */

const TIME_ZONE = "Europe/Ljubljana";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** "2025-01-31" → "31.01.2025", the date format Metakocka's search filters accept all year round. */
export function toMkDate(isoDate: string): string {
  if (!isIsoDate(isoDate)) throw new Error(`Invalid date "${isoDate}", expected YYYY-MM-DD`);
  const [y, m, d] = isoDate.split("-");
  return `${d}.${m}.${y}`;
}

/** "2025-01-31+01:00" or "2025-01-31T10:00:00+01:00" → "2025-01-31". Also accepts "31.01.2025". */
export function fromMkDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const iso = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const si = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (si) return `${si[3]}-${si[2]!.padStart(2, "0")}-${si[1]!.padStart(2, "0")}`;
  return undefined;
}

/** Today's date in Ljubljana, as YYYY-MM-DD. */
export function todayInLjubljana(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** "2026-03-31" + 1 → "2026-04-01" */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based here
}

/** Shift a date by whole months, clamping the day (Mar 31 − 1 month → Feb 28/29). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const day = Math.min(d, lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface Period {
  from: string;
  to: string;
}

/**
 * The period right before [from, to] of the same length. Whole calendar
 * months map to the same number of preceding months (Sep → Aug, Q3 → Q2);
 * anything else maps to the same number of days just before `from`.
 */
export function previousPeriod(from: string, to: string): Period {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  if (fd === 1 && td === lastDayOfMonth(ty, tm)) {
    const months = (ty - fy) * 12 + (tm - fm) + 1;
    const prevFrom = addMonths(from, -months);
    const prevEnd = addMonths(prevFrom, months - 1);
    const [py, pm] = prevEnd.split("-").map(Number) as [number, number];
    return { from: prevFrom, to: `${prevEnd.slice(0, 8)}${String(lastDayOfMonth(py, pm)).padStart(2, "0")}` };
  }
  const length = daysBetween(from, to) + 1;
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

/** The same dates one year earlier (Feb 29 → Feb 28; a period ending on Feb 28 of a leap year ends on Feb 28). */
export function samePeriodLastYear(from: string, to: string): Period {
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  const toWasMonthEnd = td === lastDayOfMonth(ty, tm);
  const prevTo = addMonths(to, -12);
  const [py, pm] = prevTo.split("-").map(Number) as [number, number];
  return {
    from: addMonths(from, -12),
    to: toWasMonthEnd ? `${prevTo.slice(0, 8)}${String(lastDayOfMonth(py, pm)).padStart(2, "0")}` : prevTo,
  };
}
