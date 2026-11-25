// What every handler receives besides its input and the register's `call`: the provider ports, the parsed options, the
// plugin's state for status, and the resolved account and call. Handlers never touch a tool, RPC or permission door.

import type { Bus } from "@we-the-rebel-alliance/plugin-contract/bus";
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest";
import type { Options } from "../options.js";
import type { Ports } from "../ports.js";

/** The parts of the instance every handler shares. */
export interface HandlerDeps {
  readonly manifest: Manifest;
  readonly ports: Ports;
  readonly options: Options;
  /** The installed package version. */
  readonly version: string;
  /** The OpenCode release the plugin loaded on. */
  readonly hostVersion: string;
  /** Integration problems from account registration, one line each; status shows them. */
  readonly accountProblems: readonly string[];
}

/** One call: the register resolved the account and the door's context. */
export interface HandlerContext extends HandlerDeps {
  readonly account: string;
  readonly sessionID: string;
  readonly signal: AbortSignal;
  readonly progress: (update?: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly bus: Bus;
}

/** One call's context, from the instance's parts and the register's call. */
export function withCall(deps: HandlerDeps, call: { readonly account: string; readonly sessionID: string; readonly signal: AbortSignal; readonly progress: (update?: Readonly<Record<string, unknown>>) => Promise<void>; readonly bus: Bus }): HandlerContext {
  return { ...deps, account: call.account, sessionID: call.sessionID, signal: call.signal, progress: call.progress, bus: call.bus };
}

/**
 * A nudge after a write (contract §10): the jobs source moved, because this plugin started or cancelled a job. A nudge
 * carries no content; an app re-reads `bigquery.jobs`. The writer answers a refusal, never a throw.
 */
export async function emitChanged(call: { readonly account: string; readonly bus: Bus }, capability: string, reason: string): Promise<void> {
  await call.bus.emit("changed", { capability, account: call.account, reason });
}
