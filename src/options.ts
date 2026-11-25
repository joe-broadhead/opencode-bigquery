// Plugin options (design §12). Strict: an option that is not listed here is refused with OPTIONS_INVALID rather than
// ignored, so a typo cannot silently leave the plugin more open than the person meant. Every option has a default, and
// no option holds a secret: an OAuth client's secret is not a secret for a Desktop client, and a token is named by the
// environment variable that holds it, never written here.
import * as z from "zod";
import { BigQueryError } from "./domain/errors.js";
import { headlessLevelProblem, LEVELS } from "./domain/levels.js";
import { DATASET_ID, LOCATION, PROJECT_ID } from "./domain/reference.js";

const UNITS: Readonly<Record<string, number>> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40 };

/** Bytes from a whole number or a size such as `10GiB`. */
export function parseBytes(value: number | string): number {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/.exec(value.trim());
  const unit = match ? UNITS[match[2]!] : undefined;
  if (!match || unit === undefined) throw new Error(`not a byte size: ${value}`);
  return Math.round(Number(match[1]) * unit);
}

const bytes = z
  .union([z.number().int().positive(), z.string().regex(/^\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/, "use bytes or a size such as 10GiB")])
  .transform(parseBytes);
const envVarName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/, "use an environment variable's name");

/** `"proj.dataset"`, `"proj.*"` or `"*.sales_*"`. */
const datasetPattern = z.string().regex(/^[A-Za-z0-9_*:.-]+\.[A-Za-z0-9_*]+$/, 'use "project.dataset", with * as a wildcard');

/** A Desktop OAuth client: its id and (not secret for a Desktop client) its secret, or Google's downloaded JSON. */
const OAuthClientSchema = z.union([
  z.strictObject({ clientId: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/), clientSecret: z.string().min(1).optional() }),
  z.strictObject({ installed: z.looseObject({ client_id: z.string(), client_secret: z.string().optional() }) }),
]);

/**
 * One account's profile: what `options.accounts.<alias>` holds, and the schema the manifest names. Every field is
 * optional, so `{}` is the interactive default.
 */
const AccountSchema = z
  .strictObject({
    mode: z.enum(["interactive", "token"]).default("interactive"),
    /** Can only lower the sign-in's level (design §3.1); `write` on a headless account is refused. */
    level: z.enum(LEVELS).optional(),
    billingProject: z.string().regex(PROJECT_ID).optional(),
    location: z.string().regex(LOCATION).optional(),
    /** The dataset fence: deny wins; checked on every path, sources included. */
    datasets: z.strictObject({ allow: z.array(datasetPattern).max(200).optional(), deny: z.array(datasetPattern).max(200).optional() }).optional(),
    /** Datasets whose results never go inline (save-only). */
    inline: z.strictObject({ deny: z.array(datasetPattern).max(200) }).optional(),
    oauthClient: OAuthClientSchema.optional(),
    /** `token` mode: the variable holding an access token. */
    tokenEnv: envVarName.optional(),
    /** Extra scopes, shown in status, such as drive.readonly for Drive external tables. */
    scopes: z.array(z.string().regex(/^https:\/\/www\.googleapis\.com\/auth\/[\w.-]+$/)).max(10).optional(),
  })
  .superRefine((value, context) => {
    const problem = headlessLevelProblem(value.mode, value.level);
    if (problem) context.addIssue({ code: "custom", path: ["level"], message: problem });
    if (value.mode === "token" && value.tokenEnv === undefined) context.addIssue({ code: "custom", path: ["tokenEnv"], message: "a token account names its variable" });
    if (value.mode !== "token" && value.tokenEnv !== undefined) context.addIssue({ code: "custom", path: ["tokenEnv"], message: "only a token account takes tokenEnv" });
    if (value.mode !== "interactive" && value.oauthClient !== undefined) context.addIssue({ code: "custom", path: ["oauthClient"], message: "only an interactive account takes an OAuth client" });
  });

export type AccountOptions = z.output<typeof AccountSchema>;

const SavedQuerySchema = z.strictObject({
  sql: z.string().min(1).max(1_048_576),
  project: z.string().regex(PROJECT_ID).optional(),
  location: z.string().regex(LOCATION).optional(),
  /** At most this many bytes billed per read; 1 GiB by default. */
  maxBytes: bytes.optional(),
  allowUncached: z.boolean().optional(),
});

