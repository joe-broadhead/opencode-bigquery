// Package C: the spend ledger, $XDG_STATE_HOME/opencode-bigquery/spend.jsonl, appended atomically under a cross-process
// lock, counted from each finished job's actual totalBytesBilled (design §6.2). Day 0 wires the unbuilt port.
import type { LedgerPort } from "../ports.js"
import { unbuilt } from "../unbuilt.js"

export function createLedger(_deps: { readonly stateDir: string }): LedgerPort {
  return unbuilt<LedgerPort>("ledger")
}
