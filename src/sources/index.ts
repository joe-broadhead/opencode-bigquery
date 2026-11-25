/**
 * The sources' reads (design §10): the `bigquery.jobs` events source, the `bigquery.saved` snapshot and its bind-time
 * `saved_list`, and the plugin's one `probe`. `src/handlers/sources.ts` turns them into the handler table's methods; this
 * module holds the reads themselves, so tests and the conformance fixture call them the same way.
 */

export { bindingOf } from "./cursor.js";
export { sourceError } from "./errors.js";
export { eventsPage, LIST_CALLS, LOOKBACK_MS, MAX_DARK, MAX_PAGE_BYTES, RETENTION_MS, SETTLE_MS, type SourceDeps, UNFINISHED_CALLS } from "./events.js";
export { probeSource } from "./probe.js";
export { DEFAULT_MAX_BYTES, type SavedListAnswer, type SnapshotAnswer, savedList, savedRead, type TableData } from "./saved.js";
