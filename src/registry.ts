// The registry: every tool's spec, in the declared order. TODO(Day 0): the nineteen tools.
import type { Options } from "./options.js"
import type { ToolSpec } from "./tool-spec.js"

/** The specs to register for these options. */
export function toolSpecs(_options: Options): readonly ToolSpec[] {
  return []
}

/** The tools RPC's methods, by name: the read tools. */
export const RPC_METHOD_NAMES: readonly string[] = []
