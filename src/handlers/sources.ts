// Package E: the two sources (design §10): events_list and saved_read, and the method-only saved_list and probe.
// Day 0 leaves them unbuilt.
import type { Handlers } from "../registry.js"

export const SOURCE_HANDLERS: Pick<Handlers, "events_list" | "saved_read" | "saved_list" | "probe"> = {}
