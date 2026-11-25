/**
 * The file `save` writes (design §7): CSV, JSONL or Parquet, built row by row from `getQueryResults` pages,
 * with the caps counted as it goes.
 *
 * - the temp file is created beside the target and renamed into place when the save completes; any failure — an
 *   expired result, a refused write, `SAVE_LIMIT` — removes it, so the target's name never holds half a file;
 * - `maxSaveRows` and `maxSaveBytes` are checked before a row is written; the answer says which limit was reached;
 * - sha256 is computed over the bytes as they are written, so the hash names the file that landed;
 * - CSV follows RFC 4180's quoting; JSONL is one object per row, a duplicate column name suffixed `_2`; Parquet is the
 *   bundled writer's plain, uncompressed file, one row group per 20,000 rows.
 */
import { createHash, randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs"
import { dirname } from "node:path"
import { BigQueryError } from "../domain/errors.js"
import type { SchemaField } from "../domain/google.js"
import { ParquetWriter } from "./parquet.js"
import type { SaveFormat } from "./paths.js"
import { csvCell, jsonValue, parquetCell, parquetType } from "./values.js"

/** How many rows one `getQueryResults` page asks for (design §7). */
export const SAVE_PAGE_ROWS = 10_000

export interface SaveLimits {
  readonly maxRows: number
  readonly maxBytes: number
}

export interface Written {
  readonly rows: number
  readonly bytes: number
  readonly sha256: string
}

/** A save over its caps: the partial file is gone by the time the error reaches the caller. */
const limit = (what: string) => new BigQueryError("SAVE_LIMIT", `The result is over ${what}, so the partial file was removed.`, "Narrow the query, or ask the user to raise the save limits.")

/** One save's file: `write` streams rows, `finish` renames it into place, `abort` removes it. */
export class FileWriter {
  private readonly fd: number
  private readonly temp: string
  private readonly target: string
  private readonly format: SaveFormat
  private readonly schema: readonly SchemaField[]
  private readonly names: readonly string[]
  private readonly limits: SaveLimits
  private readonly hash = createHash("sha256")
  private readonly parquet?: ParquetWriter
  private bytes = 0
  private rows = 0
  private done = false

  constructor(target: string, format: SaveFormat, schema: readonly SchemaField[], limits: SaveLimits) {
    this.target = target
    this.format = format
    this.schema = schema
    this.names = uniqueNames(schema.map((field) => field.name))
    this.limits = limits
    mkdirSync(dirname(target), { recursive: true })
    this.temp = `${target}.${randomUUID().slice(0, 8)}.part`
    this.fd = openSync(this.temp, "wx", 0o600)
    if (format === "csv") this.writeChunk(new TextEncoder().encode(`${this.names.map(csvCell).join(",")}\r\n`))
    if (format === "parquet") {
      this.parquet = new ParquetWriter((bytes) => this.writeChunk(bytes), schema.map((field) => ({ name: field.name, type: parquetType(field) })))
    }
  }

  get rowCount(): number {
    return this.rows
  }

  /** Converts and writes rows in the schema's order; a row over `maxSaveRows` or `maxSaveBytes` is `SAVE_LIMIT`. */
  write(pages: readonly (readonly unknown[])[]): void {
    if (this.done) throw new Error("the save is already finished")
    for (const row of pages) {
      if (this.rows >= this.limits.maxRows) throw limit(`maxSaveRows (${this.limits.maxRows})`)
      if (this.parquet !== undefined) {
        this.parquet.write([row.map((value, index) => parquetCell(value, parquetType(this.schema[index])))])
      } else {
        const chunk = this.chunkOf(row)
        if (this.bytes + chunk.length > this.limits.maxBytes) throw limit(`maxSaveBytes (${this.limits.maxBytes})`)
        this.writeChunk(chunk)
      }
      this.rows += 1
    }
  }

  /** Writes the footer and renames the file into place. */
  finish(): Written {
    if (this.done) throw new Error("the save is already finished")
    if (this.parquet !== undefined) this.parquet.finish()
    closeSync(this.fd)
    renameSync(this.temp, this.target)
    this.done = true
    return { rows: this.rows, bytes: this.bytes, sha256: this.hash.digest("hex") }
  }

  /** Removes the partial file and leaves the target alone. */
  abort(): void {
    if (this.done) return
    try {
      closeSync(this.fd)
    } catch {
      // A failed finish may have closed it already.
    }
    try {
      rmSync(this.temp, { force: true })
    } catch {
      // A partial file that cannot be removed is still not the target; the next save uses a new temp name.
    }
    this.done = true
  }

  private chunkOf(row: readonly unknown[]): Uint8Array {
    if (this.format === "csv") {
      const line = this.schema.map((_, index) => csvCell(row[index])).join(",")
      return new TextEncoder().encode(`${line}\r\n`)
    }
    const object: Record<string, unknown> = {}
    for (const [index, name] of this.names.entries()) object[name] = jsonValue(row[index])
    return new TextEncoder().encode(`${JSON.stringify(object)}\n`)
  }

  private writeChunk(chunk: Uint8Array): void {
    if (this.bytes + chunk.length > this.limits.maxBytes) throw limit(`maxSaveBytes (${this.limits.maxBytes})`)
    writeSync(this.fd, chunk)
    this.hash.update(chunk)
    this.bytes += chunk.length
  }
}

/** Column names a JSON object can key on: a repeated name is suffixed `_2`, `_3`, … so no value is lost. */
function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count === 1 ? name : `${name}_${count}`
  })
}
