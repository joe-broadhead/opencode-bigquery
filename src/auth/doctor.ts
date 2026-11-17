/**
 * `/bigquery-doctor` and the IAM check (design §3, L2).
 *
 * One `projects.list`, one dry run of `SELECT 1`, one `datasets.list` on the billing project, the §3.1 binding check
 * (`auth.level`), and `tables.testIamPermissions` for `bigquery.tables.updateData`, `bigquery.tables.create` and
 * `bigquery.tables.delete` on the first table of each fenced dataset, or with no fence on the first table of each
 * dataset in the billing project (up to 10). Every call is free; none reads data. The IAM check's stated limit: whether
 * the identity may create datasets at project level cannot be checked, because Resource Manager's
 * `projects.testIamPermissions` needs scopes this plugin does not request.
 *
 * Every line is built from fixed text and validated identifiers; Google's error text never reaches it (design §5.6).
 */
import { BigQueryError } from "../domain/errors.js"
import { path } from "../domain/identifiers.js"
import { DISCLOSURE } from "../domain/levels.js"
import type { TableReference } from "../domain/google.js"
import type { Options } from "../options.js"
import type { AuthPort, BigQueryPort } from "../ports.js"
import { hasCloudPlatform } from "./scopes.js"

/** The permissions the read-only recommendation leaves out (design §3). */
export const WRITE_PERMISSIONS: readonly string[] = ["bigquery.tables.updateData", "bigquery.tables.create", "bigquery.tables.delete"]

export type DoctorStatus =
  | "OK"
  | "AUTH_REQUIRED"
  | "AUTH_SCOPE_MISSING"
  | "AUTH_CLIENT_REQUIRED"
  | "ADC_UNAVAILABLE"
  | "ADC_REFUSED"
  | "ACCOUNT_READ_ONLY"
  | "WRITE_LEVEL_UNVERIFIED"
  | "WRITE_LEVEL_UNAVAILABLE"
  | "BILLING_PROJECT_REQUIRED"
  | "API_DISABLED"
  | "PERMISSION_DENIED"
  | "IDENTITY_CAN_WRITE"
  | "UNAVAILABLE"

const STATUSES: ReadonlySet<string> = new Set<DoctorStatus>([
  "OK",
  "AUTH_REQUIRED",
  "AUTH_SCOPE_MISSING",
  "AUTH_CLIENT_REQUIRED",
  "ADC_UNAVAILABLE",
  "ADC_REFUSED",
  "ACCOUNT_READ_ONLY",
  "WRITE_LEVEL_UNVERIFIED",
  "WRITE_LEVEL_UNAVAILABLE",
  "BILLING_PROJECT_REQUIRED",
  "API_DISABLED",
  "PERMISSION_DENIED",
  "IDENTITY_CAN_WRITE",
  "UNAVAILABLE",
])

export interface DoctorAccount {
  readonly alias: string
  readonly status: DoctorStatus
  readonly lines: readonly string[]
}

export interface DoctorReport {
  readonly status: DoctorStatus
  readonly accounts: readonly DoctorAccount[]
  readonly text: string
}

/** What one IAM check found. */
export interface IamReport {
  readonly status: "OK" | "IDENTITY_CAN_WRITE" | DoctorStatus
  /** Each table that grants one of the three, and which permissions it grants. */
  readonly canWrite: readonly { readonly table: TableReference; readonly permissions: readonly string[] }[]
  readonly checked: number
  /** Why the check stopped early, when it did. */
  readonly problem?: string
  /** The stated limit, always shown with a positive answer. */
  readonly limit: string
}

export interface DoctorInput {
  readonly options: Options
  readonly auth: AuthPort
  readonly bigquery: BigQueryPort
  readonly signal: AbortSignal
  readonly now?: () => number
  /** The stored sign-in's device binding, so the disclosure wording matches it (design §3, R3-L2). */
  readonly binding?: (alias: string) => Promise<"bound" | "unbound" | undefined>
}

const LIMIT = "whether this identity may create datasets at project level cannot be checked: that needs Resource Manager scopes this plugin does not request"

