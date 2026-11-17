/**
 * The account settings a read tool needs, from the options (design §12): its billing project, its location, its dataset
 * fence and its inline deny list. The registry has already resolved the alias, so a missing account here is a bug; it
 * still fails closed with `ACCOUNT_UNKNOWN`.
 */
import { accountsOf, type Options } from "../options.js"
import { BigQueryError } from "../domain/errors.js"
import type { Level } from "../domain/levels.js"

export interface Fence {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
}

export interface AccountSettings {
  readonly alias: string
  readonly billingProject?: string
  readonly location?: string
  readonly fence?: Fence
  readonly inlineDeny: readonly string[]
  /** The account's `level` option, which can only lower the sign-in's level. */
  readonly configuredLevel?: Level
}

export function settingsOf(options: Options, alias: string): AccountSettings {
  const accounts = accountsOf(options)
  const settings = accounts[alias]
  if (!settings) throw new BigQueryError("ACCOUNT_UNKNOWN", "No account is configured under that alias")
  return {
    alias,
    ...(settings.billingProject !== undefined ? { billingProject: settings.billingProject } : {}),
    ...(settings.location !== undefined ? { location: settings.location } : {}),
    ...(settings.datasets !== undefined ? { fence: settings.datasets } : {}),
    inlineDeny: settings.inline?.deny ?? [],
    ...(settings.level !== undefined ? { configuredLevel: settings.level } : {}),
  }
}

/** The project a job runs in: the call's own, or the account's billing project (`BILLING_PROJECT_REQUIRED`). */
export function projectOf(settings: AccountSettings, requested: string | undefined): string {
  const project = requested ?? settings.billingProject
  if (!project) {
    throw new BigQueryError(
      "BILLING_PROJECT_REQUIRED",
      `The account ${settings.alias} has no billing project, and the call named none`,
      "Call bigquery_list to see the projects, then set billingProject on the account.",
    )
  }
  return project
}

/** The location to ask for: the call's, else the account's; undefined lets BigQuery choose and the dry run pin it. */
export function locationOf(settings: AccountSettings, requested: string | undefined): string | undefined {
  return requested ?? settings.location
}
