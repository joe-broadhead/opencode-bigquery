// Package E: bigquery_save (design §7). It asserts its own action, then OpenCode's edit, and external_directory for a
// path outside the project. Day 0 leaves it unbuilt.
import type { Handlers } from "../registry.js"

export const FILE_HANDLERS: Pick<Handlers, "save"> = {}
