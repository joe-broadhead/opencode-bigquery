/**
 * The spend ledger (design §6.2 item 4): every finished job's actual `totalBytesBilled`, one JSON line per job, in
 * `$XDG_STATE_HOME/opencode-bigquery/spend.jsonl`. Appends take a cross-process lock and write one line with a single
 * `append` of a newline-terminated record, so two OpenCode processes never interleave a line; a reader that meets a
 * torn last line (a process killed mid-write) ignores only that line.
 *
 * The ledger never holds a row, a token or the session id: the session is a hash (`sessionHash`). Bytes are bytes
 * billed, not estimated, so a budget is a statement about what Google charged.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import { join } from "node:path"
import type { LedgerPort, SpendEntry } from "../ports.js"

/** A lock older than this was left by a dead process, and is broken. */
const STALE_MS = 10_000
/** How long to wait for the lock before writing anyway: one O_APPEND write is atomic on a local file system. */
const WAIT_MS = 2_000

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export interface LedgerDeps {
  readonly stateDir: string
  /** Injected by a test that must not wait; the plugin never passes it. */
  readonly sleep?: (ms: number) => void
}

const FILE = "spend.jsonl"

export function createLedger(deps: LedgerDeps): LedgerPort {
  const file = join(deps.stateDir, FILE)
  const lock = `${file}.lock`
  const pause = deps.sleep ?? sleep

  const ensureFolder = () => mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 })

  /** The lock file, held for the length of one append. True when this process holds it. */
  const acquire = (): boolean => {
    const deadline = Date.now() + WAIT_MS
    for (;;) {
      try {
        const fd = openSync(lock, "wx", 0o600)
        try {
          writeSync(fd, String(process.pid))
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        return true
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "EEXIST") return false
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_MS) unlinkSync(lock)
        } catch {
          // Another process removed it first: try again at once.
        }
        if (Date.now() >= deadline) return false
        pause(2)
      }
    }
  }

  const alreadyRecorded = (account: string, jobId: string): boolean => {
    if (!existsSync(file)) return false
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      return false
    }
    for (const line of text.split("\n")) {
      if (!line.includes(jobId)) continue
      try {
        const entry = JSON.parse(line) as Partial<SpendEntry>
        if (entry.account === account && entry.jobId === jobId) return true
      } catch {
        continue
      }
    }
    return false
  }

  const release = (held: boolean) => {
    if (!held) return
    try {
      unlinkSync(lock)
    } catch {
      // Already gone: nothing to release.
    }
  }

  return {
    async record(entry: SpendEntry): Promise<void> {
      ensureFolder()
      const line = `${JSON.stringify({
        at: entry.at,
        account: entry.account,
        project: entry.project,
        location: entry.location,
        jobId: entry.jobId,
        bytesBilled: Math.max(0, Math.trunc(entry.bytesBilled)),
        via: entry.via,
        session: entry.session,
      })}\n`
      const held = acquire()
      try {
        // One job one line: a job first seen running and recorded when it finished is written once, by jobId.
        if (alreadyRecorded(entry.account, entry.jobId)) return
        const fd = openSync(file, "a", 0o600)
        try {
          writeSync(fd, line)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      } finally {
        release(held)
      }
    },

    async spent(query: { readonly account: string; readonly since: number; readonly session?: string }): Promise<number> {
      if (!existsSync(file)) return 0
      let text: string
      try {
        text = readFileSync(file, "utf8")
      } catch {
        return 0
      }
      // A torn final line (no newline) is a write that never finished; every other line is a finished job.
      const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1)
      let sum = 0
      // A backstop for the lock's timeout (review bigquery-3 round 2, LOW 5): two processes that both waited out the lock
      // could each append one job; it is counted once.
      const counted = new Set<string>()
      for (const line of complete.split("\n")) {
        if (line.trim() === "") continue
        let entry: Partial<SpendEntry>
        try {
          entry = JSON.parse(line) as Partial<SpendEntry>
        } catch {
          continue
        }
        if (entry.account !== query.account) continue
        if (typeof entry.bytesBilled !== "number" || !Number.isFinite(entry.bytesBilled)) continue
        if (query.session !== undefined && entry.session !== query.session) continue
        const at = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN
        if (!Number.isFinite(at) || at < query.since) continue
        if (typeof entry.jobId === "string" && entry.jobId !== "") {
          if (counted.has(entry.jobId)) continue
          counted.add(entry.jobId)
        }
        sum += entry.bytesBilled
      }
      return sum
    },
  }
}
