/**
 * `bigquery.jobs`' cursor (design §10, source-contract's `cursor`): a version 2 bound cursor, so another plugin's,
 * source's, account's or scope's cursor is `CURSOR_INVALID` before anything is read. Its state is this plugin's own
 * (the codec keeps `v`, `s` and `b` for itself). Every time is milliseconds on **Google's** clock unless it says host.
 *
 * Between reads (the source's whole memory):
 * - `e`, the **end frontier**: every job of the scope that ended at or before `e` was delivered, or a gap said so;
 * - `f`, the **creation floor**: every job that can still end after `e` was created at or after `f`. It sits below the
 *   oldest job that was still queued or running at the last read (at most 24 h back), and below any job seen finished
 *   after `e`, so the next read lists `[f, …]` and nothing older;
 * - `t`, `u`: the newest Google timestamp seen (`t`) and the host time it was seen at (`u`). Google's now is at least
 *   `t + (host now − u)`: the host's offset from Google cancels, only its rate is trusted;
 * - `o`: 1 while Google keeps reporting a location unreachable and the hold has passed (each read then answers a gap).
 *
 * During a read that spans pages (absent once a read completes):
 * - `c`, the read's **cutoff**: it delivers the jobs that ended in `(e, c]`, and leaves jobs created after `c` to the
 *   next read. Fixed when the read starts, so a later page never moves it;
 * - `n`, the next read's floor so far;
 * - `i`, `p`, `h`: the walk's position: project `i` of the sorted scope, every job created after `p`, and those created
 *   at `p` whose id hash is at most `h`, are handled;
 * - `g`: 1 once this read answered its gap, so no later page repeats it.
 *
 * Worst case: eleven fields, nine of them 13-digit numbers, one 12-character hash, plus the codec's own `v`, `s` and
 * 16-character binding hash: about 210 characters of JSON, about 290 of base64url, whatever the account, scope, load
 * or pause. The contract's cap is 1,024.
 */
import { MAX_CURSOR_LENGTH, canonicalScope, decodeBoundCursor, encodeBoundCursor, type Scope } from "@we-the-rebel-alliance/source-contract/cursor"
import { NAMESPACE } from "../constants.js"
import { sourceError } from "./errors.js"

export interface CursorState {
  /** The end frontier: every job that ended at or before it was delivered, or a gap said so. */
  e: number
  /** The creation floor: every job that can still end after `e` was created at or after it. */
  f: number
  /** The newest Google timestamp seen, and the host time it was seen at. */
  t?: number
  u?: number
  /** 1 while an unreachable location's outage is past the hold and each read answers a gap. */
  o?: 1
  /** This read's cutoff: it delivers jobs that ended in `(e, c]`. Absent between reads. */
  c?: number
  /** The next read's creation floor, so far. */
  n?: number
  /** The walk's position: the project's index, the creation time and the id hash last handled there. */
  i?: number
  p?: number
  h?: string
  /** 1 once this read answered its gap. */
  g?: 1
}

/** The cursor's binding: this plugin, the source, the account and the scope the person confirmed. */
export interface Binding {
  readonly plugin: string
  readonly source: string
  readonly account: string
  readonly scope?: Scope
}

export const bindingOf = (account: string, scope: Scope | undefined): Binding => ({
  plugin: NAMESPACE,
  source: "jobs",
  account,
  ...(scope === undefined ? {} : { scope: canonicalScope(scope) }),
})

export function encodeState(binding: Binding, state: CursorState): string {
  const compact = Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined))
  try {
    return encodeBoundCursor(binding, compact)
  } catch {
    // Over the contract's 1,024-character cap is a bug here (the state is bounded), not in the person's call.
    throw sourceError("TOO_LARGE", "The read's position is too large to keep in a cursor.", "Start again with since.")
  }
}

export type Decoded = { readonly ok: true; readonly state: CursorState } | { readonly ok: false; readonly what: string }

const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** The state a cursor holds for this binding, or the words of its `CURSOR_INVALID` refusal. */
export function decodeState(binding: Binding, cursor: string): Decoded {
  if (cursor.length > MAX_CURSOR_LENGTH) return { ok: false, what: "The cursor is longer than a cursor can be." }
  const decoded = decodeBoundCursor(binding, cursor)
  if (!decoded.ok) {
    return { ok: false, what: decoded.reason === "foreign" ? "The cursor belongs to another source, account or scope." : "The cursor is not one this plugin wrote." }
  }
  const raw = decoded.state
  const e = raw["e"]
  const f = raw["f"]
  if (!time(e) || !time(f)) return { ok: false, what: "The cursor does not carry this source's position." }
  const state: CursorState = { e, f }
  if (time(raw["t"]) && time(raw["u"])) {
    state.t = raw["t"]
    state.u = raw["u"]
  }
  if (raw["o"] === 1) state.o = 1
  // A read in progress carries its cutoff, its next floor and its position together, or not at all.
  if (raw["c"] !== undefined) {
    const c = raw["c"]
    const n = raw["n"]
    const i = raw["i"]
    if (!time(c) || !time(n) || typeof i !== "number" || !Number.isInteger(i) || i < 0 || c < e) {
      return { ok: false, what: "The cursor's read in progress is not one this plugin wrote." }
    }
    state.c = c
    state.n = n
    state.i = i
    if (raw["p"] !== undefined) {
      if (!time(raw["p"]) || typeof raw["h"] !== "string" || !/^[0-9a-f]{12}$/.test(raw["h"])) return { ok: false, what: "The cursor's position is not one this plugin wrote." }
      state.p = raw["p"]
      state.h = raw["h"]
    }
    if (raw["g"] === 1) state.g = 1
  }
  return { ok: true, state }
}

/** A stable 6-byte FNV-1a hash of an id, as 12 hex characters: the walk's tie-breaker, never the id itself. */
export function hashOf(id: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let index = 0; index < id.length; index++) {
    hash ^= BigInt(id.charCodeAt(index))
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, "0").slice(-12)
}

export const iso = (ms: number): string => new Date(ms).toISOString()
