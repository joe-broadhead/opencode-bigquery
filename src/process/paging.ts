/**
 * Paging for results (design §7, §8): a page is asked for one row more than the model may see, so a full page proves
 * there is another. `jobs.getQueryResults` pages by `pageToken`; the rows themselves are shaped by
 * `src/process/values.ts` (`inlineRows`), and a result too large for the inline caps is saved rather than read.
 */

/** The rows to ask Google for: one more than the model may see, so `truncated.rows` is a fact, not a guess (§7). */
export const pageSize = (maxRows: number): number => Math.max(1, maxRows) + 1
