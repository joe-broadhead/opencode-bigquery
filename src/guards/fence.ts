/**
 * The dataset fence (design §5.4): `accounts.<alias>.datasets: { allow?, deny? }`, each entry `"proj.dataset"`,
 * `"proj.*"` or `"*.sales_*"`. Deny wins, and a fence that allows nothing allows nothing: any object it cannot match
 * is fenced, never assumed allowed.
 *
 * It is checked against every object a statement reaches — the dry run's four referenced lists plus every table,
 * view and routine expansion added — before any run, on every path.
 */
import { BigQueryError } from "../domain/errors.js"
import { path } from "../domain/identifiers.js"
import type { Fence } from "./settings.js"

/** One object the fence judges, by project and dataset. `name` is for the message only. */
export interface FenceObject {
  readonly project: string
  readonly dataset: string
  readonly name: string
  /** `table`, `view`, `routine` or `property graph`, for the message. */
  readonly kind: string
}

/** A pattern as a regex: `*` matches anything, everything else is literal. Anchored on `project.dataset`. */
function patternRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}

export function matchesPattern(pattern: string, project: string, dataset: string): boolean {
  return patternRegex(pattern).test(`${project}.${dataset}`)
}

/** Whether this object is outside the fence. No fence, or a fence with neither list, allows everything. */
export function isFenced(fence: Fence | undefined, object: FenceObject): boolean {
  if (!fence) return false
  const deny = fence.deny ?? []
  if (deny.some((pattern) => matchesPattern(pattern, object.project, object.dataset))) return true
  const allow = fence.allow
  if (allow === undefined) return false
  return !allow.some((pattern) => matchesPattern(pattern, object.project, object.dataset))
}

/** Refuses when any object is outside the fence. The message names the first one, from validated identifiers. */
export function assertFenced(fence: Fence | undefined, objects: readonly FenceObject[]): void {
  for (const object of objects) {
    if (!isFenced(fence, object)) continue
    throw new BigQueryError(
      "DATASET_FENCED",
      `The ${object.kind} ${path(object.project, object.dataset, object.name)} is outside the account's dataset fence`,
      "Query a dataset the fence allows, or ask the user to change the account's datasets option.",
    )
  }
}

/** The datasets a fence names outright, for a tool that must walk datasets rather than one SQL statement. */
export function allowedDatasets(fence: Fence | undefined): { readonly project: string; readonly dataset: string }[] {
  if (!fence?.allow) return []
  const out: { project: string; dataset: string }[] = []
  for (const pattern of fence.allow) {
    if (pattern.includes("*")) continue
    const [project, dataset] = pattern.split(".")
    if (project && dataset) out.push({ project, dataset })
  }
  return out
}
