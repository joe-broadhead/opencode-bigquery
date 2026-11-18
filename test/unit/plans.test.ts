// Plans are single-use, expire, and are bound to the session, agent, account and category that made them.
import { describe, expect, it } from "vitest"
import { CATEGORIES } from "../../src/domain/actions.js"
import { commitCall, type Plan, planMetadata, PlanStore, type PlanTarget } from "../../src/domain/plans.js"
import { FakeClock } from "../fake/ports.js"

function store() {
  const clock = new FakeClock()
  return { clock, plans: new PlanStore(() => clock.now()) }
}

const make = (plans: PlanStore, overrides: Partial<Plan> = {}) =>
  plans.create({
    category: "write",
    account: "work",
    sessionId: "ses_1",
    agentId: "build",
    committable: true,
    statement: { sql: "INSERT INTO `p.d.t` VALUES (1)", project: "invented-proj", location: "EU", statementType: "INSERT", targets: [TARGET], estimateBytes: 0, capBytes: 10, capEnforceable: true, jobTimeoutSeconds: 600 },
    preview: { category: "write", statementType: "INSERT", targets: ["invented-proj.d.t"], referenced: [], bytes: 0, accuracy: "PRECISE", usd: 0, capBytes: 10, bound: "The cap bounds this statement." },
    ttlSeconds: 300,
    ...overrides,
  })

const TARGET: PlanTarget = { kind: "table", project: "invented-proj", dataset: "d", name: "t", label: "invented-proj.d.t" }

const binding = { sessionId: "ses_1", agentId: "build", account: "work", category: "write" as const }

describe("the plan store", () => {
  it("lets one commit acquire a plan, once", () => {
    const { plans } = store()
    const plan = make(plans)
    expect(plan.id).toMatch(/^plan_[A-Za-z0-9_-]{24}$/)
    expect(plans.acquire(plan.id, binding).state).toBe("committing")
    expect(() => plans.acquire(plan.id, binding)).toThrow(/^PLAN_ALREADY_USED: /)
    plans.complete(plan.id)
    expect(() => plans.acquire(plan.id, binding)).toThrow(/^PLAN_ALREADY_USED: .*already committed/)
  })

  it("never brings back a plan whose commit failed", () => {
    const { plans } = store()
    const plan = make(plans)
    plans.acquire(plan.id, binding)
    plans.release(plan.id)
    expect(() => plans.acquire(plan.id, binding)).toThrow(/^PLAN_EXPIRED: /)
  })

  it("expires after its time limit", () => {
    const { plans, clock } = store()
    const plan = make(plans)
    clock.advance(300_000)
    expect(() => plans.acquire(plan.id, binding)).toThrow(/^PLAN_EXPIRED: /)
    expect(() => plans.acquire("plan_never_made_anywhere_abc", binding)).toThrow(/^PLAN_NOT_FOUND: /)
  })

  it("is bound to the session, agent and account", () => {
    const { plans } = store()
    const plan = make(plans)
    expect(() => plans.acquire(plan.id, { ...binding, sessionId: "ses_2" })).toThrow(/^PLAN_CALLER_MISMATCH: /)
    expect(() => plans.acquire(plan.id, { ...binding, agentId: "plan" })).toThrow(/^PLAN_CALLER_MISMATCH: /)
    expect(() => plans.acquire(plan.id, { ...binding, account: "home" })).toThrow(/^PLAN_CALLER_MISMATCH: /)
    expect(plans.get(plan.id)?.state).toBe("ready")
  })

  it("routes a plan committed with another category's tool to the right one", () => {
    const { plans } = store()
    const plan = make(plans, { category: "uncapped-read" })
    expect(() => plans.acquire(plan.id, binding)).toThrow(/^CATEGORY_MISMATCH: This is a uncapped-read plan\. Next step: Commit it with bigquery_query\(\{ planId \}\)\.$/)
    for (const category of CATEGORIES) expect(commitCall(category)).toMatch(/^bigquery_(query|write|export|share|delete|admin)\(\{ planId \}\)$/)
  })

  it("shows only allowlisted fields in a prompt: never the parameters", () => {
    const { plans } = store()
    const plan = make(plans, { statement: { sql: "SELECT @secret", params: { secret: "invented-value" }, project: "invented-proj", location: "EU", statementType: "SELECT", targets: [], estimateBytes: 0, capBytes: 1, capEnforceable: false, jobTimeoutSeconds: 120 } })
    const metadata = planMetadata(plan)
    expect(JSON.stringify(metadata)).not.toContain("invented-value")
    expect(Object.keys(metadata).sort()).toEqual(["account", "bound", "bytes", "capBytes", "category", "expiresAt", "planId", "sql", "statementType", "targets", "usd"])
  })

  it("shows a prompt each structured target's label (contract request from package D)", () => {
    const { plans } = store()
    const policy: PlanTarget = { kind: "row access policy", project: "invented-proj", dataset: "d", name: "t", policyId: "p1", label: "invented-proj.d.t (row access policy p1)" }
    const plan = make(plans, { statement: { sql: "DROP ROW ACCESS POLICY p1 ON `invented-proj.d.t`", project: "invented-proj", location: "EU", statementType: "DROP_ROW_ACCESS_POLICY", targets: [TARGET, policy], estimateBytes: 0, capBytes: 1, capEnforceable: true, jobTimeoutSeconds: 600 } })
    expect(planMetadata(plan).targets).toEqual(["invented-proj.d.t", "invented-proj.d.t (row access policy p1)"])
    expect(plan.statement.targets[1]).toEqual(policy)
  })
})