/** Runs the doctor over every configured account. */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const accounts: DoctorAccount[] = []
  for (const { alias, mode } of input.auth.accounts()) accounts.push(await oneAccount(alias, mode, input))
  const status = worst(accounts.map((account) => account.status))
  return { status, accounts, text: render(accounts, status) }
}

async function oneAccount(alias: string, mode: string, input: DoctorInput): Promise<DoctorAccount> {
  const lines: string[] = []
  const settings = input.options.accounts?.[alias]
  let status: DoctorStatus = "OK"

  // 1. Who is signed in, and the §3.1 level with both checks.
  try {
    const identity = await input.auth.identity(alias, input.signal)
    if (identity.email) lines.push(`Signed in as ${identity.email}${identity.verified ? "" : " (Google did not confirm the address)"}.`)
    else lines.push("Signed in; the account's email is not known.")
  } catch (error) {
    const code = statusOf(error)
    lines.push(`${code}: ${detailOf(error)}`)
    return { alias, status: code, lines }
  }

  let level: "read" | "write" = "read"
  let levelWhy: string | undefined
  try {
    const decision = await input.auth.level(alias, input.signal)
    level = decision.level
    if (decision.level === "read") {
      levelWhy = decision.why
      if (decision.refusal === "WRITE_LEVEL_UNVERIFIED" || decision.refusal === "WRITE_LEVEL_UNAVAILABLE") status = decision.refusal
    }
    lines.push(level === "write" ? "Level: Read and write (the sign-in record and Google's refresh both carry bigquery.insertdata)." : `Level: Read${levelWhy ? ` (${levelWhy})` : ""}.`)
  } catch (error) {
    const code = statusOf(error)
    lines.push(`${code}: ${detailOf(error)}`)
    return { alias, status: code, lines }
  }

  // 2. A token, which proves the refresh and the local scope check.
  let scopes: readonly string[] = []
  try {
    const token = await input.auth.token(alias, input.signal)
    scopes = token.scopes
  } catch (error) {
    const code = statusOf(error)
    lines.push(`${code}: ${detailOf(error)}`)
    return { alias, status: code, lines }
  }
  if (hasCloudPlatform(scopes)) lines.push("SCOPE_WIDER_THAN_LEVEL: this credential carries cloud-platform, which is wider than BigQuery needs.")

  // 3. The billing project, one projects.list, one dry run and one datasets.list (design §3).
  const project = settings?.billingProject
  if (!project) {
    lines.push("BILLING_PROJECT_REQUIRED: this account has no billingProject; set accounts.<alias>.billingProject.")
    return { alias, status: status === "OK" ? "BILLING_PROJECT_REQUIRED" : status, lines }
  }
  try {
    await input.bigquery.listProjects({ account: alias, maxResults: 1 }, input.signal)
    lines.push(`projects.list answered for the billing project \`${project}\`.`)
  } catch (error) {
    const code = statusOf(error)
    lines.push(`${code}: ${detailOf(error)}`)
    return { alias, status: code, lines }
  }
  try {
    await input.bigquery.dryRun({ account: alias, project, sql: "SELECT 1" }, input.signal)
    lines.push("A dry run of SELECT 1 answered, so jobs.insert works and the bigquery scope is granted.")
  } catch (error) {
    const code = statusOf(error)
    lines.push(`${code}: ${detailOf(error)}`)
    return { alias, status: code, lines }
  }

  let datasets: { projectId: string; datasetId: string }[] = []
  try {
    const answer = await input.bigquery.listDatasets({ account: alias, project, maxResults: 10 }, input.signal)
    datasets = answer.items.map((item) => ({ projectId: item.ref.projectId, datasetId: item.ref.datasetId }))
    lines.push(`datasets.list answered: ${datasets.length} dataset${datasets.length === 1 ? "" : "s"} sampled.`)
  } catch (error) {
    const code = statusOf(error)
    lines.push(`${code}: ${detailOf(error)}`)
    return { alias, status: code, lines }
  }

  // 4. The IAM check (L2).
  const iam = await iamCheck({ alias, billingProject: project, options: input.options, bigquery: input.bigquery, signal: input.signal, ...(datasets.length > 0 ? { datasets } : {}) })
  lines.push(...iamLines(iam))
  if (iam.status === "IDENTITY_CAN_WRITE") status = "IDENTITY_CAN_WRITE"
  else if (iam.status !== "OK" && status === "OK") status = iam.status

  // 5. The disclosure for a Read sign-in (design §3), in the wording the stored binding selects.
  if (mode === "interactive" && level === "read") {
    const binding = input.binding ? await input.binding(alias).catch(() => undefined) : undefined
    lines.push(`Disclosure: ${binding === "unbound" ? DISCLOSURE.unbound : DISCLOSURE.bound}`)
  }

  return { alias, status, lines }
}

