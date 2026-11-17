/**
 * What an interactive sign-in stores in OpenCode's credential (`metadata`), beside the refresh token and the client
 * (design §3.2): the `SignInRecord` of `src/domain/levels.ts`, the client the sign-in used so a refresh keeps working
 * when the options change, and the scopes Google granted at the code exchange.
 *
 * The record is the first of §3.1's two checks. The stored scopes are used only for the read path's scope check; the
 * level is never decided from them (`level()` reads Google's answer to this process's refresh).
 */
import * as z from "zod"
import { type SignInRecord, SignInRecordSchema } from "../domain/levels.js"
import type { ClientChoice, ClientSource, OAuthClient } from "./client.js"

const ClientSchema = z.strictObject({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  redirectUris: z.array(z.string().min(1)).optional(),
  source: z.enum(["account", "plugin", "form"]),
})

export const StoredSignInSchema = z.strictObject({
  version: z.literal(1),
  record: SignInRecordSchema,
  client: ClientSchema,
  /** The scopes of the code exchange's answer: what the read path may use, and what the disclosure counts. */
  scopes: z.array(z.string()),
})
export type StoredSignIn = z.output<typeof StoredSignInSchema>

/** The metadata a sign-in writes; nothing secret beyond the OAuth client the credential already holds. */
export function signInMetadata(input: { readonly record: SignInRecord; readonly client: ClientChoice; readonly scopes: readonly string[] }): StoredSignIn {
  const { client, source } = input.client
  return {
    version: 1,
    record: input.record,
    client: { clientId: client.clientId, ...(client.clientSecret !== undefined ? { clientSecret: client.clientSecret } : {}), ...(client.redirectUris !== undefined ? { redirectUris: [...client.redirectUris] } : {}), source },
    scopes: [...input.scopes],
  }
}

/** The stored sign-in, or undefined when the metadata is missing or malformed (an account signed in by another tool). */
export function readSignIn(metadata: Readonly<Record<string, unknown>> | undefined): StoredSignIn | undefined {
  const parsed = StoredSignInSchema.safeParse(metadata)
  return parsed.success ? parsed.data : undefined
}

/** The client a stored sign-in used, for a refresh and for a re-sign-in's reuse. */
export function signInClient(stored: StoredSignIn): ClientChoice {
  const { clientId, clientSecret, redirectUris, source } = stored.client
  const client: OAuthClient = { clientId, ...(clientSecret !== undefined ? { clientSecret } : {}), ...(redirectUris !== undefined ? { redirectUris } : {}) }
  return { client, source: source satisfies ClientSource }
}
