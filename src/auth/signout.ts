/**
 * Local sign-out (design §3.1, R3-M1): the plugin deletes its DPoP key, which is what makes the refresh token it is
 * bound to unusable. Google's `/revoke` is never called, because it revokes every scope the person granted the client's
 * project, signing them out of every app on the same client; no token can be revoked alone.
 *
 * A bound refresh token cannot mint another access token without the deleted key, here or anywhere. An unbound one
 * stays valid at Google until it expires or the person removes the app, and the result says so in those words. The
 * token OpenCode holds is deleted by the host, in `/connect` or with `opencode auth logout bigquery-<alias>`; the
 * public plugin API has no call that removes a connection, so the command names the host's own step.
 */
import { deleteKey } from "./keys.js"
import { type AuthState, forgetAlias } from "./state.js"

export interface SignOutResult {
  readonly alias: string
  /** True when a key file was there to delete. */
  readonly deleted: boolean
  readonly binding?: "bound" | "unbound"
  readonly text: string
}

/** Deletes the alias's key and forgets its in-memory tokens. Never calls Google. */
export function signOutLocal(input: { readonly state: AuthState; readonly alias: string; readonly binding?: "bound" | "unbound"; readonly connected: boolean }): SignOutResult {
  const deleted = deleteKey(input.state.stateDir, input.alias)
  forgetAlias(input.state, input.alias)
  const logout = `opencode auth logout bigquery-${input.alias}`
  const text = !input.connected
    ? `No active Google sign-in for ${input.alias}${deleted ? "; its key file was deleted" : ""}. Nothing else was deleted.`
    : [
        `Signed out ${input.alias} locally${deleted ? "" : " (its key file was already gone)"}.`,
        input.binding === "unbound"
          ? `The refresh token was not bound to this device, so the copy OpenCode holds stays valid at Google until it expires or you remove the app at https://myaccount.google.com/permissions; delete it in /connect or with \`${logout}\`.`
          : `The refresh token was bound to the deleted key, so it cannot mint another token here or anywhere. Delete the copy OpenCode holds in /connect or with \`${logout}\`.`,
        "Google's revocation endpoint was not called: it would sign you out of every app on the same OAuth client.",
      ].join(" ")
  return { alias: input.alias, deleted, ...(input.binding !== undefined ? { binding: input.binding } : {}), text }
}
