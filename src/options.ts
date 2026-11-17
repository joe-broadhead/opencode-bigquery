// Plugin options. Strict: an option that is not listed here is refused with OPTIONS_INVALID rather than ignored, so a
// typo cannot silently leave the plugin more open than the user meant. Every option is optional.
import * as z from "zod"
import { ACCESS_VALUES } from "./constants.js"
import { BigQueryError } from "./domain/errors.js"

export const OptionsSchema = z.strictObject({
  /** What the generated default rules allow: everything, changes ask, or reads only. */
  access: z.enum(ACCESS_VALUES).default("all"),
  /** Run on an OpenCode version outside the tested range, with a warning in status. */
  allowUntestedHost: z.boolean().default(false),
})

export type Options = z.output<typeof OptionsSchema>

const EXAMPLE = `"plugins": [{ "package": "github:joe-broadhead/opencode-bigquery#v0.0.1", "options": { "access": "ask-changes" } }]`

export function loadOptions(raw: unknown): Options {
  const result = OptionsSchema.safeParse(raw ?? {})
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path.join(".")
  const message = issue?.code === "unrecognized_keys" ? "this option does not exist" : (issue?.message ?? "invalid value")
  throw new BigQueryError(
    "OPTIONS_INVALID",
    path ? `Invalid plugin option "${path}": ${message}` : `Invalid plugin options: ${message}`,
    `Fix the plugin's options in opencode.json, for example ${EXAMPLE}`,
  )
}
