// Local sign-out (design §3.1, R3-M1, §14.1 token storage): the key is deleted, the stored token's fate is said in the
// right words for its binding, and Google's project-wide /revoke is never called.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateKey, readKey, writeKey } from "../../../src/auth/keys.js"
import { signOutLocal } from "../../../src/auth/signout.js"
import { authState } from "../../../src/auth/state.js"
import { loadOptions } from "../../../src/options.js"

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), "bigquery-auth-signout-"))
  const options = loadOptions({ accounts: { work: { billingProject: "invented-proj" } } })
  const state = authState(options, stateDir)
  const key = generateKey()
  writeKey(stateDir, "work", key)
  state.tokens.set("work", { keyId: key.keyId, token: "ya29.invented-access-token", expiresAt: Date.now() + 3_600_000, scopes: [] })
  return { stateDir, state, key }
}

describe("sign-out", () => {
  it("deletes the key and says a bound token cannot mint another one anywhere", () => {
    const { stateDir, state, key } = setup()
    try {
      const result = signOutLocal({ state, alias: "work", binding: "bound", connected: true })
      expect(result).toMatchObject({ alias: "work", deleted: true, binding: "bound" })
      expect(readKey(stateDir, "work", key.keyId)).toBeUndefined()
      expect(result.text).toContain("cannot mint another token here or anywhere")
      expect(result.text).toContain("opencode auth logout bigquery-work")
      expect(result.text).toContain("revocation endpoint was not called")
      expect(state.tokens.has("work")).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it("says an unbound token stays valid at Google, and where to remove the app", () => {
    const { stateDir, state } = setup()
    try {
      const result = signOutLocal({ state, alias: "work", binding: "unbound", connected: true })
      expect(result.text).toContain("stays valid at Google")
      expect(result.text).toContain("https://myaccount.google.com/permissions")
      expect(result.text).not.toContain("key file")
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it("deletes a leftover key even when the host reports no active connection", () => {
    const { stateDir, state } = setup()
    try {
      const result = signOutLocal({ state, alias: "work", connected: false })
      expect(result.deleted).toBe(true)
      expect(result.text).toContain("No active Google sign-in")
      expect(result.text).toContain("key file was deleted")
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
