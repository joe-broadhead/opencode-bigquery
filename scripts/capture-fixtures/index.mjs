#!/usr/bin/env node
// Captures the fixture set of design §14.2 from a scratch Google Cloud project, sanitises it, and writes it to
// test/fixtures/google/ (one file per call, the same shape `test/fake/bigquery.ts` replays).
//
// It never runs in a test or in CI: it needs network, a real project and an access token, and it refuses to start under
// a test runner, under CI, or without the explicit BQ_CAPTURE=1 switch. The token comes from the environment only, so it
// never appears in a shell history or `ps`:
//
//   BQ_CAPTURE=1 BQ_CAPTURE_PROJECT=my-scratch-project BQ_CAPTURE_TOKEN="$(gcloud auth print-access-token)" \
//     node scripts/capture-fixtures/index.mjs --location EU
//
// Resources for the cases that need them (live check L3, L4, L6, L7, L13) are named with flags:
//   --tagged-table project.dataset.table     a table with a policy-tagged column
//   --rls-table project.dataset.table        a table with a row access policy
//   --external-table project.dataset.table   a GCS external table
//   --view project.dataset.view              a view over another dataset
//   --python-routine project.dataset.routine a Python UDF
//   --remote-routine project.dataset.routine a remote function
//
// Every project, dataset, table, address and token is replaced with an invented one; every result cell and policy tag
// name is replaced too, so the recording carries Google's shapes and no data. `--dry-run` lists the calls. Existing
// files are kept unless --force is given.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BASE = "https://bigquery.googleapis.com/bigquery/v2"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

if (process.env.VITEST || process.env.CI || process.env.NODE_ENV === "test" || process.env.NODE_ENV === "testing") {
  console.error("capture-fixtures: refusing to run under a test runner or CI; this script talks to Google.")
  process.exit(2)
}
const args = parse(process.argv.slice(2))
const project = args.project ?? process.env.BQ_CAPTURE_PROJECT
const token = process.env.BQ_CAPTURE_TOKEN
const location = args.location ?? process.env.BQ_CAPTURE_LOCATION ?? "EU"
if (process.env.BQ_CAPTURE !== "1") {
  console.error("capture-fixtures: set BQ_CAPTURE=1 to confirm this is a deliberate live capture.")
  process.exit(2)
}
if (!project || (!token && !args["dry-run"])) {
  console.error("capture-fixtures: BQ_CAPTURE_PROJECT and BQ_CAPTURE_TOKEN are required (BQ_CAPTURE_TOKEN from the environment only), or --dry-run.")
  process.exit(2)
}

const out = join(ROOT, args.out ?? "test/fixtures/google")

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const dataset = (value) => value.split(".").slice(1, 2)[0]
const table = (value) => value.split(".").slice(2).join(".")

mkdirSync(out, { recursive: true })

const t = args["tagged-table"] ?? `${project}.invented_dataset.invented_tagged_table`
const rls = args["rls-table"] ?? `${project}.invented_dataset.invented_rls_table`
const external = args["external-table"] ?? `${project}.invented_dataset.invented_external_table`
const view = args["view"] ?? `${project}.invented_dataset.invented_view`
const python = args["python-routine"] ?? `${project}.invented_dataset.invented_python`
const remote = args["remote-routine"] ?? `${project}.invented_dataset.invented_remote`

const dry = (name, sql, extra = {}) => ({ name, request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: true, body: insertBody(sql, true, extra) } })
const RUN_JOB = "oc_00000000-0000-4000-8000-0000000000ff"
const CAP_JOB = "oc_00000000-0000-4000-8000-0000000000fe"

