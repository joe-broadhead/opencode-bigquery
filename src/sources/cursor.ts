/**
 * `bigquery.jobs`' cursor (design §10, source-contract's `cursor`): a version 2 bound cursor, so another plugin's,
 * source's, account's or scope's cursor is `CURSOR_INVALID` before anything is read. Its state is this plugin's own:
 *
 * - `w`: the creation-time high-water mark, in ms — the end of the last window this source read completely. It is the
 *   end-time frontier used to de-duplicate a lookback (a job that ended at or before it was already listed) and the
 *   anchor for expiry;
 * - `f`, `e`: the window still to read, in creation-time ms, when a page could not carry all of one read's jobs;
 * - `q`: the floor of the older part still owed, while the newer, complete part of a truncated window is being paged;
 * - `p`: the position of the last event emitted from the window `[f, e]`, so a burst larger than a page drains without
 *   repeating one: `(occurred_at ms, id hash)` and ties are walked by the hash. It applies only inside that window; a
 *   new window clears it;
 * - `t`: a `jobs.list` page token for a window that cannot be narrowed further (`jobs.list` is newest first, and a
 *   window's older pages are where the token points);
 * - `k`: 1 while the chain is a **lookback**: every job it lists that ended at or before `w` was listed by the chain
 *   before it, so it is skipped on every page of this chain, not only the first.
 *
 * There is no list of emitted ids. `bigquery.jobs` de-duplicates by time instead, which is exact and needs no room in
 * the 1,024-character cap: a job that was DONE when a window was read ended at or before that read's window end, and
 * every later window's lookback skips an end time at or before the frontier (`endTime <= w`). A job that finished
 * after the frontier was not listed then and is listed now, so nothing is lost either. The frontier is the window end
 * (not "now"): a job created between the window end and the page being answered is outside every window this chain
 * reads, and its end is after the frontier, so the next chain lists it.
 */
import { MAX_CURSOR_LENGTH, canonicalScope, decodeBoundCursor, encodeBoundCursor, type Scope } from "@we-the-rebel-alliance/source-contract/cursor"
import { NAMESPACE } from "../constants.js"
import { sourceError } from "./errors.js"

/** The position inside one window: the last event's end time and its id's hash. */
export interface Position {
  readonly e: number
  readonly h: string
}

export interface CursorState {
  /** The creation-time high-water mark: the end of the last window read completely, in ms. */
  w: number
  /** The window still to read: its creation-time start and end, in ms. */
  f?: number
  e?: number
  /** The older part's floor, while the newer part of a truncated window is being paged. */
  q?: number
  /** The last emitted position inside `[f, e]`. */
  p?: Position
  /** A `jobs.list` page token for the window `[f, e]`, when it cannot be narrowed. */
  t?: string
  /** 1 while this chain is a lookback: skip any job that ended at or before `w`. */
  k?: 1
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
  try {
    return encodeBoundCursor(binding, state as unknown as Readonly<Record<string, unknown>>)
  } catch {
    // Over the contract's 1,024-character cap is a bug here, not in the person's call: say so rather than write a
    // cursor a consumer must refuse.
    throw sourceError("TOO_LARGE", "The read's position is too large to keep in a cursor.", "Read fewer items per page with limit, or start again with since.")
  }
}

export type Decoded = { readonly ok: true; readonly state: CursorState } | { readonly ok: false; readonly what: string }

/** The state a cursor holds for this binding, or the words of its `CURSOR_INVALID` refusal. */
export function decodeState(binding: Binding, cursor: string): Decoded {
  if (cursor.length > MAX_CURSOR_LENGTH) return { ok: false, what: "The cursor is longer than a cursor can be." }
  const decoded = decodeBoundCursor(binding, cursor)
  if (!decoded.ok) {
    return { ok: false, what: decoded.reason === "foreign" ? "The cursor belongs to another source, account or scope." : "The cursor is not one this plugin wrote." }
  }
  const state = decoded.state as Record<string, unknown>
  if (typeof state["w"] !== "number" || !Number.isFinite(state["w"])) return { ok: false, what: "The cursor does not carry this source's position." }
  const position = state["p"] as { e?: unknown; h?: unknown } | undefined
  return {
    ok: true,
    state: {
      w: state["w"],
      ...(typeof state["f"] === "number" ? { f: state["f"] } : {}),
      ...(typeof state["e"] === "number" ? { e: state["e"] } : {}),
      ...(typeof state["q"] === "number" ? { q: state["q"] } : {}),
      ...(position !== undefined && typeof position.e === "number" && typeof position.h === "string" ? { p: { e: position.e, h: position.h } } : {}),
      ...(typeof state["t"] === "string" && state["t"].length <= 400 ? { t: state["t"] } : {}),
      ...(state["k"] === 1 ? { k: 1 } : {}),
    },
  }
}

/** A stable 6-byte FNV-1a hash of an id, as 12 hex characters: a tie-breaker, never the id itself. */
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
