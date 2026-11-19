import { afterEach, describe, expect, it } from "vitest"
import { BigQueryError } from "../../src/domain/errors.js"
import { guardGoogleFetch, isTaggedRelease, NOT_RELEASED_DETAIL, simulateTaggedRelease } from "../../src/release.js"

describe("a source install does not call Google", () => {
  afterEach(() => simulateTaggedRelease(undefined))

  it("is not a tagged release in this checkout, and a test can simulate one", () => {
    simulateTaggedRelease(undefined)
    expect(isTaggedRelease()).toBe(false)
    simulateTaggedRelease(true)
    expect(isTaggedRelease()).toBe(true)
  })

  it("refuses a Google host before the fetch runs, and a simulated release keeps the handler", async () => {
    let called = false
    const base = (async () => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const refuse = () => {
      throw new BigQueryError("NOT_RELEASED", NOT_RELEASED_DETAIL, "Install a tagged release when one exists.")
    }
    const blocked = guardGoogleFetch(base, false, refuse)
    expect(() => blocked("https://bigquery.googleapis.com/bigquery/v2/projects")).toThrow(/^NOT_RELEASED: /)
    expect(called).toBe(false)
    await expect(blocked("http://127.0.0.1:9/health")).resolves.toBeInstanceOf(Response)
    expect(called).toBe(true)
    called = false
    const released = guardGoogleFetch(base, true, refuse)
    await released("https://bigquery.googleapis.com/bigquery/v2/projects")
    expect(called).toBe(true)
  })
})
