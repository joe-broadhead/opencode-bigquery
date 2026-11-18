/**
 * Package F: `bigquery_status` (design §13). The tool's own answer is the contract's: the accounts and their levels,
 * the byte caps and what has been billed, plus the warnings and the next step a person needs. `/bigquery-status` and the
 * TUI read the same facts through the status RPC (`src/status.ts`, `src/rpc.ts`), so the three agree.
 *
 * Its only requests are free and none is a query. An interactive account's level is decided from Google's answer to the
 * most recent token refresh of this process (`src/domain/levels.ts`), so the first status in a process refreshes an
 * account's token once: a request to Google's OAuth token endpoint. The checks:
 * - after a Read sign-in, the IAM check once (design §3, review L-4), and again with `include: ["iam"]`;
 * - with `include: ["jobs"]`, this account's running jobs (a free `jobs.list`);
 * - `spend` is accepted because the local ledger is always read; the reconciliation with Google's
 *   `INFORMATION_SCHEMA.JOBS_BY_USER` is not built yet (README, Known limits).
 *
 * Every sentence here is built from codes and validated identifiers (`src/domain/identifiers.ts`), never from Google's
 * text; a `BigQueryError`'s own `detail` and `next` are already built that way by their raise site.
 */
import { iamCheck } from "../auth/doctor.js"
import { takePendingIamCheck } from "../auth/state.js"
import type { OutputOf } from "../domain/contract.js"
import { BigQueryError, errorText } from "../domain/errors.js"
import { ident, path } from "../domain/identifiers.js"
import { DISCLOSURE } from "../domain/levels.js"
import { localDayStart, usdFor, type Warning } from "../guards/cost.js"
import { sessionHash } from "../guards/session.js"
import { accountsOf } from "../options.js"
import type { Handlers } from "../registry.js"

/** One account's row of the result. */
type StatusAccount = NonNullable<OutputOf<"status">["accounts"]>[number]

/** The account settings status reads; the options schema fills every default. */
type Account = { readonly mode?: string; readonly billingProject?: string; readonly location?: string }

/**
 * The device-binding accessor A adds to `AuthPort` (review bigquery-12, contract request 3). Status codes against its
 * shape so the disclosure switches to the stored binding as soon as it lands; until then it answers undefined and the
 * form's pre-binding wording is shown.
 */
type BindingAccessor = { readonly binding?: (account: string, signal: AbortSignal) => Promise<"bound" | "unbound" | undefined> }

