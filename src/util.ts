/** Helpers for Metakocka's string-typed JSON. */

/**
 * Parse a Metakocka number. The API returns numbers as strings, usually with
 * a dot ("24.8") but sometimes in Slovenian format ("1.895,01", "7,3").
 */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  let s = value.trim().replace(/\s/g, "");
  if (!s) return undefined;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: whichever comes last is the decimal separator.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma !== -1) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function bool(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

/** Metakocka returns a single object instead of a one-element list in some places. */
export function asArray<T = Record<string, unknown>>(value: unknown): T[] {
  if (value === undefined || value === null || value === "") return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/** Remove undefined, null, empty strings, empty arrays and empty objects, recursively. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(compact).filter((v) => !isEmpty(v)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v);
      if (!isEmpty(c)) out[k] = c;
    }
    return out as T;
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function str(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

/** Split "a, b,c" or ["a","b"] into a clean list. */
export function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : value.split(",");
  return parts.map((p) => p.trim()).filter(Boolean);
}