/**
 * The IAM check on its own, exposed for status (`bigquery_status({ include: ["iam"] })`, F's handler). It samples the
 * first table of each fenced dataset, or with no fence the first table of each dataset in the billing project, up to 10.
 */
export async function iamCheck(input: {
  readonly alias: string
  readonly billingProject: string
  readonly options: Options
  readonly bigquery: BigQueryPort
  readonly signal: AbortSignal
  /** A datasets.list answer already in hand; when absent, one is made. */
  readonly datasets?: readonly { readonly projectId: string; readonly datasetId: string }[]
}): Promise<IamReport> {
  const settings = input.options.accounts?.[input.alias]
  const fence = settings?.datasets
  const allow = fence?.allow ?? []
  let datasets = input.datasets
  let problem: string | undefined
  // A wildcard allow, or no allow at all, is matched against what the project lists; a concrete allow names its dataset.
  if (!datasets && (allow.length === 0 || allow.some((pattern) => pattern.includes("*")))) {
    try {
      datasets = (await input.bigquery.listDatasets({ account: input.alias, project: input.billingProject, maxResults: 10 }, input.signal)).items.map((item) => ({ projectId: item.ref.projectId, datasetId: item.ref.datasetId }))
    } catch (error) {
      return { status: statusOf(error), canWrite: [], checked: 0, problem: detailOf(error), limit: LIMIT }
    }
  }
  const targets = iamTargets(datasets ?? [], fence)
  const canWrite: { table: TableReference; permissions: readonly string[] }[] = []
  let checked = 0
  for (const dataset of targets) {
    let table: TableReference | undefined
    try {
      const tables = await input.bigquery.listTables({ account: input.alias, dataset, maxResults: 1 }, input.signal)
      table = tables.items[0]?.tableReference
    } catch (error) {
      problem ??= `${statusOf(error)} listing a table of ${path(dataset.projectId, dataset.datasetId)}: ${detailOf(error)}`
      continue
    }
    if (!table) continue
    checked += 1
    try {
      const granted = await input.bigquery.testTablePermissions(input.alias, table, WRITE_PERMISSIONS, input.signal)
      const hits = granted.filter((permission) => WRITE_PERMISSIONS.includes(permission))
      if (hits.length > 0) canWrite.push({ table, permissions: hits })
    } catch (error) {
      problem ??= `${statusOf(error)} checking ${path(table.projectId, table.datasetId, table.tableId)}: ${detailOf(error)}`
    }
  }
  return { status: canWrite.length > 0 ? "IDENTITY_CAN_WRITE" : problem ? statusFromProblem(problem) : "OK", canWrite, checked, ...(problem !== undefined ? { problem } : {}), limit: LIMIT }
}

function iamLines(report: IamReport): string[] {
  const lines: string[] = []
  if (report.checked === 0) {
    lines.push("IAM: no table was available to check; the fence excludes every sampled dataset, or the sampled datasets have no tables.")
  } else {
    lines.push(`IAM: tables.testIamPermissions answered for ${report.checked} table${report.checked === 1 ? "" : "s"}.`)
  }
  if (report.canWrite.length > 0) {
    for (const hit of report.canWrite) lines.push(`IDENTITY_CAN_WRITE: ${path(hit.table.projectId, hit.table.datasetId, hit.table.tableId)} grants ${hit.permissions.join(", ")}.`)
    lines.push(`IDENTITY_CAN_WRITE is the plugin's warning, not a Google refusal; outside this plugin only IAM stops the identity writing. Its limit: ${report.limit}.`)
  } else if (report.status === "OK") {
    lines.push("No sampled table grants bigquery.tables.updateData, create or delete.")
  }
  if (report.problem && report.status !== "OK") lines.push(`The IAM check stopped: ${report.problem} (${report.limit}).`)
  return lines
}

