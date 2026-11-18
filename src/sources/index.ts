/**
 * Package E's sources (design §10): the `bigquery.jobs` events source, the `bigquery.saved` snapshot and the bind-time
 * `saved_list`, and the plugin's one `probe`. `src/handlers/sources.ts` turns them into the model's tools and the tools
 * RPC's methods; this module holds the reads themselves, so tests and the conformance kit call them the same way.
 */
export { eventsPage, LIST_CALLS, LOOKBACK_MS, MAX_PAGE_BYTES, RETENTION_MS, type SourceDeps } from "./events.js"
export { probeSource } from "./probe.js"
export { DEFAULT_MAX_BYTES, SAVED_OPERATIONS, savedList, savedRead, type SavedListAnswer, type SnapshotAnswer, type TableData } from "./saved.js"
export { sourceError, sourceErrorOf, toolEnvelope } from "./errors.js"
export { bindingOf } from "./cursor.js"
