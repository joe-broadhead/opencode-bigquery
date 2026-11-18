/**
 * Where `bigquery_save` writes (design §7): a path inside the project, `resultsDir` or the `allowedRoots` option, and
 * nowhere else (`SAVE_PATH_REFUSED`). A symbolic link is refused in any component the save would traverse, so a link
 * inside the project cannot walk the write outside it. An existing file is `SAVE_EXISTS` unless `overwrite: true`.
 *
 * The write goes to a temporary name beside the target and is renamed into place, so a failed or refused save never
 * leaves a half-written file under the name the person reads.
 *
 * OpenCode's own file permissions are asked for too: `edit` on the target, and `external_directory` when the target is
 * outside the project (design §4's row for this tool, §14.3's host suite).
 */
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { BigQueryError } from "../domain/errors.js"
import type { Options } from "../options.js"
import type { Call } from "../tool-spec.js"

export type SaveFormat = "csv" | "jsonl" | "parquet"

/** The target's absolute path, and whether it is outside the project OpenCode runs in. */
export interface SaveTarget {
  readonly path: string
  readonly external: boolean
}

const inside = (path: string, root: string): boolean => {
  const rel = relative(resolve(root), resolve(path))
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** The nearest ancestor of `path` that exists, for a realpath check before the target's folders are made. */
function nearestExisting(path: string): string {
  let current = path
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

const refused = (detail: string, next = "Save to a path inside the project, or one under allowedRoots.") => new BigQueryError("SAVE_PATH_REFUSED", detail, next)

/** The target's absolute path, after every check that can be made before anything is written. */
export function resolveTarget(input: { readonly path: string; readonly overwrite?: boolean }, options: Options, cwd = process.cwd()): SaveTarget {
  const results = resolve(cwd, options.resultsDir)
  const roots = [cwd, results, ...options.allowedRoots.map((root) => resolve(cwd, root))]
  const target = resolve(cwd, input.path)
  const root = roots.filter((candidate) => inside(target, candidate)).sort((left, right) => right.length - left.length)[0]
  if (root === undefined) throw refused("The save path is outside the project, resultsDir and allowedRoots.")
  if (target === root) throw refused("The save path is a folder, not a file.")
  // A symlink anywhere from the root to the target could walk the write outside it, so it is refused rather than
  // followed. The realpath check also catches a root that is itself a link.
  const ancestor = nearestExisting(dirname(target))
  const realAncestor = realpathSync(ancestor)
  if (!inside(realAncestor, realpathSync(root))) throw refused("The save path resolves outside the roots through a symbolic link.")
  let current = target
  for (;;) {
    // `existsSync` follows the link, so a link to a missing file would pass it: `lstat` is what sees the link itself.
    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      stat = lstatSync(current)
    } catch {
      stat = undefined
    }
    if (stat?.isSymbolicLink() === true) throw refused("The save path is a symbolic link, which this tool never writes through.")
    const parent = dirname(current)
    if (parent === current || current === ancestor || !inside(current, root)) break
    current = parent
  }
  if (existsSync(target)) {
    if (!lstatSync(target).isFile()) throw refused("The save path exists and is not a regular file.")
    if (input.overwrite !== true) {
      throw new BigQueryError("SAVE_EXISTS", "A file already exists at the save path.", "Choose another path, or pass overwrite: true after the user agrees.")
    }
  }
  return { path: target, external: !inside(target, cwd) }
}

/** `edit` on the file, and `external_directory` on its folder when the file is outside the project. */
export async function assertEdit(target: SaveTarget, call: Call): Promise<void> {
  await call.assert({ action: "edit", resources: [target.path], metadata: { path: target.path } })
  if (target.external) await call.assert({ action: "external_directory", resources: [dirname(target.path)], metadata: { path: target.path } })
}
