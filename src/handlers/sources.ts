/**
 * Package E: the two sources (design §10). `events_list` and `saved_read` are model tools and tools RPC methods;
 * `saved_list` (the saved source's bind-time `scope.suggest`) and `probe` are methods only, declared in the action table
 * as read-only methods.
 *
 * A source read answers the contract's page or snapshot, never this plugin's tool envelope — the tools RPC and the
 * conformance kit read it as `events`' `EventsListResult` and `read`'s `Snapshot`. On the model path a failure becomes
 * the plugin's ordinary result envelope (`state`, `error`, `message`, `next`, `retryAfterSec`), so a model sees the same
 * shape as for every other tool; on the RPC path it is thrown, so the tools RPC reports the contract's code.
 */
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import type { OutputOf } from "../domain/contract.js"
import type { HandlerContext, Handlers } from "../registry.js"
import { eventsPage, probeSource, savedList, savedRead, toolEnvelope, type SourceDeps } from "../sources/index.js"

const depsOf = (context: HandlerContext): SourceDeps => ({ ports: context.ports, options: context.options, account: context.account, call: context.call })

/** A source failure: the model gets an envelope; a script's tools RPC call gets the `SourceError` itself. */
async function answered<T>(context: HandlerContext, work: () => Promise<T>): Promise<T | Record<string, unknown>> {
  try {
    return await work()
  } catch (error) {
    if (context.call.via === "rpc") throw error
    if (error instanceof SourceError) return toolEnvelope(error)
    throw error
  }
}

const events_list: Handlers["events_list"] = async (input, context) => {
  const page = await answered(context, () => eventsPage(depsOf(context), input))
  return page as unknown as OutputOf<"events_list">
}

const saved_read: Handlers["saved_read"] = async (input, context) => {
  const snapshot = await answered(context, () => savedRead(depsOf(context), input.name, input.scope))
  return snapshot as unknown as OutputOf<"saved_read">
}

const saved_list: Handlers["saved_list"] = async (_input, context) => {
  const answer = await answered(context, () => savedList(depsOf(context)))
  return answer as unknown as OutputOf<"saved_list">
}

const probe: Handlers["probe"] = async (input, context) => {
  const answer = await answered(context, () => probeSource(depsOf(context), input))
  return answer as unknown as OutputOf<"probe">
}

export const SOURCE_HANDLERS: Pick<Handlers, "events_list" | "saved_read" | "saved_list" | "probe"> = {
  events_list,
  saved_read,
  saved_list,
  probe,
}
