import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { harness, testCall } from "../support/harness.js";
import { NOW } from "../support/time.js";

describe("provider", () => {
  test("Google's reason decides the code before the status does", async () => {
    const h = harness();
    const fetchImpl = async () => new Response(JSON.stringify({ error: { code: 403, message: "Access Denied", errors: [{ reason: "accessDenied", message: "Access Denied" }] } }), { status: 403, headers: { "content-type": "application/json" } });
    const ports = { ...h.ports, bigquery: (await import("../../src/provider/bigquery.js")).createBigQueryPort({ options: h.options, auth: h.auth, fetch: fetchImpl as never }) };
    await expect(ports.bigquery.getTable("work", { projectId: "alpha-analytics", datasetId: "sales", tableId: "orders" }, new AbortController().signal)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  test("a 404 is NOT_FOUND and a 429 is RATE_LIMITED", async () => {
    const h = harness();
    const { createBigQueryPort } = await import("../../src/provider/bigquery.js");
    const answer = (status: number, reason: string) => async () => new Response(JSON.stringify({ error: { code: status, message: reason, errors: [{ reason, message: reason }] } }), { status, headers: { "content-type": "application/json" } });
    const notFound = createBigQueryPort({ options: h.options, auth: h.auth, fetch: answer(404, "notFound") as never, retry: { tries: 1 } });
    await expect(notFound.getTable("work", { projectId: "alpha-analytics", datasetId: "sales", tableId: "orders" }, new AbortController().signal)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const limited = createBigQueryPort({ options: h.options, auth: h.auth, fetch: answer(429, "rateLimitExceeded") as never, retry: { tries: 1 } });
    await expect(limited.getTable("work", { projectId: "alpha-analytics", datasetId: "sales", tableId: "orders" }, new AbortController().signal)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  test("a dry run carries no destination, write disposition, session or connection", async () => {
    const h = harness();
    await h.handlers.query!.run({ sql: "SELECT order_id FROM `alpha-analytics.sales.orders`" }, testCall("work"));
    for (const request of h.google.requests) {
      const body = JSON.stringify(request.body ?? {});
      expect(body).not.toMatch(/destinationTable|writeDisposition|createSession|connectionProperties/);
    }
  });

  test("the account's dataset fence refuses a read outside it", async () => {
    const h = harness({ accounts: { work: { billingProject: "alpha-analytics", datasets: { allow: ["alpha-analytics.other"] } } } });
    await expect(h.handlers.query!.run({ sql: "SELECT order_id FROM `alpha-analytics.sales.orders`" }, testCall("work"))).rejects.toThrow(/fence/);
  });

  test("a row-secured table's sample is withheld, not guessed", async () => {
    const h = harness();
    const answer = (await h.handlers.table!.run({ project: "alpha-analytics", dataset: "sales", table: "restricted_orders", sample: 2 }, testCall("work"))) as { sample: { unavailable: string } };
    expect(answer.sample.unavailable).toMatch(/row access policy/);
  });

  test("save writes the rows to a file inside the project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bigquery-save-"));
    const h = harness({ resultsDir: dir, allowedRoots: [dir] });
    const path = join(dir, "results.jsonl");
    const answer = (await h.handlers.save!.run({ jobId: "oc_00000000-0000-4000-8000-000000000001", path, format: "jsonl" }, testCall("work"))) as { path: string; rows: number; sha256: string };
    expect(answer.rows).toBe(2);
    expect(answer.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
  });

  test("save refuses a path outside the project and the allowed roots", async () => {
    const h = harness();
    await expect(h.handlers.save!.run({ jobId: "oc_00000000-0000-4000-8000-000000000001", path: "/etc/bigquery.jsonl", format: "jsonl" }, testCall("work"))).rejects.toThrow(/path/);
  });

  test("status survives an unreadable agent list as error, never zero", async () => {
    const h = harness();
    const call = { ...testCall("default"), unguardedAgents: async () => ({ ok: false as const, error: "the host refused the list" }) };
    const answer = (await h.handlers.status!.run({}, call)) as Record<string, unknown>;
    expect(answer.state).toBe("error");
    expect(String(answer.nextStep)).toContain("the host refused the list");
    expect(answer.unguardedAgents).toEqual([]);
  });

  test("the ledger records what a job billed, once", async () => {
    const h = harness();
    await h.handlers.query!.run({ sql: "SELECT order_id FROM `alpha-analytics.sales.orders`" }, testCall("work"));
    const spent = await h.ports.ledger.spent({ account: "work", since: NOW - 86_400_000 });
    expect(spent).toBe(1048576);
  });
});
