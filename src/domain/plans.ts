/**
 * The in-memory, single-use plan store, in opencode-gws's form. `bigquery_plan` creates a plan; one commit consumes it.
 * A plan is bound to the session, agent, account and category that made it, holds the exact statement its commit
 * re-checks, and expires after its time limit (300 s by default). A failed commit does not bring it back, and a used or
 * expired plan stays until its time limit, so a second commit hears that it was used, not that it never existed.
 *
 * Routing: a plan's category names the one tool that commits it (`COMMIT_TOOL`): `uncapped-read` plans run through
 * `bigquery_query({ planId })`, which asserts `bigquery.uncapped_read`; every other category has its own commit tool.
 */
import { randomBytes } from "node:crypto"
import { type Category, COMMIT_TOOL } from "./actions.js"
import { BigQueryError } from "./errors.js"
import type { StatementType } from "./statements.js"

const MAX_PLANS = 512

/** What a commit runs and re-checks: the exact text and parameters, and what the plan's dry run saw. */
export interface PlannedStatement {
  readonly sql: string
  readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>
  readonly project: string
  readonly location: string
  readonly statementType: StatementType
  /** The objects the statement creates, changes or drops, as `project.dataset.name`. */
  readonly targets: readonly string[]
  readonly estimateBytes: number
  /** The `maximumBytesBilled` the commit carries. */
  readonly capBytes: number
  /** Whether the byte cap bounds the statement (design §5.1 step 7). */
  readonly capEnforceable: boolean
  /** The job time limit the commit carries, in seconds. */
  readonly jobTimeoutSeconds: number
}

/** What the person sees before a commit (design §5.2). Only allowlisted fields reach a permission prompt. */
export interface PlanPreview {
  readonly category: Category
  readonly statementType: StatementType
  readonly targets: readonly string[]
  readonly referenced: readonly string[]
  readonly bytes: number
  readonly accuracy: string
  readonly usd: number
  readonly capBytes: number
  /** One of the preview sentences: the cap bounds it, may not bound it, billed outside the cap, or a script's bound. */
  readonly bound: string
  readonly reason?: string
}

export type PlanState = "ready" | "committing" | "consumed" | "expired"

export interface Plan {
  readonly id: string
  readonly category: Category
  readonly account: string
  readonly sessionId: string
  readonly agentId: string
  readonly statement: PlannedStatement
  readonly preview: PlanPreview
  /** False on a Read account for every category but `uncapped-read`: the preview shows, the commit is refused. */
  readonly committable: boolean
  readonly createdAt: number
  readonly expiresAt: number
  state: PlanState
}

/** The caller a commit must match. */
export interface PlanBinding {
  readonly sessionId: string
  readonly agentId: string
  readonly account: string
  readonly category: Category
}

/** The plan store port (src/ports.ts). This class is the implementation; tests may use it as is. */
export interface PlanStorePort {
  create(input: Omit<Plan, "id" | "state" | "createdAt" | "expiresAt"> & { readonly ttlSeconds: number }): Plan
  get(id: string): Plan | undefined
  /** Validates a commit's binding and marks the plan committing: one commit attempt only. */
  acquire(id: string, binding: PlanBinding): Plan
  /** The commit finished: the plan is used. */
  complete(id: string): void
  /** The commit failed: the plan expires, and never comes back. */
  release(id: string): void
  /** Ready plans, oldest first, optionally for one session. */
  list(filter?: { readonly sessionId?: string }): Plan[]
}

export class PlanStore implements PlanStorePort {
  private readonly plans = new Map<string, Plan>()

  constructor(private readonly now: () => number = Date.now) {}

