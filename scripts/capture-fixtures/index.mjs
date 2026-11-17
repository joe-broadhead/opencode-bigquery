#!/usr/bin/env node
// Captures the fixture set of design §14.2 from a scratch Google Cloud project, sanitises it, and writes it to
// test/fixtures/google/ (one file per call, the same shape `test/fake/bigquery.ts` replays).
//
// It never runs in a test: it needs network, a real project and an access token, and it refuses to start when the
// environment says it is under a test runner or the explicit BQ_CAPTURE=1 switch is absent.
//
//   BQ_CAPTURE=1 BQ_CAPTURE_PROJECT=my-scratch-project BQ_CAPTURE_TOKEN="$(gcloud auth print-access-token)" \
//     node scripts/capture-fixtures/index.mjs --location EU
//
// Resources for the cases that need them (live check L4, L6, L7, L13) are named with flags:
//   --tagged-table project.dataset.table     a table with a policy-tagged column
//   --rls-table project.dataset.table        a table with a row access policy
//   --external-table project.dataset.table   a GCS external table
//   --view project.dataset.view              a view over another dataset
//   --python-routine project.dataset.routine a Python UDF
//   --remote-routine project.dataset.routine a remote function
//
// Every id in the answer is replaced with an invented one, and any email or token with a placeholder. `--dry-run`
// lists the calls instead of making them. Existing files are kept unless --force is given.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BASE = "https://bigquery.googleapis.com/bigquery/v2"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..")

if (process.env.VITEST || process.env.NODE_ENV === "test" || process.env.NODE_ENV === "testing") {
  console.error("capture-fixtures: refusing to run under a test runner; this script talks to Google.")
  process.exit(2)
}
const args = parse(process.argv.slice(2))
const project = args.project ?? process.env.BQ_CAPTURE_PROJECT
const token = args.token ?? process.env.BQ_CAPTURE_TOKEN
const location = args.location ?? process.env.BQ_CAPTURE_LOCATION ?? "EU"
if (process.env.BQ_CAPTURE !== "1") {
  console.error("capture-fixtures: set BQ_CAPTURE=1 to confirm this is a deliberate live capture.")
  process.exit(2)
}
if (!project || (!token && !args["dry-run"])) {
  console.error("capture-fixtures: BQ_CAPTURE_PROJECT and BQ_CAPTURE_TOKEN are required (or --dry-run).")
  process.exit(2)
}

