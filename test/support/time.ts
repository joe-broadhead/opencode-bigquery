// One fixed clock for every test: the fake's answers, the pages' `asOf`, and the cursor binding are all derived from it,
// so a conformance fixture recorded twice is byte-identical.
export const NOW = Date.parse("2026-11-20T09:00:00.000Z")

/** A clock that starts at NOW and advances a second per call, so two job ids differ. */
export function testClock(start = NOW) {
  let at = start
  let ids = 0
  return {
    now: () => at,
    uuid: () => {
      ids += 1
      at += 1000
      return `00000000-0000-4000-8000-${String(ids).padStart(12, "0")}`
    },
  }
}
