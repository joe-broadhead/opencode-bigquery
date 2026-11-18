// A minimal Parquet reader for package E's tests: enough of the format to prove `src/files/parquet.ts` writes a file
// another reader can read. It follows the format's own structures (Thrift compact protocol for `FileMetaData`,
// `ColumnMetaData` and `PageHeader`, then PLAIN-encoded data pages with definition levels), not the writer's internals.
// https://github.com/apache/parquet-format/blob/master/README.md
//
// It reads what the writer writes and nothing else: PLAIN encoding, UNCOMPRESSED, one data page per column chunk, and
// OPTIONAL columns (one definition level). A file that does not match throws, which is what the test wants.

type Cursor = { at: number; readonly bytes: Uint8Array }
type FieldValue = number | bigint | boolean | string | Uint8Array | FieldValue[] | Struct
interface Struct {
  readonly [id: number]: FieldValue
}

const T = { true: 1, false: 2, byte: 3, i16: 4, i32: 5, i64: 6, double: 7, binary: 8, list: 9, struct: 12 } as const

const u8 = (cursor: Cursor): number => {
  const value = cursor.bytes[cursor.at]
  if (value === undefined) throw new Error("parquet: read past the end")
  cursor.at += 1
  return value
}

const varint = (cursor: Cursor): number => {
  let result = 0
  let shift = 0
  for (;;) {
    const byte = u8(cursor)
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return result
    shift += 7
    if (shift > 53) throw new Error("parquet: varint too long")
  }
}

const zigzag = (cursor: Cursor): number => {
  const raw = varint(cursor)
  return raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2
}

const binary = (cursor: Cursor): Uint8Array => {
  const length = varint(cursor)
  const value = cursor.bytes.subarray(cursor.at, cursor.at + length)
  if (value.length !== length) throw new Error("parquet: binary past the end")
  cursor.at += length
  return value
}

function readStruct(cursor: Cursor): Struct {
  const out: Record<number, FieldValue> = {}
  let last = 0
  for (;;) {
    const header = u8(cursor)
    if (header === 0) return out
    const type = header & 0x0f
    const delta = header >> 4
    const id = delta === 0 ? zigzag(cursor) : last + delta
    last = id
    switch (type) {
      case T.true:
        out[id] = true
        break
      case T.false:
        out[id] = false
        break
      case T.byte:
        out[id] = u8(cursor)
        break
      case T.i16:
      case T.i32:
        out[id] = zigzag(cursor)
        break
      case T.i64:
        out[id] = BigInt(zigzag(cursor))
        break
      case T.double: {
        const view = new DataView(cursor.bytes.buffer, cursor.bytes.byteOffset + cursor.at, 8)
        out[id] = view.getFloat64(0, true)
        cursor.at += 8
        break
      }
      case T.binary:
        out[id] = binary(cursor)
        break
      case T.struct:
        out[id] = readStruct(cursor)
        break
      case T.list: {
        const headerByte = u8(cursor)
        const size = headerByte >> 4
        const itemType = headerByte & 0x0f
        const count = size === 15 ? varint(cursor) : size
        const items: FieldValue[] = []
        for (let index = 0; index < count; index++) {
          if (itemType === T.i32) items.push(zigzag(cursor))
          else if (itemType === T.i64) items.push(BigInt(zigzag(cursor)))
          else if (itemType === T.binary) items.push(binary(cursor))
          else if (itemType === T.struct) items.push(readStruct(cursor))
          else throw new Error(`parquet: list item type ${itemType}`)
        }
        out[id] = items
        break
      }
      default:
        throw new Error(`parquet: field type ${type}`)
    }
  }
}

const number = (value: FieldValue | undefined): number => (typeof value === "bigint" ? Number(value) : typeof value === "number" ? value : Number.NaN)
const bytes = (value: FieldValue | undefined): Uint8Array => (value instanceof Uint8Array ? value : new Uint8Array())

export interface ParquetValue {
  readonly null: boolean
  readonly value?: unknown
}

export interface ParquetColumn {
  readonly name: string
  readonly type: number
  readonly values: readonly ParquetValue[]
}

