/**
 * A small TTL cache, one per owner object (the plugin's ports) and name, so every handler of one plugin instance shares
 * it and tests never share one across plugins. Two uses, both from the design: expansion lives 60 s per account
 * (R2-L1) and a table's row-access answer 10 minutes (§5.1 step 7).
 */
const stores = new WeakMap<object, Map<string, TtlCache<unknown>>>()

export class TtlCache<V> {
  private readonly entries = new Map<string, { readonly expiresAt: number; readonly value: V }>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: V): V {
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value })
    return value
  }

  clear(): void {
    this.entries.clear()
  }

  /** The number of live entries, for a test that the TTL is enforced. */
  size(): number {
    for (const [key, entry] of this.entries) if (this.now() >= entry.expiresAt) this.entries.delete(key)
    return this.entries.size
  }
}

export function cacheOf<V>(owner: object, name: string, ttlMs: number, now: () => number): TtlCache<V> {
  let perOwner = stores.get(owner)
  if (!perOwner) {
    perOwner = new Map()
    stores.set(owner, perOwner)
  }
  const found = perOwner.get(name)
  if (found) return found as TtlCache<V>
  const created = new TtlCache<V>(ttlMs, now)
  perOwner.set(name, created as TtlCache<unknown>)
  return created
}
