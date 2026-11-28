// The record for bigquery-plugin#26: Google's managed BigQuery MCP server exists but covers none of this plugin's job,
// so the manifest keeps the plugin's own sign-in and no pass-through tool, and the README says why with the date.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { manifest } from "../../src/manifest.js";

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const prose = README.replace(/\s+/g, " ");

describe("Google's managed BigQuery MCP server", () => {
  test("the README records why there is no server to build on, with its link and the date checked", () => {
    expect(prose).toContain("https://cloud.google.com/bigquery/docs/reference/mcp");
    expect(prose).toContain("checked 28 November 2026");
    expect(prose).toContain("no server to build on for this plugin's job");
    expect(prose).toContain("execute_sql_readonly");
    expect(prose).toContain("maximumBytesBilled");
    expect(prose).toContain("https://www.googleapis.com/auth/bigquery");
  });

  test("the manifest builds on none of its tools", () => {
    expect(manifest.accounts?.via).toBe("integration");
    expect(Object.keys(manifest.methods).filter((method) => method === "mcp:*" || method.startsWith("mcp:"))).toEqual([]);
  });
});
