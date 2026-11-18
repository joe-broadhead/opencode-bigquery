// `bigquery_save`'s path rules with symbolic links (review bigquery-9 M2): macOS's `/var` → `/private/var` and `/tmp`
// → `/private/tmp` are links, and an agent's shell `pwd` is the logical name, so a root and a path may name the same
// folder through different names. Roots and paths are compared as real paths on both sides: an alias of a root is the
// root, a link inside a root that leads outside is refused, and the path answered (and asked for) is the real one.
// Here a temporary folder is reached through a link of our own, as macOS's temp folder is.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { resolveTarget } from "../../../src/files/paths.js"
import { loadOptions } from "../../../src/options.js"
import { harness, jobStatus, LOCATION, PROJECT, resultPage, runTool } from "../sources/support.js"

const made: string[] = []
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true })
})

/** `real/` and `alias` → `real`, as `/private/var` and `/var`; a project and an extra root inside, and a folder outside. */
function world() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bq-paths-")))
  made.push(base)
  const real = join(base, "real")
  const alias = join(base, "alias")
  mkdirSync(join(real, "project"), { recursive: true })
  mkdirSync(join(real, "extra"), { recursive: true })
  mkdirSync(join(base, "outside"), { recursive: true })
  symlinkSync(real, alias)
  return { base, real, alias }
}

const options = (extra: Record<string, unknown> = {}) => loadOptions({ resultsDir: "results", ...extra })
const refusal = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    return error instanceof BigQueryError ? error.code : String(error)
  }
  return "ok"
}

describe("bigquery_save's roots, compared as real paths", () => {
  test("the project by its real name, the path through the alias: saved, inside the project", () => {
    const { real, alias } = world()
    const target = resolveTarget({ path: join(alias, "project", "out.csv") }, options(), join(real, "project"))
    expect(target).toEqual({ path: join(real, "project", "out.csv"), external: false })
  })

  test("the project through the alias, the path by its real name: saved, inside the project", () => {
    const { real, alias } = world()
    const target = resolveTarget({ path: join(real, "project", "deeper", "out.csv") }, options(), join(alias, "project"))
    expect(target).toEqual({ path: join(real, "project", "deeper", "out.csv"), external: false })
  })

  test("allowedRoots through the alias, the path by its real name: saved, outside the project", () => {
    const { real, alias } = world()
    const target = resolveTarget({ path: join(real, "extra", "out.csv") }, options({ allowedRoots: [join(alias, "extra")] }), join(real, "project"))
    expect(target).toEqual({ path: join(real, "extra", "out.csv"), external: true })
  })

  test("allowedRoots by the real name, the path through the alias: saved, outside the project", () => {
    const { real, alias } = world()
    const target = resolveTarget({ path: join(alias, "extra", "new", "out.csv") }, options({ allowedRoots: [join(real, "extra")] }), join(real, "project"))
    expect(target).toEqual({ path: join(real, "extra", "new", "out.csv"), external: true })
  })

  test("both through the alias: saved, at the real path", () => {
    const { real, alias } = world()
    const target = resolveTarget({ path: join(alias, "project", "out.csv") }, options(), join(alias, "project"))
    expect(target).toEqual({ path: join(real, "project", "out.csv"), external: false })
  })

  test("a link inside the project that leads outside every root is refused, deeper missing folders too", () => {
    const { base, real } = world()
    symlinkSync(join(base, "outside"), join(real, "project", "escape"))
    for (const path of [join(real, "project", "escape", "out.csv"), join(real, "project", "escape", "a", "b", "out.csv")]) {
      expect(refusal(() => resolveTarget({ path }, options(), join(real, "project")))).toBe("SAVE_PATH_REFUSED")
    }
  })

  test("a link inside the project that stays inside it is followed to its real place", () => {
    const { real } = world()
    mkdirSync(join(real, "project", "data"))
    symlinkSync(join(real, "project", "data"), join(real, "project", "shortcut"))
    expect(resolveTarget({ path: join(real, "project", "shortcut", "out.csv") }, options(), join(real, "project")).path).toBe(join(real, "project", "data", "out.csv"))
  })

  test("`..` out of the project, a target that is itself a link, and a folder are refused", () => {
    const { base, real } = world()
    const project = join(real, "project")
    expect(refusal(() => resolveTarget({ path: join(project, "..", "..", "outside", "out.csv") }, options(), project))).toBe("SAVE_PATH_REFUSED")
    writeFileSync(join(base, "outside", "victim.csv"), "keep")
    symlinkSync(join(base, "outside", "victim.csv"), join(project, "link.csv"))
    expect(refusal(() => resolveTarget({ path: join(project, "link.csv"), overwrite: true }, options(), project))).toBe("SAVE_PATH_REFUSED")
    expect(refusal(() => resolveTarget({ path: project }, options(), project))).toBe("SAVE_PATH_REFUSED")
  })

  test("through the tool: a results folder named by its alias saves, and edit is asked for the real path", async () => {
    const { real, alias } = world()
    const target = harness({ resultsDir: join(alias, "extra") })
    target.bigquery.on("getJob", async () => jobStatus({ ref: { projectId: PROJECT, jobId: "job_0001", location: LOCATION } }))
    target.bigquery.on("results", async () => resultPage())
    const saved = await runTool(target, "save", { project: PROJECT, jobId: "job_0001", location: LOCATION, path: join(real, "extra", "r.csv"), format: "csv" })
    expect(saved.output["path"]).toBe(join(real, "extra", "r.csv"))
    const edit = saved.asserted.find((request) => request.action === "edit")
    expect(edit?.resources).toEqual([join(real, "extra", "r.csv")])
    expect(saved.asserted.find((request) => request.action === "external_directory")?.resources).toEqual([join(real, "extra")])
  })
})
