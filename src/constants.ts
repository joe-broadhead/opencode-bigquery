// The plugin's fixed facts: its one name and the values derived from it (contract §3). No imports at all, so a test can
// read them without loading the plugin.

/** The plugin's name: its package, namespace, RPC id and the prefix of every permission action (contract §3). */
export const NAME = "bigquery";
/** The package the manifest names. */
export const PACKAGE = "@we-the-rebel-alliance/bigquery-plugin";

/**
 * Whether this build ships the Read and write level (design §3.1, Q12). A build constant, never an option: if a live
 * check shows Google returning the write marker on a Read sign-in, this becomes false and the release ships with writes
 * off (`WRITE_LEVEL_UNAVAILABLE`). The auth port passes it to `decideLevel`; nothing else sets it.
 */
export const WRITE_LEVEL_AVAILABLE = true;

/** The write classes a plan commits, and the method each one commits through. */
export const CATEGORIES = ["write", "export", "share", "delete", "admin"] as const;
export type Category = (typeof CATEGORIES)[number];

/** The planner that makes each category's plan, and the method that commits it. */
export const PLANNER: Readonly<Record<Category, string>> = {
  write: "plan_write",
  export: "plan_export",
  share: "plan_share",
  delete: "plan_delete",
  admin: "plan_admin",
};
export const COMMITTER: Readonly<Record<Category, string>> = {
  write: "write",
  export: "export",
  share: "share",
  delete: "delete",
  admin: "admin",
};
