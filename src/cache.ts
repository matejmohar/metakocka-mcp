/**
 * A small in-memory cache for lookups that rarely change (warehouses,
 * partners). Metakocka answers one request at a time per company, so every
 * call saved makes the other tools faster. Concurrent requests for the same
 * key share one call; failures are not cached.
 */
export class TtlCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(
    /** 0 disables caching. */
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value as Promise<T>;

    const value = load();
    this.entries.set(key, { expires: this.now() + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
