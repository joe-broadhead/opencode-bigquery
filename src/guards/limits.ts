/**
 * How many query jobs one account may have in flight (design §6.2 item 5, `maxConcurrentJobs`, 4 by default). A call
 * that has to wait waits on a queue and gives up when its own signal aborts, so Stop never leaves a job running behind
 * a call that already returned. One limiter per account and plugin instance, so tests never share one.
 */
import { BigQueryError } from "../domain/errors.js"

const limiters = new WeakMap<object, Map<string, Limiter>>()

export class Limiter {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await work()
    } finally {
      this.release()
    }
  }

  /** The number of calls holding a slot, for a test. */
  inFlight(): number {
    return this.active
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new BigQueryError("CANCELLED", "The call was stopped before it reached the queue"))
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort)
        this.active += 1
        resolve()
      }
      const abort = () => {
        const at = this.waiting.indexOf(start)
        if (at >= 0) this.waiting.splice(at, 1)
        reject(new BigQueryError("CANCELLED", "The call was stopped while it waited for a free job slot"))
      }
      this.waiting.push(start)
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  private release(): void {
    this.active -= 1
    const next = this.waiting.shift()
    if (next) next()
  }
}

export function limiterFor(owner: object, account: string, limit: number): Limiter {
  let perOwner = limiters.get(owner)
  if (!perOwner) {
    perOwner = new Map()
    limiters.set(owner, perOwner)
  }
  const found = perOwner.get(account)
  if (found) return found
  const created = new Limiter(limit)
  perOwner.set(account, created)
  return created
}
