/**
 * SQL fragments the guards build themselves, from names that came out of BigQuery (a schema's columns, a table's
 * reference). Those names are data: every one is escaped exactly as GoogleSQL reads it, so a name can never end a
 * literal or an identifier early. They reach a `message` only through `src/domain/identifiers.ts`.
 */
import type { TableReference } from "../domain/google.js"

/** A path or column, backquoted with its own backquotes and backslashes escaped. */
export function quoteIdent(name: string): string {
  return `\`${name.replace(/[\\`]/g, (char) => `\\${char}`)}\``
}

/** A string literal, single-quoted with its own quotes and backslashes escaped. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/[\\']/g, (char) => `\\${char}`)}'`
}

/** `\`project\`.\`dataset\`.\`table\`` */
export function tableSql(ref: TableReference): string {
  return `${quoteIdent(ref.projectId)}.${quoteIdent(ref.datasetId)}.${quoteIdent(ref.tableId)}`
}

/** `\`project\`.\`dataset\`.INFORMATION_SCHEMA.<view>` */
export function informationSchemaSql(project: string, dataset: string, view: string): string {
  return `${quoteIdent(project)}.${quoteIdent(dataset)}.INFORMATION_SCHEMA.${view}`
}
