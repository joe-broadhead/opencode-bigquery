/**
 * A small, pure-TypeScript Parquet writer for `bigquery_save`'s `parquet` format, which opencode-charts' reader
 * (`hyparquet`) reads like any other Parquet file (design §7, §14.1):
 *
 * - one plain-encoded, uncompressed DataPage v1 per column chunk;
 * - OPTIONAL columns with definition levels, so SQL NULL is a real null;
 * - BOOLEAN, INT32, INT64, DOUBLE and BYTE_ARRAY (UTF-8) physical types;
 * - Thrift's compact protocol for the file metadata, as the format requires
 *   (https://github.com/apache/parquet-format/blob/master/README.md, `FileMetaData`, `PageHeader`, `ColumnMetaData`).
 *
 * Nested values are written as JSON strings, as the design says for v0.1.0; they are BYTE_ARRAY columns. The writer
 * streams: one row group (20,000 rows) is buffered and written before the next, so a million-row save does not hold the
 * result in memory.
 */

/** One column of the file: its name and the physical type its values are written as. */
export interface ParquetColumn {
  readonly name: string
  readonly type: "BOOLEAN" | "INT32" | "INT64" | "DOUBLE" | "BYTE_ARRAY"
}

/** A cell as the writer takes it; null is a Parquet null through the definition level. */
export type ParquetCell = string | number | boolean | null

const ROW_GROUP_ROWS = 20_000
const MAGIC = "PAR1"

// ── Thrift compact protocol ──────────────────────────────────────────────

const T = { true: 1, false: 2, byte: 3, i16: 4, i32: 5, i64: 6, double: 7, binary: 8, list: 9, struct: 12 } as const