const status: Handlers["status"] = async (input, context) => {
  const { options, ports, call } = context
  const settings = accountsOf(options) as Readonly<Record<string, Account>>
  const aliases = Object.keys(settings)
  const reported = context.account === "*" ? aliases : [context.account]
  const warn: Warning[] = []
  let next: string | undefined
  /** Keeps the first next step: an account that cannot get a token is the one to fix first. */
  const note = (sentence: string | undefined) => {
    if (sentence !== undefined && next === undefined) next = sentence
  }

  // ── The accounts and their levels ──────────────────────────────────────
  const accounts: StatusAccount[] = []
  for (const alias of reported) {
    const account = settings[alias] ?? {}
    const mode = (account.mode ?? "interactive") as StatusAccount["mode"]
    let level: StatusAccount["level"] = "read"
    try {
      // The one decision (design §3.1): `write` only when the sign-in record and Google's last refresh both say so.
      const decision = await ports.auth.level(alias, call.signal)
      level = decision.level
      // A sign-in that says Read and write but fails either check is refused for a reason (review LOW 2): say which,
      // in the error's own words from codes, not a bare "read".
      if (decision.level === "read" && decision.refusal !== "ACCOUNT_READ_ONLY") {
        note(errorText(decision.refusal, `The account ${alias} is read because ${decision.why}`))
      }
    } catch (error) {
      // An account that cannot get a token cannot commit either. Its next step is the error's own, never Google's text.
      if (!(error instanceof BigQueryError)) throw error
      note(error.next)
    }
    // The stored device binding, when the auth port can name it; never a Google call (review LOW 3, request 3).
    let binding: "bound" | "unbound" | undefined
    if (mode === "interactive") {
      try {
        binding = await (ports.auth as typeof ports.auth & BindingAccessor).binding?.(alias, call.signal)
      } catch {
        binding = undefined
      }
    }
    accounts.push({
      alias,
      mode,
      level,
      ...(account.billingProject !== undefined ? { billingProject: account.billingProject } : {}),
      ...(account.location !== undefined ? { location: account.location } : {}),
      ...(binding !== undefined ? { binding } : {}),
      // A Read account carries the disclosure: the binding's own wording once Google has answered, and the form's
      // pre-binding sentence (which says status will say) until then.
      ...(mode === "interactive" && level === "read"
        ? { disclosure: binding !== undefined ? DISCLOSURE[binding] : `${DISCLOSURE.bound} ${DISCLOSURE.formSuffix}` }
        : {}),
    })
    if (mode !== "interactive") warn.push({ code: "HEADLESS_IDENTITY", message: `The account ${alias} is a ${mode} account: its queries run as that principal, not as you.` })
  }

  // ── What Google billed, from the local ledger (design §6.2 item 4) ───────
  let spend: NonNullable<OutputOf<"status">["spend"]> | undefined
  const session = sessionHash(call.sessionID)
  const now = ports.clock.now()
  try {
    const perAccount = await Promise.all(
      reported.map(async (alias) => {
        const [today, inSession] = await Promise.all([
          ports.ledger.spent({ account: alias, since: localDayStart(now) }),
          ports.ledger.spent({ account: alias, since: 0, session }),
        ])
        return { today, inSession }
      }),
    )
    const todayBytes = perAccount.reduce((sum, entry) => sum + entry.today, 0)
    spend = { todayBytes, sessionBytes: perAccount.reduce((sum, entry) => sum + entry.inSession, 0), todayUsd: usdFor(todayBytes, options) }
  } catch {
    note("The spend ledger could not be read, so the bytes billed today and in this session are not shown.")
  }

  // ── The free checks ────────────────────────────────────────────────────
  const include = new Set(input.include ?? [])
  const withProject = reported.filter((alias) => settings[alias]?.billingProject !== undefined)

  // The IAM check: once after a Read sign-in, and on demand (design §3, review L-4).
  for (const alias of withProject) {
    const onDemand = include.has("iam")
    const pending = takePendingIamCheck(options, alias)
    if (!onDemand && !pending) continue
    const billingProject = settings[alias]!.billingProject!
    try {
      const report = await iamCheck({ alias, billingProject, options, bigquery: ports.bigquery, signal: call.signal })
      for (const hit of report.canWrite.slice(0, 3)) {
        warn.push({
          code: "IDENTITY_CAN_WRITE",
          message: `The identity can change data in ${path(hit.table.projectId, hit.table.datasetId, hit.table.tableId)}: it holds ${hit.permissions.join(", ")}. Outside this plugin only IAM stops it, and whether it may create datasets at project level cannot be checked.`,
        })
      }
      if (report.canWrite.length === 0 && report.status !== "OK") note("The IAM check did not finish; bigquery_status({ include: [\"iam\"] }) asks again.")
    } catch (error) {
      if (!(error instanceof BigQueryError)) throw error
      note(error.next)
    }
  }

  // Running jobs, a free jobs.list (design §13: status names them; bigquery_cancel stops one).
  let message: string | undefined
  if (include.has("jobs")) {
    const running: string[] = []
    for (const alias of withProject) {
      try {
        const answer = await ports.bigquery.listJobs({ account: alias, project: settings[alias]!.billingProject!, stateFilter: "running", maxResults: 100 }, call.signal)
        for (const job of answer.items) running.push(`${alias}:${ident(job.ref.jobId)}${job.ref.location ? ` (${ident(job.ref.location)})` : ""}`)
      } catch (error) {
        if (!(error instanceof BigQueryError)) throw error
        note(error.next)
      }
    }
    if (running.length > 0) {
      const shown = running.slice(0, 5).join(", ")
      message = `${running.length} job${running.length === 1 ? " is" : "s are"} running: ${shown}${running.length > 5 ? `, and ${running.length - 5} more` : ""}.`
    }
  }

  // A headless credential wider than BigQuery needs (design §3.2). Checked only when a Google call is already part of
  // the call, never by the default status, which makes none.
  if (include.has("iam")) {
    for (const alias of reported) {
      const mode = settings[alias]?.mode ?? "interactive"
      if (mode === "interactive") continue
      try {
        const token = await ports.auth.token(alias, call.signal)
        if (token.scopes.includes("https://www.googleapis.com/auth/cloud-platform")) {
          warn.push({
            code: "SCOPE_WIDER_THAN_LEVEL",
            message: `The ${mode} credential for ${alias} carries cloud-platform, which is wider than BigQuery needs. Create it with openid, https://www.googleapis.com/auth/userinfo.email and https://www.googleapis.com/auth/bigquery instead.`,
          })
        }
      } catch (error) {
        if (!(error instanceof BigQueryError)) throw error
        note(error.next)
      }
    }
  }

  return {
    state: "done",
    accounts,
    caps: { maxBytesBilled: options.maxBytesBilled, maxBytesCeiling: options.maxBytesCeiling },
    ...(spend !== undefined ? { spend } : {}),
    ...(warn.length > 0 ? { warnings: warn } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(next !== undefined ? { next } : {}),
  }
}

export const STATUS_HANDLERS: Pick<Handlers, "status"> = { status }
