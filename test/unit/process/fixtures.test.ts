// The fixture set: every file parses, every call is a Google v2 path, and nothing real survived. The capture script
// (scripts/capture-fixtures/) replaces these with sanitised recordings at the live check; this test keeps that promise
// checkable, and keeps the two jobs.insert fixtures apart by their dryRun flag.
import { describe, expect, test } from "vitest"
import { dryRunOf, loadFixtures, matches } from "../../fake/bigquery.js"

const fixtures = loadFixtures()

describe("fixtures", () => {
  test("there is one file per call, each with a request and an answer", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20)
    for (const fixture of fixtures) {
      expect(["GET", "POST"], fixture.name).toContain(fixture.request.method)
      expect(fixture.request.path.startsWith("/bigquery/v2/"), fixture.name).toBe(true)
      expect(typeof fixture.response.status, fixture.name).toBe("number")
    }
  })

  test("no real identifier, address or token survived", () => {
    for (const fixture of fixtures) {
      const text = JSON.stringify(fixture.response)
      expect(text, fixture.name).not.toMatch(/ya29\./)
      expect(text, fixture.name).not.toMatch(/googleusercontent/)
      expect(text, fixture.name).not.toMatch(/Bearer /)
      expect(text, fixture.name).not.toMatch(/@(?!example\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
      expect(text, fixture.name).not.toMatch(/\/(?:Users|private)\//)
      for (const digits of text.match(/(?<![\d-])\d{12}(?![\d-])/g) ?? []) expect(digits, fixture.name).toBe("000000000000")
      for (const projectId of text.match(/"projectId":"([^"]+)"/g) ?? []) expect(projectId, fixture.name).toMatch(/"projectId":"invented-/)
    }
  })

  test("a dry-run route and a run route are told apart by their bodies", () => {
    const dry = fixtures.find((fixture) => fixture.name === "dry-run-select")!
    const run = fixtures.find((fixture) => fixture.name === "job-running")!
    expect(dry.request.dryRun).toBe(true)
    expect(run.request.dryRun).toBe(false)
    const route = { method: "POST", path: dry.request.path, dryRun: true }
    expect(matches(route, { method: "POST", path: dry.request.path, body: { configuration: { dryRun: true } } })).toBe(true)
    expect(matches(route, { method: "POST", path: dry.request.path, body: { configuration: { dryRun: false } } })).toBe(false)
    expect(dryRunOf({ dryRun: true })).toBe(true)
    expect(dryRunOf({ configuration: { dryRun: false } })).toBe(false)
  })
})
