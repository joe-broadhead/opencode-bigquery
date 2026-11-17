// The ports the plugin runs with: each package's port, the plan store and the clock. Tests build their own from
// test/fake/ports.ts instead.
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { createAuthPort } from "./auth/index.js"
import { PlanStore } from "./domain/plans.js"
import { createLedger } from "./guards/ledger.js"
import type { Options } from "./options.js"
import type { Ports } from "./ports.js"
import { createBigQueryPort } from "./process/bigquery.js"

/** The plugin's own state folder: the DPoP keys (0700) and the spend ledger. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-bigquery")
}

export function createPorts(options: Options): Ports {
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)
  const auth = createAuthPort({ options, fetch: fetch as typeof globalThis.fetch })
  return {
    auth,
    bigquery: createBigQueryPort({ options, auth, fetch: fetch as typeof globalThis.fetch }),
    ledger: createLedger({ stateDir: stateDir() }),
    plans: new PlanStore(),
    clock: { now: () => Date.now(), uuid: () => randomUUID() },
  }
}
