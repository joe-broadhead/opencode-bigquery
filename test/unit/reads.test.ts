import { describe, expect, test } from "vitest";
import { PROJECT } from "../support/google.js";
import { harness, testCall } from "../support/harness.js";

const run = async (name: string, input: Record<string, unknown>, account = "work") => {
  const h = harness();
  const handler = h.handlers[name]!;
  return { h, answer: (await handler.run(input, testCall(account))) as Record<string, unknown> };
};

describe("reads", () => {
  test("estimate is a free dry run with the cap verdict", async () => {
    const { h, answer } = await run("estimate", { sql: "SELECT order_id, total FROM `alpha-analytics.sales.orders`" });
    expect(answer.statementType).toBe("SELECT");
    expect(answer.category).toBe("read");
    expect(answer.bytes).toBe(1048576);
    expect(answer.capEnforceable).toBe(true);
    expect(answer.costUsd).toBeCloseTo((1048576 / 2 ** 40) * 6.25, 10);
    expect((answer.referenced as { tables: string[] }).tables).toEqual(["alpha-analytics.sales.orders"]);
    // The first request is the dry run: jobs.insert with dryRun: true. Expansion then reads the referenced table.
    expect(h.google.requests[0]?.method).toBe("POST");
    expect(h.google.requests[0]?.url).toContain("/jobs");
    expect((h.google.requests[0]?.body as { configuration: { dryRun: boolean } }).configuration.dryRun).toBe(true);
  });

  test("query runs under the cap and reports what it billed", async () => {
    const { h, answer } = await run("query", { sql: "SELECT order_id, total FROM `alpha-analytics.sales.orders`", maxRows: 10 });
    expect(answer.state).toBe("done");
    expect(answer.job).toMatchObject({ project: PROJECT, location: "US" });
    expect(answer.columns).toEqual([
      { name: "order_id", type: "INT64" },
      { name: "order_date", type: "DATE" },
      { name: "total", type: "NUMERIC" },
    ]);
    expect(answer.rows).toHaveLength(2);
    expect(answer.bytesBilled).toBe(1048576);
    expect(answer.cacheHit).toBe(false);
    const runCall = h.google.requests.find((request) => request.method === "POST" && request.url.endsWith("/jobs") && (request.body as { configuration?: { dryRun?: boolean } }).configuration?.dryRun !== true);
    const body = runCall?.body as { configuration: { query: { maximumBytesBilled: string } }; jobReference: { jobId: string } };
    expect(body.configuration.query.maximumBytesBilled).toBe(String(10 * 2 ** 30));
    expect(body.jobReference.jobId).toMatch(/^oc_/);
  });

  test("query refuses a change with the planner's name in the next step", async () => {
    const h = harness();
    await expect(h.handlers.query!.run({ sql: "DELETE FROM `alpha-analytics.sales.orders` WHERE order_id = 1" }, testCall("work"))).rejects.toThrow(/plan/);
  });

  test("list lists projects, then datasets, then tables with details", async () => {
    const projects = await run("list", {});
    expect(projects.answer.items).toEqual([{ project: PROJECT, name: "Alpha Analytics" }]);
    const datasets = await run("list", { project: PROJECT });
    expect(datasets.answer.items).toEqual([{ project: PROJECT, dataset: "sales", location: "US" }]);
    const tables = await run("list", { project: PROJECT, dataset: "sales", details: true });
    expect((tables.answer.items as Record<string, unknown>[])[0]).toMatchObject({ table: "orders", rows: 2, bytes: 4096 });
  });

  test("table shows the schema and a free sample", async () => {
    const { answer } = await run("table", { project: PROJECT, dataset: "sales", table: "orders", sample: 2 });
    expect(answer.type).toBe("TABLE");
    expect(answer.rows).toBe(2);
    expect(answer.sample).toHaveLength(2);
    expect((answer.columns as unknown[]).length).toBe(3);
  });

  test("search falls back to table names when INFORMATION_SCHEMA is refused", async () => {
    const h = harness();
    // The fake has no INFORMATION_SCHEMA view, so the region read 404s and the name fallback answers.
    const answer = (await h.handlers.search!.run({ project: PROJECT, query: "orders" }, testCall("work"))) as Record<string, unknown>;
    expect(answer.via).toBe("names");
    expect((answer.matches as unknown[]).length).toBeGreaterThan(0);
  });

  test("a token account without its variable refuses before any call", async () => {
    const { createAuthPort } = await import("../../src/auth/index.js");
    const { loadOptions } = await import("../../src/options.js");
    const options = loadOptions({ accounts: { work: { mode: "token", tokenEnv: "BIGQUERY_TEST_TOKEN", billingProject: PROJECT } } });
    const auth = createAuthPort({ options, fetch: async () => new Response("{}") as never, env: {} });
    await expect(auth.token("work", new AbortController().signal)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