  create(input: Omit<Plan, "id" | "state" | "createdAt" | "expiresAt"> & { readonly ttlSeconds: number }): Plan {
    this.sweep()
    const now = this.now()
    const { ttlSeconds, ...fields } = input
    const plan: Plan = { ...fields, id: `plan_${randomBytes(18).toString("base64url")}`, state: "ready", createdAt: now, expiresAt: now + ttlSeconds * 1000 }
    this.plans.set(plan.id, plan)
    while (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next().value
      if (oldest === undefined) break
      const evicted = this.plans.get(oldest)
      if (evicted) this.expire(evicted)
      this.plans.delete(oldest)
    }
    return plan
  }

  get(id: string): Plan | undefined {
    const plan = this.plans.get(id)
    if (!plan) return undefined
    if (plan.state === "ready" && this.now() >= plan.expiresAt) this.expire(plan)
    return plan
  }

  list(filter: { readonly sessionId?: string } = {}): Plan[] {
    const ready: Plan[] = []
    for (const id of [...this.plans.keys()]) {
      const plan = this.get(id)
      if (plan?.state !== "ready") continue
      if (filter.sessionId !== undefined && plan.sessionId !== filter.sessionId) continue
      ready.push(plan)
    }
    return ready.sort((a, b) => a.createdAt - b.createdAt)
  }

  acquire(id: string, binding: PlanBinding): Plan {
    const plan = this.get(id)
    if (!plan) throw new BigQueryError("PLAN_NOT_FOUND", "No plan has this planId")
    if (plan.state === "consumed") throw new BigQueryError("PLAN_ALREADY_USED", "This plan was already committed")
    if (plan.state === "committing") throw new BigQueryError("PLAN_ALREADY_USED", "This plan is being committed", "Wait for the running commit to finish; do not commit this plan again.")
    if (plan.state === "expired" || this.now() >= plan.expiresAt) throw new BigQueryError("PLAN_EXPIRED", "This plan's time limit passed")
    if (plan.sessionId !== binding.sessionId || plan.agentId !== binding.agentId) {
      throw new BigQueryError("PLAN_CALLER_MISMATCH", "A plan is bound to the session and agent that created it")
    }
    if (plan.account !== binding.account) throw new BigQueryError("PLAN_CALLER_MISMATCH", "A plan is bound to the account that created it")
    if (plan.category !== binding.category) {
      throw new BigQueryError("CATEGORY_MISMATCH", `This is a ${plan.category} plan`, `Commit it with ${commitCall(plan.category)}.`)
    }
    plan.state = "committing"
    return plan
  }

  complete(id: string): void {
    const plan = this.plans.get(id)
    if (plan?.state === "committing") plan.state = "consumed"
  }

  release(id: string): void {
    const plan = this.plans.get(id)
    if (plan?.state === "committing") this.expire(plan)
  }

  private expire(plan: Plan): void {
    if (plan.state === "ready" || plan.state === "committing") plan.state = "expired"
  }

  private sweep(): void {
    const now = this.now()
    for (const [id, plan] of this.plans) if (now >= plan.expiresAt && plan.state !== "committing") this.plans.delete(id)
  }
}

/** How to commit a category: the tool, and what it takes. */
export function commitCall(category: Category): string {
  return `${COMMIT_TOOL[category]}({ planId })`
}

/**
 * The allowlisted view of a plan for a permission prompt and status: never the SQL's parameters, never a row. The SQL
 * itself is shown, cut, because it is what the person approves.
 */
export function planMetadata(plan: Plan): Record<string, unknown> {
  return {
    planId: plan.id,
    category: plan.category,
    account: plan.account,
    statementType: plan.preview.statementType,
    targets: [...plan.preview.targets],
    bytes: plan.preview.bytes,
    usd: plan.preview.usd,
    capBytes: plan.preview.capBytes,
    bound: plan.preview.bound,
    sql: plan.statement.sql.length > 2000 ? `${plan.statement.sql.slice(0, 1999)}…` : plan.statement.sql,
    ...(plan.preview.reason !== undefined ? { reason: plan.preview.reason } : {}),
    expiresAt: new Date(plan.expiresAt).toISOString(),
  }
}
