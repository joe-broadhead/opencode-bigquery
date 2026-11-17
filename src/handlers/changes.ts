// Package D: bigquery_plan, the five commit tools and bigquery_cancel (design §5.2). A commit asserts its own action in
// the handler, with the plan's preview as metadata (src/domain/plans.ts planMetadata), and `save` only when the action
// table says it is savable. Day 0 leaves them unbuilt.
import type { Handlers } from "../registry.js"

export const CHANGE_HANDLERS: Pick<Handlers, "plan" | "write" | "export" | "share" | "delete" | "admin" | "cancel"> = {}