class Bytes {
  private readonly parts: number[] = []
  get length(): number {
    return this.parts.length
  }
  byte(value: number): this {
    this.parts.push(value & 0xff)
    return this
  }
  bytes(value: Uint8Array): this {
    for (const item of value) this.parts.push(item)
    return this
  }
  varint(value: number | bigint): this {
    let current = BigInt(value)
    while (current >= 0x80n) {
      this.parts.push(Number(current & 0x7fn) | 0x80)
      current >>= 7n
    }
    this.parts.push(Number(current))
    return this
  }
  zigzag(value: number | bigint): this {
    const current = BigInt(value)
    return this.varint((current << 1n) ^ (current >> 63n))
  }
  toBytes(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

interface Field {
  readonly id: number
  readonly type: number
  readonly value: number | bigint | boolean | string | Uint8Array | readonly Field[] | readonly (number | string | StructValue)[] | StructValue
}
interface StructValue {
  readonly fields: readonly Field[]
}

const i32 = (id: number, value: number): Field => ({ id, type: T.i32, value })
const i64 = (id: number, value: number): Field => ({ id, type: T.i64, value })
const binary = (id: number, value: string | Uint8Array): Field => ({ id, type: T.binary, value })
const struct = (id: number, value: StructValue): Field => ({ id, type: T.struct, value })
const listShape = new WeakMap<Field, number>()
const listOf = (id: number, type: number, values: readonly (number | string | StructValue)[]): Field => {
  const field: Field = { id, type: T.list, value: values }
  listShape.set(field, type)
  return field
}

function writeField(out: Bytes, field: Field, last: number): number {
  const delta = field.id - last
  if (delta > 0 && delta <= 15) out.byte((delta << 4) | field.type)
  else {
    out.byte(field.type)
    out.zigzag(field.id)
  }
  switch (field.type) {
    case T.true:
    case T.false:
      break
    case T.byte:
      out.byte(Number(field.value))
      break
    case T.i16:
    case T.i32:
      out.zigzag(field.value as number)
      break
    case T.i64:
      out.zigzag(BigInt(field.value as number))
      break
    case T.double: {
      const buffer = new ArrayBuffer(8)
      new DataView(buffer).setFloat64(0, Number(field.value), true)
      out.bytes(new Uint8Array(buffer))
      break
    }
    case T.binary: {
      const bytes = typeof field.value === "string" ? new TextEncoder().encode(field.value) : (field.value as Uint8Array)
      out.varint(bytes.length)
      out.bytes(bytes)
      break
    }
    case T.struct: {
      const value = field.value as StructValue
      let previous = 0
      for (const child of value.fields) previous = writeField(out, child, previous)
      out.byte(0)
      break
    }
    case T.list: {
      const values = field.value as readonly (number | string | StructValue)[]
      const kind = listShape.get(field) ?? (typeof values[0] === "string" ? T.binary : T.struct)
      if (values.length <= 14) out.byte((values.length << 4) | kind)
      else {
        out.byte(0xf0 | kind)
        out.varint(values.length)
      }
      for (const value of values) {
        if (kind === T.i32) out.zigzag(Number(value))
        else if (kind === T.i64) out.zigzag(BigInt(value as number))
        else if (kind === T.binary) {
          const bytes = new TextEncoder().encode(String(value))
          out.varint(bytes.length)
          out.bytes(bytes)
        } else {
          let previous = 0
          for (const child of (value as StructValue).fields) previous = writeField(out, child, previous)
          out.byte(0)
        }
      }
      break
    }
  }
  return field.id
}

const structBytes = (value: StructValue): Uint8Array => {
  const out = new Bytes()
  let previous = 0
  for (const field of value.fields) previous = writeField(out, field, previous)
  out.byte(0)
  return out.toBytes()
}

// ── pages ────────────────────────────────────────────────────────────────

const PLAIN = 0
const RLE = 3
const DATA_PAGE = 0

const typeCode = (type: ParquetColumn["type"]): number => (type === "BOOLEAN" ? 0 : type === "INT32" ? 1 : type === "INT64" ? 2 : type === "DOUBLE" ? 5 : 6)

function plainValues(type: ParquetColumn["type"], values: readonly ParquetCell[]): Uint8Array {
  const out = new Bytes()
  if (type === "BOOLEAN") {
    let byte = 0
    let shift = 0
    for (const value of values) {
      if (value === true) byte |= 1 << shift
      shift += 1
      if (shift === 8) {
        out.byte(byte)
        byte = 0
        shift = 0
      }
    }
    if (shift > 0) out.byte(byte)
    return out.toBytes()
  }
  const view = new DataView(new ArrayBuffer(8))
  for (const value of values) {
    if (type === "INT32") {
      view.setInt32(0, Number(value), true)
      out.bytes(new Uint8Array(view.buffer.slice(0, 4)))
    } else if (type === "INT64") {
      view.setBigInt64(0, BigInt(typeof value === "string" ? value : Number(value)), true)
      out.bytes(new Uint8Array(view.buffer.slice(0, 8)))
    } else if (type === "DOUBLE") {
      view.setFloat64(0, Number(value), true)
      out.bytes(new Uint8Array(view.buffer.slice(0, 8)))
    } else {
      const bytes = new TextEncoder().encode(String(value))
      // Parquet's BYTE_ARRAY length is a 4-byte little-endian unsigned int, not a compact varint.
      const prefix = new Uint8Array(4)
      new DataView(prefix.buffer).setUint32(0, bytes.length, true)
      out.bytes(prefix).bytes(bytes)
    }
  }
  return out.toBytes()
}

/** The definition levels for an OPTIONAL column: the RLE/bit-packed hybrid with bit width 1, always bit-packed. */
function definitionLevels(values: readonly ParquetCell[]): Uint8Array {
  const count = values.length
  const groups = Math.ceil(count / 8)
  const packed = new Uint8Array(groups)
  for (let index = 0; index < count; index++) if (values[index] !== null) packed[index >> 3]! |= 1 << (index & 7)
  const header = new Bytes().varint((groups << 1) | 1).toBytes()
  const total = header.length + packed.length
  const prefix = new Uint8Array(4)
  new DataView(prefix.buffer).setUint32(0, total, true)
  return new Uint8Array([...prefix, ...header, ...packed])
}

function pageHeader(numValues: number, uncompressed: number, compressed: number): Uint8Array {
  return structBytes({
    fields: [
      i32(1, DATA_PAGE),
      i32(2, uncompressed),
      i32(3, compressed),
      struct(5, { fields: [i32(1, numValues), i32(2, PLAIN), i32(3, RLE), i32(4, RLE)] }),
    ],
  })
}

interface RowGroup {
  readonly rows: number
  readonly columns: readonly { readonly name: string; readonly type: ParquetColumn["type"]; readonly offset: number; readonly size: number; readonly values: number }[]
  readonly size: number
}

/** A Parquet file written as row groups arrive: `write` buffers one group, `finish` writes the footer. */
export class ParquetWriter {
  private readonly sink: (bytes: Uint8Array) => void
  private readonly columns: ParquetColumn[]
  private readonly groups: RowGroup[] = []
  private buffered: ParquetCell[][] = []
  private bufferedRows = 0
  private offset = 4
  private rows = 0

  constructor(sink: (bytes: Uint8Array) => void, columns: readonly ParquetColumn[]) {
    this.sink = sink
    this.columns = columns.map((column) => ({ ...column }))
    this.sink(new TextEncoder().encode(MAGIC))
  }

  get rowCount(): number {
    return this.rows
  }

  write(rows: readonly (readonly ParquetCell[])[]): void {
    for (const row of rows) {
      this.buffered.push(this.columns.map((_, index) => row[index] ?? null))
      this.bufferedRows += 1
      this.rows += 1
      if (this.bufferedRows >= ROW_GROUP_ROWS) this.flush()
    }
  }

  private flush(): void {
    if (this.bufferedRows === 0) return
    const groupOffset = this.offset
    const written: { name: string; type: ParquetColumn["type"]; offset: number; size: number; values: number }[] = []
    for (let index = 0; index < this.columns.length; index++) {
      const column = this.columns[index]!
      const values = this.buffered.map((row) => row[index]!)
      const present = values.filter((value) => value !== null)
      const levels = definitionLevels(values)
      const body = plainValues(column.type, present)
      const data = new Uint8Array(levels.length + body.length)
      data.set(levels, 0)
      data.set(body, levels.length)
      const header = pageHeader(values.length, data.length, data.length)
      const page = new Uint8Array(header.length + data.length)
      page.set(header, 0)
      page.set(data, header.length)
      written.push({ name: column.name, type: column.type, offset: this.offset, size: page.length, values: values.length })
      this.offset += page.length
      this.sink(page)
    }
    this.groups.push({ rows: this.bufferedRows, columns: written, size: this.offset - groupOffset })
    this.buffered = []
    this.bufferedRows = 0
  }

  /** The footer, its length and the closing magic. */
  finish(): void {
    this.flush()
    const schema: StructValue[] = [
      { fields: [binary(4, "root"), i32(5, this.columns.length)] },
      ...this.columns.map((column) => ({ fields: [i32(1, typeCode(column.type)), i32(3, 1), binary(4, column.name)] })),
    ]
    const file: StructValue = {
      fields: [
        i32(1, 1),
        listOf(2, T.struct, schema),
        i64(3, this.rows),
        listOf(
          4,
          T.struct,
          this.groups.map((group) => ({
            fields: [
              listOf(
                1,
                T.struct,
                group.columns.map((column) => ({
                  fields: [
                    i64(2, column.offset),
                    struct(3, {
                      fields: [
                        i32(1, typeCode(column.type)),
                        listOf(2, T.i32, [PLAIN, RLE]),
                        listOf(3, T.binary, [column.name]),
                        i32(4, 0),
                        i64(5, column.values),
                        i64(6, column.size),
                        i64(7, column.size),
                        i64(9, column.offset),
                      ],
                    }),
                  ],
                })),
              ),
              i64(2, group.size),
              i64(3, group.rows),
            ],
          })),
        ),
        binary(6, "bigquery-plugin"),
      ],
    }
    const footer = structBytes(file)
    this.sink(footer)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, footer.length, true)
    this.sink(length)
    this.sink(new TextEncoder().encode(MAGIC))
  }
}
