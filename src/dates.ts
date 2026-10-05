/**
 * Metakocka dates look like "2025-05-07+02:00" (date + Central European
 * offset) and timestamps like "2025-05-07T12:53:27+02:00". Tools accept plain
 * ISO dates (YYYY-MM-DD) and convert them here.
 */

const TIME_ZONE = "Europe/Ljubljana";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC offset of Europe/Ljubljana at the given instant, as "+01:00" or "+02:00". */
export function ljubljanaOffset(at: Date): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const match = part?.match(/GMT([+-]\d{2}):?(\d{2})?/);
  if (!match) return "+00:00"; // "GMT" alone means UTC
  return `${match[1]}:${match[2] ?? "00"}`;
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** "2025-01-31" → "2025-01-31+01:00" */
export function toMkDate(isoDate: string): string {
  if (!isIsoDate(isoDate)) throw new Error(`Invalid date "${isoDate}", expected YYYY-MM-DD`);
  return `${isoDate}${ljubljanaOffset(new Date(`${isoDate}T12:00:00Z`))}`;
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
