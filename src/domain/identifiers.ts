/**
 * Validated identifiers: the only data a `message`, a `next` or a hint may carry (design §5.6). A project, dataset,
 * table or routine name is backquoted, its backquotes and backslashes escaped, and cut to 64 characters; a column name
 * outside `[A-Za-z0-9_]` (flexible column names allow any Unicode up to 300 characters) is shown as `column #n`.
 * Everything else from Google or the data stays out of those fields.
 */

const MAX = 64
const PLAIN = /^[A-Za-z0-9_]+$/
/** Project ids add `-`, `.` and `:`; dataset and table ids are plainer. Anything else is not shown. */
const NAME = /^[A-Za-z0-9_.:-]+$/

/** One path part, backquoted: `` `proj` ``, `` `ds` ``, `` `t` ``. A part with any other character is `object`. */
export function ident(part: string): string {
  if (!NAME.test(part)) return "`object`"
  const escaped = part.replace(/[\\`]/g, (char) => `\\${char}`)
  const cut = escaped.length > MAX ? `${escaped.slice(0, MAX - 1)}…` : escaped
  return `\`${cut}\``
}

/** A dotted path, each part validated: `` `proj`.`ds`.`t` ``. */
export function path(...parts: readonly string[]): string {
  return parts.map(ident).join(".")
}

/** A column for a message: its name when plain, otherwise its 1-based position. */
export function column(name: string, position: number): string {
  return PLAIN.test(name) && name.length <= MAX ? `\`${name}\`` : `column #${position}`
}
