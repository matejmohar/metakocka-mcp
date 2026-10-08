/**
 * How many requests the server sends to Metakocka at once.
 *
 * Calls come in two kinds. A search (document search, product and stock
 * lists, bank statements, exports) can scan a large part of a company's data,
 * and Metakocka runs them one after another per company anyway, so they get
 * their own, lower limit. Everything else (a document or partner by ID,
 * filter discovery, saving a document) is cheap and only counts against the
 * overall limit.
 */

export type CallKind = "search" | "direct";

export interface ConcurrencyLimits {
  /** Requests in flight at once, of any kind. */
  maxConcurrent: number;
  /** Searches in flight at once; never more than maxConcurrent. */
  maxConcurrentSearch: number;
  /** How long a call may wait for a free slot before it fails. */
  queueTimeoutMs: number;
}

export const DEFAULT_LIMITS: ConcurrencyLimits = { maxConcurrent: 2, maxConcurrentSearch: 1, queueTimeoutMs: 300_000 };

/** Endpoints that scan many records. Any other endpoint is a direct call unless the caller says otherwise. */
export const SEARCH_ENDPOINTS: ReadonlySet<string> = new Set([
  "search",
  "json/product_list",
  "json/warehouse_stock",
  "json/get_bank_statement",
  "json/get_bank_compensation",
  "json/cash_register_journal",
  "search_tracking_code",
  "search_blacklist_partner",
  "source_stock",
  "accounting_export",
]);

export function kindOf(endpoint: string): CallKind {
  return SEARCH_ENDPOINTS.has(endpoint.replace(/^(\.\.\/|\/)+/, "")) ? "search" : "direct";
}

export class QueueTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueTimeoutError";
  }
}

/** A counting semaphore with a FIFO wait queue. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly size: number) {}

  /** Resolves with a release function once a slot is free; rejects after `timeoutMs` of waiting. */
  acquire(timeoutMs: number, describe: () => string): Promise<() => void> {
    if (this.active < this.size) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new QueueTimeoutError(describe()));
      }, timeoutMs);
      this.waiting.push(grant);
    });
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // The slot passes straight to the next caller, so active stays the same.
      if (next) next();
      else this.active--;
    };
  }
}

/** A global limit plus a tighter one for searches. */
export class RequestLimiter {
  private readonly all: Semaphore;
  private readonly search: Semaphore;

  constructor(readonly limits: ConcurrencyLimits = DEFAULT_LIMITS) {
    this.all = new Semaphore(limits.maxConcurrent);
    this.search = new Semaphore(Math.min(limits.maxConcurrentSearch, limits.maxConcurrent));
  }

  async run<T>(kind: CallKind, endpoint: string, task: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const remaining = () => Math.max(this.limits.queueTimeoutMs - (Date.now() - started), 0);
    const busy = () =>
      `Metakocka request ${endpoint} waited ${Math.round(this.limits.queueTimeoutMs / 1000)} s for a free slot ` +
      `(${this.all.inFlight} running, at most ${this.limits.maxConcurrent} at once and ` +
      `${this.limits.maxConcurrentSearch} search${this.limits.maxConcurrentSearch === 1 ? "" : "es"}). ` +
      "Try again when the running requests finish, or ask for less data at once.";
    // The search slot first: a search waiting for its turn must not hold a slot direct calls could use.
    const releaseSearch = kind === "search" ? await this.search.acquire(remaining(), busy) : undefined;
    let releaseAll: (() => void) | undefined;
    try {
      releaseAll = await this.all.acquire(remaining(), busy);
      return await task();
    } finally {
      releaseAll?.();
      releaseSearch?.();
    }
  }
}