interface DatasetRef {
  readonly projectId: string
  readonly datasetId: string
}

/**
 * The datasets the IAM check may sample, up to 10 (review L-3). Every allow pattern contributes its concrete dataset, or
 * the listed datasets it matches when it has a wildcard; with no allow list the billing project's datasets are sampled.
 * A dataset any deny pattern matches is dropped before anything is listed, so the check never names a fenced-out
 * dataset. Deny wins, as §14.1 says.
 */
function iamTargets(datasets: readonly DatasetRef[], fence: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } | undefined): readonly DatasetRef[] {
  const allow = fence?.allow ?? []
  const deny = fence?.deny ?? []
  const candidates: DatasetRef[] = []
  if (allow.length === 0) candidates.push(...datasets)
  else {
    for (const pattern of allow) {
      const exact = concreteDataset(pattern)
      if (exact) candidates.push(exact)
      else for (const dataset of datasets) if (matchesDataset(pattern, dataset)) candidates.push(dataset)
    }
  }
  const unique = candidates.filter((candidate, index) => candidates.findIndex((other) => sameDataset(other, candidate)) === index)
  return unique.filter((dataset) => !deny.some((pattern) => matchesDataset(pattern, dataset))).slice(0, 10)
}

function sameDataset(left: DatasetRef, right: DatasetRef): boolean {
  return left.projectId === right.projectId && left.datasetId === right.datasetId
}

/** `proj.dataset` without a wildcard; the dataset follows the last dot, so a domain-scoped project id keeps its dots. */
function concreteDataset(pattern: string): DatasetRef | undefined {
  if (pattern.includes("*")) return undefined
  const dot = pattern.lastIndexOf(".")
  if (dot <= 0 || dot === pattern.length - 1) return undefined
  return { projectId: pattern.slice(0, dot), datasetId: pattern.slice(dot + 1) }
}

/** The fence's pattern language: `proj.dataset`, `proj.*`, `*.sales_*`; case-sensitive, like the fence. */
function matchesDataset(pattern: string, dataset: DatasetRef): boolean {
  const dot = pattern.lastIndexOf(".")
  if (dot <= 0 || dot === pattern.length - 1) return false
  return wildcard(pattern.slice(0, dot), dataset.projectId) && wildcard(pattern.slice(dot + 1), dataset.datasetId)
}

function wildcard(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${source}$`).test(value)
}

function statusFromProblem(problem: string): DoctorStatus {
  const code = problem.split(":")[0]!
  return STATUSES.has(code) ? (code as DoctorStatus) : "OK"
}

function statusOf(error: unknown): DoctorStatus {
  if (!(error instanceof BigQueryError)) return "UNAVAILABLE"
  return STATUSES.has(error.code) ? (error.code as DoctorStatus) : error.code === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "UNAVAILABLE"
}

function detailOf(error: unknown): string {
  return error instanceof BigQueryError ? `${error.detail} Next step: ${error.next}` : "the call failed"
}

/** The worst status, for the report's one-line verdict. */
function worst(statuses: readonly DoctorStatus[]): DoctorStatus {
  const order: readonly DoctorStatus[] = [
    "AUTH_REQUIRED",
    "AUTH_CLIENT_REQUIRED",
    "AUTH_SCOPE_MISSING",
    "ADC_REFUSED",
    "ADC_UNAVAILABLE",
    "BILLING_PROJECT_REQUIRED",
    "API_DISABLED",
    "PERMISSION_DENIED",
    "UNAVAILABLE",
    "WRITE_LEVEL_UNVERIFIED",
    "WRITE_LEVEL_UNAVAILABLE",
    "IDENTITY_CAN_WRITE",
    "ACCOUNT_READ_ONLY",
    "OK",
  ]
  for (const status of order) if (statuses.includes(status)) return status
  return "OK"
}

function render(accounts: readonly DoctorAccount[], status: DoctorStatus): string {
  const lines = ["BigQuery doctor", `${status}`]
  for (const account of accounts) {
    lines.push(`${account.alias} — ${account.status}`)
    for (const line of account.lines) lines.push(`  ${line}`)
  }
  return lines.join("\n")
}
