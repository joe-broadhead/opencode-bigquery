// The id_token's claims (design §3.2, §14.1 "id_token claims"): Google's issuer, this client's audience, an unexpired
// token, and an email only when Google says it is verified. Nothing here authorises anything.
import { describe, expect, it } from "vitest"
import { idTokenIdentity } from "../../../src/auth/id-token.js"
import { inventedIdToken } from "./fake.js"

const now = Date.parse("2026-11-17T12:00:00Z")
const expected = { clientId: "invented.apps.googleusercontent.com", now }

describe("the id_token's identity", () => {
  it("takes the verified email from Google's claims", () => {
    expect(idTokenIdentity(inventedIdToken({ email: "Ada@Example.Invalid" }), expected)).toEqual({ email: "ada@example.invalid" })
    expect(idTokenIdentity(inventedIdToken({ verified: "true" }), expected)).toEqual({ email: "ada@example.invalid" })
  })

  it("gives no identity for an unverified email, another issuer, another client or an expired token", () => {
    expect(idTokenIdentity(inventedIdToken({ verified: false }), expected)).toBeUndefined()
    expect(idTokenIdentity(inventedIdToken({ iss: "https://accounts.example.invalid" }), expected)).toBeUndefined()
    expect(idTokenIdentity(inventedIdToken({ clientId: "another.apps.googleusercontent.com" }), expected)).toBeUndefined()
    expect(idTokenIdentity(inventedIdToken({ exp: Math.floor(now / 1000) - 1 }), expected)).toBeUndefined()
  })

  it("gives no identity for a malformed token, and never throws", () => {
    expect(idTokenIdentity(undefined, expected)).toBeUndefined()
    expect(idTokenIdentity("a.b", expected)).toBeUndefined()
    expect(idTokenIdentity("a.b.c", expected)).toBeUndefined()
    expect(idTokenIdentity(`${"a".repeat(20_000)}.b.c`, expected)).toBeUndefined()
  })
})
