/**
 * Which account a call acts as: the one it names, or the only one configured. With several and none named, the call is
 * refused rather than guessed (`ACCOUNT_REQUIRED`). The resource every assert names starts with this alias.
 */
import { BigQueryError } from "./errors.js"

export function resolveAccount(configured: readonly string[], named: string | undefined): string {
  if (named !== undefined) {
    if (!configured.includes(named)) throw new BigQueryError("ACCOUNT_UNKNOWN", `No account named ${/^[a-z][a-z0-9-]*$/.test(named) ? named : "that"} is configured`)
    return named
  }
  if (configured.length === 1) return configured[0]!
  throw new BigQueryError("ACCOUNT_REQUIRED", `${configured.length} accounts are configured and the call named none`)
}

/** The resource an assert names: `<account>:<operation>`. */
export const operationResource = (account: string, operation: string) => `${account}:${operation}`

/** The resource a table assert names: `<account>:table:<project>.<dataset>.<name>` (design §5.4). */
export const tableResource = (account: string, project: string, dataset: string, name: string) => `${account}:table:${project}.${dataset}.${name}`
