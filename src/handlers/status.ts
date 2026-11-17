// Package F: bigquery_status (design §13). Day 0 leaves it unbuilt; /bigquery-status and the status RPC already answer.
import type { Handlers } from "../registry.js"

export const STATUS_HANDLERS: Pick<Handlers, "status"> = {}
