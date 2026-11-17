// The fixture capture script parses and runs, and can never run where it would talk to Google (review bigquery-2 M-7).
// It is checked with `node --check` and run only with `--dry-run`, which prints its plan and exits before any request;
// the environment guards are exercised too. No network call is made by any test here.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const SCRIPT = fileURLToPath(new URL("../../../scripts/capture-fixtures/index.mjs", import.meta.url))

/** The environment without the test and CI markers the script refuses, so `--dry-run` can be exercised. */
function cleanEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (["VITEST", "CI", "NODE_ENV", "BQ_CAPTURE", "BQ_CAPTURE_PROJECT", "BQ_CAPTURE_TOKEN"].includes(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

const run = (args: string[], extra: Record<string, string>) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: cleanEnv(extra) })

describe("the fixture capture script", () => {
  test("parses as a module", () => {
    const checked = spawnSync(process.execPath, ["--check", SCRIPT], { encoding: "utf8" })
    expect(checked.status, checked.stderr).toBe(0)
  })

  test("plans its calls with --dry-run and makes no request", () => {
    const planned = run(["--dry-run"], { BQ_CAPTURE: "1", BQ_CAPTURE_PROJECT: "invented-project" })
    expect(planned.status, planned.stderr).toBe(0)
    const calls = planned.stdout.trim().split("\n")
    expect(calls.length).toBeGreaterThanOrEqual(20)
    expect(calls[0]).toBe("projects-list: GET /projects")
    // Every step is a Google v2 path; the token endpoint is not a fixture.
    for (const call of calls) expect(call.split(": ")[1]).toMatch(/^(GET|POST) \/projects(\/|$)/)
    expect(planned.stdout).toContain(":testIamPermissions")
    expect(planned.stdout).toContain("dry-run-select")
  })

  test("refuses a test runner, CI, and a capture without the explicit switch", () => {
    const underTest = run(["--dry-run"], { BQ_CAPTURE: "1", BQ_CAPTURE_PROJECT: "invented-project", VITEST: "1" })
    expect(underTest.status).toBe(2)
    expect(underTest.stderr).toContain("refusing to run under a test runner or CI")

    const inCi = run(["--dry-run"], { BQ_CAPTURE: "1", BQ_CAPTURE_PROJECT: "invented-project", CI: "true" })
    expect(inCi.status).toBe(2)
    expect(inCi.stderr).toContain("refusing to run under a test runner or CI")

    const unswitched = run(["--dry-run"], { BQ_CAPTURE_PROJECT: "invented-project" })
    expect(unswitched.status).toBe(2)
    expect(unswitched.stderr).toContain("BQ_CAPTURE=1")
  })

  test("takes its token from the environment only", () => {
    // A --token on the command line changes nothing: the script reads BQ_CAPTURE_TOKEN and has no such argument.
    const withTokenArg = run(["--dry-run", "--token", "invented-token"], { BQ_CAPTURE: "1", BQ_CAPTURE_PROJECT: "invented-project" })
    expect(withTokenArg.status, withTokenArg.stderr).toBe(0)
    const source = readFileSync(SCRIPT, "utf8")
    expect(source).toMatch(/const token = process\.env\.BQ_CAPTURE_TOKEN/)
    expect(source).not.toContain("args.token")
  })
})
