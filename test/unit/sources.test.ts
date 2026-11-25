import { describe, expect, test } from "vitest";
import { JOBS, PROJECT, TIE_END } from "../support/google.js";
import { harness, testCall } from "../support/harness.js";

describe("sources", () => {
  test("events_list answers a page of finished jobs, oldest first", async () => {
    const h = harness();
    const page = (await h.handlers.events_list!.run({ source: "jobs", account: "work" }, testCall("work"))) as Record<string, unknown>;
    expect(page.source).toBe("jobs");
    expect(page.account).toBe("work");
    expect(page.trust).toBe("untrusted");
    expect((page.owner as { id: string }).id).toBe("bigquery:account:work");
    const events = page.events as { external_id: string; kind: string; title: string; hash: string; occurred_at: string }[];
    expect(events.map((event) => event.external_id)).toEqual(["alpha-analytics:US:oc_00000000-0000-4000-8000-000000000001", "alpha-analytics:US:oc_00000000-0000-4000-8000-000000000002"]);
    expect(events[0]?.occurred_at < events[1]!.occurred_at).toBe(true);
    expect(events.every((event) => event.kind === "x-bigquery/job")).toBe(true);
    expect(events[0]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(typeof page.cursor).toBe("string");
    expect(page.more).toBe(false);
  });

  test("the next page from a cursor lists nothing new", async () => {
    const h = harness();
    const first = (await h.handlers.events_list!.run({ source: "jobs" }, testCall("work"))) as Record<string, unknown>;
    const next = (await h.handlers.events_list!.run({ source: "jobs", cursor: first.cursor }, testCall("work"))) as Record<string, unknown>;
    expect(next.events).toEqual([]);
    expect(next.account).toBe("work");
  });

  test("two events with one timestamp split across pages: no skip, no duplicate, no gap", async () => {
    const h = harness({}, { tie: true });
    const first = (await h.handlers.events_list!.run({ source: "jobs", limit: 1 }, testCall("work"))) as Record<string, unknown>;
    const second = (await h.handlers.events_list!.run({ source: "jobs", limit: 1, cursor: first.cursor }, testCall("work"))) as Record<string, unknown>;
    const events = [...(first.events as { external_id: string; occurred_at: string }[]), ...(second.events as { external_id: string; occurred_at: string }[])];
    // Both pages carry the same occurred_at: the tie a timestamp-only cursor would lose.
    expect(new Set(events.map((event) => event.occurred_at))).toEqual(new Set([new Date(TIE_END).toISOString()]));
    expect(events.map((event) => event.external_id).sort()).toEqual(JOBS.map((job) => `alpha-analytics:US:${job.jobId}`).sort());
    expect(new Set(events.map((event) => event.external_id)).size).toBe(2);
    expect(first.more).toBe(true);
    expect(second.more).toBe(false);
    expect(first.gap).toBeUndefined();
    expect(second.gap).toBeUndefined();
  });

  test("another account's cursor is refused, never restarted", async () => {
    const h = harness();
    const first = (await h.handlers.events_list!.run({ source: "jobs" }, testCall("work"))) as Record<string, unknown>;
    await expect(h.handlers.events_list!.run({ source: "jobs", cursor: first.cursor }, testCall("personal"))).rejects.toMatchObject({ refusal: { code: "CURSOR_INVALID" } });
  });

  test("a source the plugin does not have is refused", async () => {
    const h = harness();
    await expect(h.handlers.events_list!.run({ source: "orders" }, testCall("work"))).rejects.toMatchObject({ refusal: { code: "SOURCE_UNKNOWN" } });
  });

  test("saved_read answers the table shape from one saved query", async () => {
    const h = harness();
    const snapshot = (await h.handlers.saved_read!.run({ source: "saved", name: "revenue" }, testCall("work"))) as Record<string, unknown>;
    expect(snapshot.trust).toBe("untrusted");
    const data = snapshot.data as { columns: { key: string; label: string }[]; rows: Record<string, unknown>[] };
    expect(data.columns.map((column) => column.key)).toEqual(["c1", "c2", "c3"]);
    expect(data.columns[1]?.label).toBe("order_date");
    expect(data.rows[0]).toEqual({ c1: 1, c2: "2026-11-19", c3: "120.50" });
    expect(typeof snapshot.asOf).toBe("string");
    expect((snapshot.cost as { units: unknown[] }).units.length).toBe(1);
  });

  test("saved_read refuses a name outside the confirmed scope", async () => {
    const h = harness();
    await expect(h.handlers.saved_read!.run({ name: "revenue", scope: { queries: ["other"] } }, testCall("work"))).rejects.toMatchObject({ refusal: { code: "INPUT_INVALID" } });
  });

  test("saved_list offers each saved query with its SQL", async () => {
    const h = harness();
    const answer = (await h.handlers.saved_list!.run({}, testCall("work"))) as { options: { id: string; label: string }[] };
    expect(answer.options).toHaveLength(1);
    expect(answer.options[0]?.id).toBe("revenue");
    expect(answer.options[0]?.label).toContain("SELECT order_date");
  });

  test("probe names the account and its owner, with no content", async () => {
    const h = harness();
    const answer = (await h.handlers.probe!.run({ source: "jobs" }, testCall("work"))) as Record<string, unknown>;
    expect(answer).toMatchObject({ source: "jobs", account: "work", trust: "untrusted", owner: { id: "bigquery:account:work" } });
    expect(h.google.requests).toHaveLength(0);
  });

  test("status lists both aliases, ready, and the host range", async () => {
    const h = harness();
    const answer = (await h.handlers.status!.run({}, testCall("default"))) as Record<string, unknown>;
    expect(answer.name).toBe("bigquery");
    expect(answer.version).toBe("0.0.0");
    expect(answer.state).toBe("ready");
    expect(answer.host).toEqual({ version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] });
    expect((answer.accounts as { alias: string; state: string }[]).map((account) => [account.alias, account.state])).toEqual([
      ["work", "ready"],
      ["personal", "ready"],
    ]);
    expect(answer.unguardedAgents).toEqual([]);
    expect(answer.nextStep).toBeNull();
  });

  test("status's alias order follows the options", async () => {
    const h = harness({ accounts: { personal: { billingProject: PROJECT }, work: { billingProject: PROJECT } } });
    const answer = (await h.handlers.status!.run({}, testCall("default"))) as { accounts: { alias: string }[] };
    expect(answer.accounts.map((account) => account.alias)).toEqual(["personal", "work"]);
  });
});
