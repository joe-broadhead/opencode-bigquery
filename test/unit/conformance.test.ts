// Records `fixtures/conformance.json` from two synthetic accounts through the plugin's own handlers, over the fake
// Google hosts (test/support/google.ts). The kit replays this file; `plugin-kit record` redacts it. Every value is
// invented, and the fixed clock (test/support/time.ts) makes a second run byte-identical.
import { writeFileSync } from "node:fs";
import { accountsOf, resolveAccount } from "@we-the-rebel-alliance/plugin-contract/accounts";
import { describe, expect, test } from "vitest";
import { harness, testBus, testCall } from "../support/harness.js";

const FIXTURE = new URL("../../fixtures/conformance.json", import.meta.url);

/** The refusal a handler throws, as the fixture records it: the code and the whole message. */
async function refusalOf(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run;
  } catch (error) {
    const refusal = (error as { refusal?: { code: string; message: string } }).refusal;
    if (refusal !== undefined) return { code: refusal.code, message: refusal.message };
    throw error;
  }
  throw new Error("the call answered where the fixture expected a refusal");
}

describe("conformance fixture", () => {
  test("records what two synthetic accounts answer", async () => {
    const h = harness();
    const plan = accountsOf(h.manifest, h.options as unknown as Record<string, unknown>);
    expect(plan.ok).toBe(true);
    const profiles = plan.ok ? plan.value.accounts : [];

    // The register's two account refusals, from the contract's own module.
    const required = resolveAccount(profiles, {});
    const unknown = resolveAccount(profiles, { account: "nobodyhere" });
    expect(required.ok).toBe(false);
    expect(unknown.ok).toBe(false);

    const eventsList = h.handlers.events_list!;
    const work = (await eventsList.run({ source: "jobs" }, testCall("work"))) as Record<string, unknown>;
    const personal = (await eventsList.run({ source: "jobs" }, testCall("personal"))) as Record<string, unknown>;
    const next = (await eventsList.run({ source: "jobs", cursor: work.cursor }, testCall("work"))) as Record<string, unknown>;
    const crossed = await refusalOf(eventsList.run({ source: "jobs", cursor: work.cursor }, testCall("personal")));
    expect(crossed.code).toBe("CURSOR_INVALID");

    // A write nudges the bus, so `changed` is a recorded emission.
    const bus = testBus(h.emissions);
    const planned = (await h.handlers.plan_write!.run({ sql: "CREATE TABLE `alpha-analytics.sales.orders_copy` (order_id INT64, total NUMERIC)" }, testCall("work"))) as Record<string, unknown>;
    await h.handlers.write!.run({ planId: "recorded" }, testCall("work", { plan: planned, bus }));
    expect(h.emissions.map((emission) => emission.event)).toEqual(["changed"]);

    const status = (await h.handlers.status!.run({}, testCall("default"))) as Record<string, unknown>;
    const probeJobs = (await h.handlers.probe!.run({ source: "jobs" }, testCall("work"))) as Record<string, unknown>;
    const probeSaved = (await h.handlers.probe!.run({ source: "saved" }, testCall("personal"))) as Record<string, unknown>;
    const snapshot = (await h.handlers.saved_read!.run({ name: "revenue" }, testCall("work"))) as Record<string, unknown>;
    const suggest = (await h.handlers.saved_list!.run({}, testCall("work"))) as Record<string, unknown>;

    const fixture = {
      $comment: "Recorded from two synthetic accounts through the plugin's own handlers, over the fake Google hosts in test/support/google.ts. Every identifier is invented.",
      plugin: "@we-the-rebel-alliance/bigquery-plugin",
      namespace: h.manifest.plugin.summary,
      accounts: {
        real: true,
        aliases: ["work", "personal"],
        required: { method: "list", code: "ACCOUNT_REQUIRED" },
        unknown: { method: "list", account: "nobodyhere", code: "ACCOUNT_UNKNOWN" },
        cursors: [{ method: "events_list", account: "work", other: "personal", code: "CURSOR_INVALID" }],
      },
      sources: {
        "bigquery.jobs": {
          cases: [
            { input: { source: "jobs", account: "work" }, expect: "page", answer: work },
            { input: { source: "jobs", account: "personal" }, expect: "page", answer: personal },
            { input: { source: "jobs", account: "work", cursor: work.cursor }, expect: "page", answer: next },
            {
              input: { source: "jobs", account: "personal", cursor: work.cursor },
              expect: crossed.code,
              refuses: crossed.message,
            },
          ],
          probe: { answer: probeJobs },
        },
        "bigquery.saved": {
          snapshot: { answer: snapshot },
          probe: { answer: probeSaved },
          suggest: { answer: suggest },
        },
      },
      events: { emitted: [...new Set(h.emissions.map((emission) => emission.event))], status },
      rpc: {
        inputs: {
          cancel: { jobId: "oc_00000000-0000-4000-8000-000000000001" },
          save: { jobId: "oc_00000000-0000-4000-8000-000000000001", path: "results.jsonl", format: "jsonl" },
          plan_write: { sql: "CREATE TABLE `alpha-analytics.sales.orders_copy` (order_id INT64)" },
          plan_export: { sql: "EXPORT DATA OPTIONS(uri='gs://alpha-analytics-exports/orders-*.csv', format='CSV') AS SELECT order_id FROM `alpha-analytics.sales.orders`" },
          plan_share: { sql: "GRANT `roles/bigquery.dataViewer` ON TABLE `alpha-analytics.sales.orders` TO \"domain:example.test\"" },
          plan_delete: { sql: "DELETE FROM `alpha-analytics.sales.orders` WHERE order_id = 1" },
          plan_admin: { sql: "CREATE RESERVATION `alpha-analytics.us.daily`", reason: "the conformance recording" },
        },
      },
    };

    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
    expect((work.events as unknown[]).length).toBeGreaterThan(0);
  });
});
