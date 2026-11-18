/**
 * Package E's files (design §7, §14.1): `bigquery_save`'s path rules, its CSV, JSONL and Parquet writers, and the
 * streaming save that renames the finished file into place.
 */
export { assertEdit, resolveTarget, type SaveFormat, type SaveTarget } from "./paths.js"
export { FileWriter, SAVE_PAGE_ROWS, type SaveLimits, type Written } from "./save.js"
export { convertRows, convertValue, valueOf } from "./values.js"
export { ParquetWriter } from "./parquet.js"
