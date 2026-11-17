// Package C: bigquery_list, _table, _search, _estimate, _query, _job, _jobs and _profile, on the read path (design
// §5.1). Day 0 leaves them unbuilt: the registry answers NOT_BUILT for any name missing here.
import type { Handlers } from "../registry.js"

export const READ_HANDLERS: Pick<Handlers, "list" | "table" | "search" | "estimate" | "query" | "job" | "jobs" | "profile"> = {}