const out = join(ROOT, args.out ?? "test/fixtures/google")
// Real dataset, table and routine names from the flags become invented ones, longest first, so a message that names
// them is sanitised too.
function realNames() {
  const names = new Map()
  for (const flag of ["tagged-table", "rls-table", "external-table", "view", "python-routine", "remote-routine"]) {
    const value = args[flag]
    if (!value) continue
    for (const [index, part] of value.split(".").slice(1).entries()) {
      if (part === "") continue
      if (!names.has(part)) names.set(part, `${index === 0 ? "invented_dataset" : "invented_object"}_${names.size + 1}`)
    }
  }
  return [...names.entries()].sort((left, right) => right[0].length - left[0].length).map(([real, invented]) => [new RegExp(escape(real), "g"), invented])
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const dataset = (value) => value.split(".").slice(1, 2)[0]
const table = (value) => value.split(".").slice(2).join(".")

const calls = plan()
if (args["dry-run"]) {
  for (const call of calls) console.log(`${call.name}: ${call.request.method} ${call.request.path}`)
  process.exit(0)
}

let failures = 0
for (const call of calls) {
  const file = join(out, `${call.name}.json`)
  if (!args.force && existsSync(file)) {
    console.warn(`capture-fixtures: ${file} exists; keeping it (--force replaces it)`)
    continue
  }
  const response = await send(call.request)
  writeFileSync(file, `${JSON.stringify(sanitise({ request: call.request, response }, project), null, 2)}\n`)
  console.log(`capture-fixtures: wrote ${file} (${response.status})`)
  if (response.status >= 400 && call.expectOk !== false) failures += 1
}
if (failures > 0) {
  console.error(`capture-fixtures: ${failures} call(s) failed; read the files, then adjust the flags.`)
  process.exitCode = 1
}

function plan() {
  const t = args["tagged-table"] ?? `${project}.invented_dataset.invented_tagged_table`
  const rls = args["rls-table"] ?? `${project}.invented_dataset.invented_rls_table`
  const external = args["external-table"] ?? `${project}.invented_dataset.invented_external_table`
  const view = args["view"] ?? `${project}.invented_dataset.invented_view`
  const python = args["python-routine"] ?? `${project}.invented_dataset.invented_python`
  const remote = args["remote-routine"] ?? `${project}.invented_dataset.invented_remote`
  const dry = (name, sql, extra = {}) => ({
    name,
    request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: true, body: insertBody(project, sql, location, true, extra) },
  })
  return [
    { name: "projects-list", request: { method: "GET", path: "/projects" } },
    { name: "datasets-list", request: { method: "GET", path: `/projects/${project}/datasets` } },
    { name: "tables-list", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables` } },
    { name: "table-get", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables/${table(t)}` } },
    { name: "table-data", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables/${table(t)}/data`, query: { maxResults: "2" } } },
    { name: "routines-list", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/routines` } },
    { name: "row-access-policies", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(rls)}/tables/${table(rls)}/rowAccessPolicies` } },
    { name: "test-iam-permissions", request: { method: "POST", path: `/projects/${project}/datasets/${dataset(t)}/tables/${table(t)}/testIamPermissions`, body: { permissions: ["bigquery.tables.updateData", "bigquery.tables.create", "bigquery.tables.delete"] } } },
    dry("dry-run-select", `SELECT * FROM \`${t}\` LIMIT 1`),
    dry("dry-run-insert", `INSERT INTO \`${t}\` (id) VALUES (1)`, { opening: true }),
    dry("dry-run-script", `SELECT 1; SELECT 2`),
    dry("dry-run-create-temp", `CREATE TEMP TABLE tmp AS SELECT 1 AS x; SELECT * FROM tmp`),
    dry("dry-run-rls", `SELECT * FROM \`${rls}\``, { opening: true }),
    dry("dry-run-external", `SELECT * FROM \`${external}\``, { opening: true }),
    dry("dry-run-view", `SELECT * FROM \`${view}\``),
    dry("dry-run-python", `SELECT \`${python}\`(1)`, { opening: true }),
    dry("dry-run-remote", `SELECT * FROM \`${remote}\`(1)`, { opening: true }),
    dry("dry-run-tagged", `SELECT * FROM \`${t}\``, { opening: true }),
    dry("error-invalid-query", "SELECT FROM"),
    { name: "error-not-found", request: { method: "GET", path: `/projects/${project}/datasets/${dataset(t)}/tables/invented_missing` } },
    { name: "job-running", request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: false, body: insertBody(project, "SELECT 1", location, false, { jobId: "oc_00000000-0000-4000-8000-0000000000ff" }) } },
    { name: "error-duplicate", request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: false, body: insertBody(project, "SELECT 1", location, false, { jobId: "oc_00000000-0000-4000-8000-0000000000ff" }) } },
    { name: "job-bytes-billed", request: { method: "POST", path: `/projects/${project}/jobs`, dryRun: false, body: insertBody(project, `SELECT * FROM \`${t}\``, location, false, { maximumBytesBilled: "1", jobId: "oc_00000000-0000-4000-8000-0000000000fe" }) } },
    { name: "results-page", request: { method: "GET", path: `/projects/${project}/queries/oc_00000000-0000-4000-8000-0000000000ff`, query: { maxResults: "51", timeoutMs: "30000", location } }, expectOk: false },
  ]
}

function insertBody(projectId, sql, where, dry, extra = {}) {
  return {
    jobReference: { projectId, ...(extra.jobId ? { jobId: extra.jobId } : {}), location: where },
    configuration: {
      query: { query: sql, useLegacySql: false, ...(extra.maximumBytesBilled ? { maximumBytesBilled: extra.maximumBytesBilled } : {}) },
      dryRun: dry,
      ...(dry ? {} : { jobTimeoutMs: "600000", labels: { oc_plugin: "livecheck" } }),
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

/** Every id, address and token replaced, so the recording can be committed. */
function sanitise(record, projectId) {
  const replacements = [
    ...realNames(),
    [new RegExp(escape(projectId), "g"), "invented-project"],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "ada@example.invalid"],
    [/Bearer [A-Za-z0-9._-]+/g, "Bearer invented-access-token"],
    [/ya29\.[A-Za-z0-9._-]+/g, "invented-access-token"],
    [/\b\d{12}\b/g, "000000000000"],
    [new RegExp(escape(process.env.BQ_CAPTURE_TOKEN ?? ""), "g"), "invented-access-token"],
  ].filter(([pattern]) => String(pattern) !== "/(?:)/g")
  const walk = (value) => {
    if (typeof value === "string") return replacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    return value
  }
  return walk(record)
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

