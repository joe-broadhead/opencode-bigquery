import { describe, expect, test } from "vitest";
import { harness, testBus, testCall } from "../support/harness.js";

const ORDER_COPY = "CREATE TABLE `alpha-analytics.sales.orders_copy` (order_id INT64, total NUMERIC)";

describe("changes", () => {
  test("plan_write previews a change and names its commit", async () => {
    const h = harness();
    const answer = (await h.handlers.plan_write!.run({ sql: ORDER_COPY }, testCall("work"))) as Record<string, unknown>;
    expect(answer.method).toBe("write");
    expect((answer.output as { category: string }).category).toBe("write");
    expect((answer.output as { targets: string[] }).targets).toContain("alpha-analytics.sales.orders_copy");
    expect((answer.cost as { usd: number }).usd).toBe(0);
    // A plan changes nothing: the dry run is the only BigQuery call.
    expect(h.google.requests).toHaveLength(1);
    expect((h.google.requests[0]?.body as { configuration: { dryRun: boolean } }).configuration.dryRun).toBe(true);
  });

  test("write commits its plan once and nudges the bus", async () => {
    const h = harness();
    const bus = testBus(h.emissions);
    const plan = (await h.handlers.plan_write!.run({ sql: ORDER_COPY }, testCall("work"))) as Record<string, unknown>;
    const answer = (await h.handlers.write!.run({ planId: "minted-by-the-register" }, testCall("work", { plan, bus }))) as Record<string, unknown>;
    expect(answer.state).toBe("done");
    expect(answer.category).toBe("write");
    expect(answer.ddlOperation).toBe("CREATE");
    expect(h.emissions).toEqual([{ event: "changed", data: { capability: "bigquery.jobs", account: "work", reason: "write" } }]);
  });

  test("a planner refuses another class and names the right one", async () => {
    const h = harness();
    await expect(h.handlers.plan_delete!.run({ sql: ORDER_COPY }, testCall("work"))).rejects.toThrow(/plan_write/);
  });

  test("plan_delete plans a delete, and delete commits it", async () => {
    const h = harness();
    const plan = (await h.handlers.plan_delete!.run({ sql: "DELETE FROM `alpha-analytics.sales.orders` WHERE order_id = 1" }, testCall("work"))) as Record<string, unknown>;
    expect((plan.output as { category: string }).category).toBe("delete");
    const answer = (await h.handlers.delete!.run({ planId: "x" }, testCall("work", { plan }))) as Record<string, unknown>;
    expect(answer.state).toBe("done");
  });

  test("plan_admin needs a reason", async () => {
    const h = harness();
    await expect(h.handlers.plan_admin!.run({ sql: "CREATE RESERVATION `alpha-analytics.us.res`" }, testCall("work"))).rejects.toThrow(/reason/);
    const plan = (await h.handlers.plan_admin!.run({ sql: "CREATE RESERVATION `alpha-analytics.us.res`", reason: "a load test" }, testCall("work"))) as Record<string, unknown>;
    expect((plan.output as { category: string }).category).toBe("admin");
  });

  test("plan_query plans a read the cap cannot bound, and run_query runs it", async () => {
    const h = harness();
    const answer = (await h.handlers.plan_query!.run({ sql: "SELECT order_id FROM `alpha-analytics.sales.restricted_orders`" }, testCall("work"))) as Record<string, unknown>;
    expect(answer.method).toBe("run_query");
    expect(answer.query).toBeDefined();
    const run = (await h.handlers.run_query!.run({ planId: "x" }, testCall("work", { plan: answer }))) as Record<string, unknown>;
    expect(run.state).toBe("done");
  });

  test("query refuses a read the cap cannot bound and names plan_query", async () => {
    const h = harness();
    await expect(h.handlers.query!.run({ sql: "SELECT order_id FROM `alpha-analytics.sales.restricted_orders`" }, testCall("work"))).rejects.toThrow(/plan_query/);
  });

  test("plan_query refuses a boundable SELECT, naming query", async () => {
    const h = harness();
    await expect(h.handlers.plan_query!.run({ sql: "SELECT order_id FROM `alpha-analytics.sales.orders`" }, testCall("work"))).rejects.toThrow(/query/);
  });

  test("a commit refuses a plan of another class", async () => {
    const h = harness();
    const plan = (await h.handlers.plan_write!.run({ sql: ORDER_COPY }, testCall("work"))) as Record<string, unknown>;
    await expect(h.handlers.delete!.run({ planId: "x" }, testCall("work", { plan }))).rejects.toThrow(/plan/);
  });

  test("cancel stops a finished job of this plugin without calling jobs.cancel", async () => {
    const h = harness();
    const answer = (await h.handlers.cancel!.run({ jobId: "oc_00000000-0000-4000-8000-000000000001" }, testCall("work"))) as Record<string, unknown>;
    expect(answer.jobState).toBe("DONE");
    expect(h.google.requests.some((request) => request.url.endsWith("/cancel"))).toBe(false);
  });

  test("cancel refuses a job this plugin did not start", async () => {
    const h = harness();
    await expect(h.handlers.cancel!.run({ jobId: "job_elsewhere" }, testCall("work"))).rejects.toThrow(/BigQuery|INPUT_INVALID|not/);
  });
});