export interface ParquetFile {
  readonly rows: number
  readonly columns: readonly ParquetColumn[]
}

/** The bit-packed definition levels: the header's `(groups << 1) | 1`, then the packed bytes. */
function bitPacked(levels: Uint8Array): number[] {
  let at = 0
  let header = 0
  let shift = 0
  for (;;) {
    const byte = levels[at++]!
    header += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  if (header % 2 !== 1) throw new Error("parquet: definition levels are not bit-packed")
  const groups = Math.floor(header / 2)
  const packed = levels.subarray(at, at + groups)
  const out: number[] = []
  for (let index = 0; index < groups * 8; index++) out.push((packed[index >> 3]! >> (index & 7)) & 1)
  return out
}

/** The file's rows and columns, read page by page. */
export function readParquet(file: Uint8Array): ParquetFile {
  if (new TextDecoder().decode(file.subarray(0, 4)) !== "PAR1") throw new Error("parquet: no starting magic")
  if (new TextDecoder().decode(file.subarray(file.length - 4)) !== "PAR1") throw new Error("parquet: no closing magic")
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const footerLength = view.getUint32(file.length - 8, true)
  const footerAt = file.length - 8 - footerLength
  const footer = readStruct({ at: footerAt, bytes: file.subarray(0, footerAt + footerLength) })
  const schema = (footer[2] as FieldValue[] | undefined) ?? []
  const rowGroups = (footer[4] as FieldValue[] | undefined) ?? []
  const names = schema.slice(1).map((entry) => {
    const element = entry as Struct
    return { name: new TextDecoder().decode(bytes(element[4])), type: number(element[1]) }
  })
  const columns = names.map((column) => ({ name: column.name, type: column.type, values: [] as ParquetValue[] }))
  for (const group of rowGroups) {
    const chunks = ((group as Struct)[1] as FieldValue[] | undefined) ?? []
    if (chunks.length !== columns.length) throw new Error("parquet: a row group's columns do not match the schema")
    for (const [index, chunk] of chunks.entries()) {
      const meta = (chunk as Struct)[3] as Struct
      const type = number(meta[1])
      const count = number(meta[5])
      const cursor: Cursor = { at: number(meta[9]), bytes: file }
      const pageHeader = readStruct(cursor)
      if (number(pageHeader[1]) !== 0) throw new Error("parquet: not a data page")
      const dataHeader = pageHeader[5] as Struct
      const total = number(dataHeader[1])
      if (total !== count) throw new Error("parquet: the page's value count differs from the column chunk's")
      const pageBytes = number(pageHeader[3])
      const page = file.subarray(cursor.at, cursor.at + pageBytes)
      const levelsLength = new DataView(page.buffer, page.byteOffset, page.byteLength).getUint32(0, true)
      const definition = bitPacked(page.subarray(4, 4 + levelsLength))
      const body = page.subarray(4 + levelsLength)
      const present = definition.slice(0, total).filter((level) => level === 1).length
      let at = 0
      let bit = 0
      for (let row = 0; row < total; row++) {
        if (definition[row] !== 1) {
          columns[index]!.values.push({ null: true })
          continue
        }
        if (type === 0) {
          columns[index]!.values.push({ null: false, value: ((body[bit >> 3]! >> (bit & 7)) & 1) === 1 })
          bit += 1
          continue
        }
        const decoded = plain(type, body, at)
        at = decoded.at
        columns[index]!.values.push({ null: false, value: decoded.value })
      }
      if (type === 0 && bit !== present) throw new Error("parquet: boolean values do not match the definition levels")
    }
  }
  return { rows: number(footer[3]), columns }
}

function plain(type: number, body: Uint8Array, at: number): { value: unknown; at: number } {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  switch (type) {
    case 2: {
      const value = view.getBigInt64(at, true)
      return { value: Number(value), at: at + 8 }
    }
    case 5:
      return { value: view.getFloat64(at, true), at: at + 8 }
    case 6: {
      const length = view.getUint32(at, true)
      return { value: new TextDecoder().decode(body.subarray(at + 4, at + 4 + length)), at: at + 4 + length }
    }
    default:
      throw new Error(`parquet: physical type ${type}`)
  }
}
