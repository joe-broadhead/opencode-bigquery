/**
 * Where `save` writes (design §7): a path inside the project, `resultsDir` or the `allowedRoots` option, and
 * nowhere else (`SAVE_PATH_REFUSED`). Roots and the target are compared as real paths, so a link inside the project
 * cannot walk the write outside it, and an alias of a root (macOS's `/var` and `/private/var`) is still that root. An
 * existing file is `SAVE_EXISTS` unless `overwrite: true`.
 *
 * The write goes to a temporary name beside the target and is renamed into place, so a failed or refused save never
 * leaves a half-written file under the name the person reads.
 *
 * The method is class export: under `ask-changes` the whole save asks before it runs, and the access level is final.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { BigQueryError } from "../domain/errors.js"
import type { Options } from "../options.js"

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

/** The project OpenCode runs in. A folder removed under a running host is a refusal, not an unhandled error. */
function workingDirectory(): string {
  try {
    return process.cwd()
  } catch {
    throw refused("The project folder is not available, so a save path cannot be resolved.", "Restart OpenCode in the project, or pass an absolute path under allowedRoots.")
  }
}

/**
 * A path with every symbolic link resolved: the nearest existing ancestor through `realpath`, and the components below
 * it, which do not exist yet and so cannot be links, appended as written. macOS's `/var` → `/private/var` and `/tmp` →
 * `/private/tmp` are such links, and an agent's shell `pwd` is the logical name, so both sides of every comparison are
 * real paths, never one real and one as typed.
 */
export function realOf(path: string): string {
  const absolute = resolve(path)
  const ancestor = nearestExisting(absolute)
  let real: string
  try {
    real = realpathSync(ancestor)
  } catch {
    throw refused("A folder on the save path cannot be resolved.")
  }
  const rest = relative(ancestor, absolute)
  return rest === "" ? real : resolve(real, rest)
}

/**
 * The target's real path, after every check that can be made before anything is written.
 *
 * The root is chosen by real paths on both sides (the target's, and each root's), so an alias of a root is the root,
 * and a symbolic link inside a root that leads outside every root is refused (`SAVE_PATH_REFUSED`): what is compared is
 * where the bytes would land. The answer is that real path, so OpenCode's `edit` and `external_directory` are asked for
 * the place the file is written, and the write goes there, not through the link.
 */
export function resolveTarget(input: { readonly path: string; readonly overwrite?: boolean }, options: Options, cwd = workingDirectory()): SaveTarget {
  const project = realOf(cwd)
  const roots = [project, realOf(resolve(cwd, options.resultsDir)), ...options.allowedRoots.map((root) => realOf(resolve(cwd, root)))]
  const typed = resolve(cwd, input.path)
  // The file itself must not be a link: the rename would replace it, but a save never writes through one.
  let own: ReturnType<typeof lstatSync> | undefined
  try {
    own = lstatSync(typed)
  } catch {
    own = undefined
  }
  if (own?.isSymbolicLink() === true) throw refused("The save path is a symbolic link, which this tool never writes through.")
  const target = resolve(realOf(dirname(typed)), basename(typed))
  const root = roots.filter((candidate) => inside(target, candidate)).sort((left, right) => right.length - left.length)[0]
  if (root === undefined) {
    throw refused(
      roots.some((candidate) => inside(typed, candidate)) || inside(typed, resolve(cwd))
        ? "The save path resolves outside the project, resultsDir and allowedRoots through a symbolic link."
        : "The save path is outside the project, resultsDir and allowedRoots.",
    )
  }
  if (target === root) throw refused("The save path is a folder, not a file.")
  if (existsSync(target)) {
    if (!lstatSync(target).isFile()) throw refused("The save path exists and is not a regular file.")
    if (input.overwrite !== true) {
      throw new BigQueryError("SAVE_EXISTS", "A file already exists at the save path.", "Choose another path, or pass overwrite: true after the user agrees.")
    }
  }
  return { path: target, external: !inside(target, project) }
}
