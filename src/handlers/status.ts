// `status`: every alias's state, the host range, the agents the generated access rules miss, and one redacted next step
// (contract §11). No state is written after `register` returns: the account states come from the auth port, and the
// unguarded agents from the call, which `register` fills from its own registration.
import { type AccountStatus, accountStatuses, accountsOf, STATUS_SCHEMA, statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts";
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register";
import { BigQueryError } from "../domain/errors.js";
import type { HandlerContext, HandlerDeps } from "./context.js";

/** What one alias's state is, as status reports it. */
async function signalOf(context: HandlerContext, alias: string): Promise<{ state: AccountStatus["state"]; owner?: AccountStatus["owner"]; reason?: string }> {
  const settings = context.options.accounts?.[alias];
  if (settings?.mode === "token") {
    // A token account has no stored record: the variable's presence is all status can say without calling Google.
    const value = settings.tokenEnv !== undefined ? process.env[settings.tokenEnv] : undefined;
    return value !== undefined && value.trim() !== "" ? { state: "ready" } : { state: "needs_sign_in" };
  }
  try {
    const identity = await context.ports.auth.identity(alias, context.signal);
    return { state: "ready", ...(identity.email !== undefined ? { owner: { id: `mailto:${identity.email}`, label: identity.email } } : {}) };
  } catch (error) {
    if (error instanceof BigQueryError && error.code === "AUTH_REQUIRED") return { state: "needs_sign_in" };
    return { state: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The status handler, with the instance's values closed over. */
export function createStatus(deps: HandlerDeps) {
  return {
    description: "The plugin's state: every account alias, the host range, the agents its access rules miss, and what to do next.",
    input: { type: "object", properties: {}, additionalProperties: false } as const,
    output: STATUS_SCHEMA,
    async run(_input: Record<string, unknown>, call: MethodCall): Promise<Record<string, unknown>> {
      const context: HandlerContext = { ...deps, account: call.account, sessionID: call.sessionID, signal: call.signal, progress: call.progress, bus: call.bus };
      const plan = accountsOf(deps.manifest, deps.options as unknown as Record<string, unknown>);
      const profiles = plan.ok ? plan.value.accounts : [];
      const statuses: AccountStatus[] = [];
      for (const profile of profiles) statuses.push(accountStatuses([profile], { [profile.alias]: await signalOf(context, profile.alias) })[0]!);
      // An agent list that cannot be read is `{ ok: false, error }`, never a throw and never a zero; statusAnswer reports
      // it as one more problem and writes an empty list.
      return statusAnswer({
        manifest: deps.manifest,
        version: deps.version,
        hostVersion: deps.hostVersion,
        accounts: statuses,
        problems: [...deps.accountProblems],
        unguardedAgents: await call.unguardedAgents(),
      }) as unknown as Record<string, unknown>;
    },
  };
}