const BudgetSchema = z.strictObject({ daily: bytes.optional(), session: bytes.optional(), action: z.enum(["refuse", "warn"]).default("refuse") });

export const OptionsSchema = z
  .strictObject({
    access: z.enum(["all", "ask-changes", "read-only"]).default("all"),
    /** Aliases to account settings; with none, one `default` interactive account. */
    accounts: z.record(z.string().regex(/^[a-z][a-z0-9]{0,31}$/, "use a short lowercase alias"), AccountSchema).optional(),
    oauthClient: OAuthClientSchema.optional(),
    redirectUri: z.string().min(1).optional(),
    callbackPort: z.number().int().min(1).max(65_535).optional(),
    maxBytesBilled: bytes.default(10 * 2 ** 30),
    maxBytesCeiling: bytes.default(100 * 2 ** 30),
    budget: BudgetSchema.optional(),
    onDemandUsdPerTiB: z.number().positive().max(1000).default(6.25),
    maxRows: z.number().int().min(1).max(500).default(50),
    maxInlineBytes: bytes
      .refine((value) => value <= 256 * 2 ** 10, "at most 256 KiB")
      .default(32 * 2 ** 10),
    maxSaveRows: z.number().int().min(1).max(100_000_000).default(1_000_000),
    maxSaveBytes: bytes.default(256 * 2 ** 20),
    resultsDir: z.string().min(1).max(1024).default(".bigquery/results"),
    allowedRoots: z.array(z.string().min(1).max(4096)).max(20).default([]),
    jobTimeoutSeconds: z.number().int().min(1).max(21_600).default(600),
    uncappedTimeoutSeconds: z.number().int().min(1).max(21_600).default(120),
    maxConcurrentJobs: z.number().int().min(1).max(32).default(4),
    scripts: z.boolean().default(true),
    uncappedReads: z.enum(["ask", "refuse"]).default("ask"),
    policyTagged: z.enum(["withhold", "allow"]).default("withhold"),
    savedQueries: z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), SavedQuerySchema).default({}),
    admin: z.strictObject({ enabled: z.boolean().default(true), requireReason: z.boolean().default(true) }).default({ enabled: true, requireReason: true }),
    allowUntestedHost: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    if (value.maxBytesBilled > value.maxBytesCeiling) context.addIssue({ code: "custom", path: ["maxBytesBilled"], message: "the default cap is above maxBytesCeiling" });
    if (value.redirectUri !== undefined && value.callbackPort === undefined) context.addIssue({ code: "custom", path: ["redirectUri", "callbackPort"], message: "redirectUri needs callbackPort" });
    for (const [name, saved] of Object.entries(value.savedQueries)) {
      if (saved.maxBytes !== undefined && saved.maxBytes > value.maxBytesCeiling) context.addIssue({ code: "custom", path: ["savedQueries", name, "maxBytes"], message: "above maxBytesCeiling" });
    }
  });

export type Options = z.output<typeof OptionsSchema>;

/** The accounts, with the default when none is configured. */
export function accountsOf(options: Pick<Options, "accounts">): Readonly<Record<string, AccountOptions>> {
  return options.accounts && Object.keys(options.accounts).length > 0 ? options.accounts : { default: { mode: "interactive" } };
}

/** The dataset id pattern, re-exported for the fence. */
export { DATASET_ID };

const EXAMPLE = `"plugins": [{ "package": "github:we-the-rebel-alliance/bigquery-plugin#v0.0.1", "options": { "access": "ask-changes" } }]`;

/** The options, parsed with their defaults, or `OPTIONS_INVALID` named by its path. */
export function loadOptions(raw: unknown): Options {
  const result = OptionsSchema.safeParse(raw ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]].join(".") : issue?.path.join(".");
  const message = issue?.code === "unrecognized_keys" ? "this option does not exist" : (issue?.message ?? "invalid value");
  throw new BigQueryError("OPTIONS_INVALID", path ? `Invalid plugin option "${path}": ${message}` : `Invalid plugin options: ${message}`, `Fix the plugin's options in opencode.json, for example ${EXAMPLE}`);
}