const steps = [
  { name: "projects-list", request: { method: "GET", path: "/projects" } },
  { name: "datasets-list", request: { method: "GET", path: `/projects/${project}/datasets` } },
  { name: "tables-list", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables` } },
  { name: "table-get", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables/${table(t)}` } },
  { name: "table-data", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables/${table(t)}/data`, query: { maxResults: "2", "formatOptions.useInt64Timestamp": "true" } } },
  { name: "routines-list", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/routines`, query: { readMask: "routineType,language,remoteFunctionOptions,definitionBody,arguments" } } },
  { name: "routine-get", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/routines/${python.split(".").at(-1)}` } },
  { name: "row-access-policies", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(rls)}/tables/${table(rls)}/rowAccessPolicies`, query: { pageSize: "1000" } } },
  { name: "test-iam-permissions", request: { method: "POST", path: `/projects/${project}/datasets/${dataset(t)}/tables/${table(t)}:testIamPermissions`, body: { permissions: ["bigquery.tables.updateData", "bigquery.tables.create", "bigquery.tables.delete"] } } },
  dry("dry-run-select", `SELECT * FROM \`${t}\` LIMIT 1`),
  dry("dry-run-insert", `INSERT INTO \`${t}\` (id) VALUES (1)`),
  dry("dry-run-script", "SELECT 1; SELECT 2"),
  dry("dry-run-create-temp", "CREATE TEMP TABLE tmp AS SELECT 1 AS x; SELECT * FROM tmp"),
  dry("error-invalid-query", "SELECT FROM"),
  dry("error-permission-denied", `SELECT * FROM \`${rls}\``),
  { name: "job-running", request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: false, body: insertBody("SELECT 1", false, { jobId: RUN_JOB }) } },
  { name: "error-duplicate", request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: false, body: insertBody("SELECT 1", false, { jobId: RUN_JOB }) } },
  { name: "job-done", request: { method: "GET", path: `/projects/${project}/jobs/${RUN_JOB}`, query: { location } } },
  { name: "results-page-1", request: { method: "GET", path: `/projects/${project}/queries/${RUN_JOB}`, query: { maxResults: "51", timeoutMs: "30000", location, "formatOptions.useInt64Timestamp": "true" } } },
  { name: "job-bytes-billed", request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: false, body: insertBody(`SELECT * FROM \`${t}\``, false, { jobId: CAP_JOB, maximumBytesBilled: "1" }) } },
  { name: "job-bytes-billed-get", request: { method: "GET", path: `/projects/${project}/jobs/${CAP_JOB}`, query: { location } } },
  { name: "error-bytes-billed-400", request: { method: "GET", path: `/projects/${project}/queries/${CAP_JOB}`, query: { maxResults: "1", timeoutMs: "1000", location, "formatOptions.useInt64Timestamp": "true" } } },
  { name: "error-not-found", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables/invented_missing` } },
]

if (args["dry-run"]) {
  for (const step of steps) console.log(`${step.name}: ${step.request.method} ${step.request.path}`)
  process.exit(0)
}

let failures = 0
for (const step of steps) {
  const file = join(out, `${step.name}.json`)
  if (!args.force && existsSync(file)) {
    console.warn(`capture-fixtures: ${file} exists; keeping it (--force replaces it)`)
    continue
  }
  const response = await send(step.request)
  writeFileSync(file, `${JSON.stringify(sanitise({ request: step.request, response }, project), null, 2)}\n`)
  console.log(`capture-fixtures: wrote ${file} (${response.status})`)
  if (response.status >= 400 && !["error-duplicate", "error-invalid-query", "error-permission-denied", "error-not-found", "error-bytes-billed-400", "job-bytes-billed", "job-bytes-billed-get"].includes(step.name)) failures += 1
}
if (failures > 0) {
  console.error(`capture-fixtures: ${failures} call(s) failed; read the files, then adjust the flags.`)
  process.exitCode = 1
}

function insertBody(sql, dryRun, extra = {}) {
  return {
    jobReference: { projectId: project, ...(extra.jobId ? { jobId: extra.jobId } : {}), location },
    configuration: {
      query: { query: sql, useLegacySql: false, ...(extra.maximumBytesBilled ? { maximumBytesBilled: extra.maximumBytesBilled } : {}) },
      dryRun,
      ...(dryRun ? {} : { jobTimeoutMs: "600000", labels: { oc_plugin: "livecheck" } }),
    },
  }
}

async function send(request) {
  const url = new URL(`${BASE}${request.path}`)
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value))
  const response = await fetch(url, {
    method: request.method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    redirect: "error",
  })
  const text = await response.text()
  let body
  try {
    body = text === "" ? undefined : JSON.parse(text)
  } catch {
    body = { text: text.slice(0, 500) }
  }
  const headers = {}
  for (const name of ["retry-after", "content-type"]) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  return { status: response.status, ...(Object.keys(headers).length > 0 ? { headers } : {}), ...(body === undefined ? {} : { body }) }
}

/** Every id, address and token replaced, and every cell and policy tag with it, so the recording can be committed. */
function sanitise(record, projectId) {
  const replacements = [
    ...realNames(),
    [new RegExp(escape(projectId), "g"), "invented-project"],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "ada@example.invalid"],
    [/Bearer [A-Za-z0-9._-]+/g, "Bearer invented-access-token"],
    [/ya29\.[A-Za-z0-9._-]+/g, "invented-access-token"],
    [/\b\d{12}\b/g, "000000000000"],
    ...(token ? [[new RegExp(escape(token), "g"), "invented-access-token"]] : []),
  ]
  const walk = (value) => {
    if (typeof value === "string") return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    return value
  }
  return redact(walk(record))
}

/** The result cells and the policy tag names: shapes stay, values go. */
function redact(record) {
  const body = record.response?.body
  if (body !== null && typeof body === "object") {
    if (Array.isArray(body.rows)) {
      const fields = body.schema?.fields ?? []
      body.rows = body.rows.map((row) => ({ f: (row.f ?? []).map((cell, index) => ({ v: inventedCell(fields[index], cell?.v) })) }))
    }
    const fields = body.schema?.fields
    if (Array.isArray(fields)) redactFields(fields)
  }
  return record
}

function redactFields(fields) {
  for (const field of fields) {
    if (field.policyTags?.names) field.policyTags.names = field.policyTags.names.map((_, index) => `projects/invented-project/locations/eu/taxonomies/1/policyTags/${index + 1}`)
    if (Array.isArray(field.fields)) redactFields(field.fields)
  }
}

/** A cell of the field's type, invented: the recording keeps the type, not the data. */
function inventedCell(field, value) {
  if (value === null || value === undefined) return null
  switch (field?.type) {
    case "INT64":
    case "INTEGER":
      return "1"
    case "FLOAT64":
    case "FLOAT":
      return "1.5"
    case "NUMERIC":
    case "BIGNUMERIC":
      return "1.5"
    case "BOOL":
    case "BOOLEAN":
      return "true"
    case "TIMESTAMP":
      return "1700000000123456"
    case "DATE":
      return "2026-01-01"
    case "TIME":
      return "12:00:00"
    case "DATETIME":
      return "2026-01-01T12:00:00"
    case "BYTES":
      return "aW52ZW50ZWQ="
    case "JSON":
      return "{\"invented\":true}"
    case "GEOGRAPHY":
      return "POINT(0 0)"
    case "RANGE":
      return "[2026-01-01, 2026-12-31)"
    case "RECORD":
    case "STRUCT":
      return { f: (field.fields ?? []).map((child) => ({ v: inventedCell(child, child.type === "INT64" ? "1" : "invented") })) }
    default:
      return Array.isArray(value) ? [{ v: "invented" }] : "invented"
  }
}

// Real dataset, table and routine names from the flags become invented ones, longest first, so a message that names
// them is sanitised too.
function realNames() {
  const names = new Map()
  for (const value of [t, rls, external, view, python, remote]) {
    for (const [index, part] of value.split(".").slice(1).entries()) {
      if (part === "") continue
      if (!names.has(part)) names.set(part, `${index === 0 ? "invented_dataset" : "invented_object"}_${names.size + 1}`)
    }
  }
  return [...names.entries()].sort((left, right) => right[0].length - left[0].length).map(([real, invented]) => [new RegExp(escape(real), "g"), invented])
}


function parse(argv) {
  const out = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) continue
    const name = arg.slice(2)
    if (name === "force" || name === "dry-run") out[name] = true
    else out[name] = argv[++index]
  }
  return out
}
