// A token, a refresh token or a client secret never survives redaction, whole or in part.
import { describe, expect, it } from "vitest"
import { reasonOf, redact, withoutSecret } from "../../src/redact.js"

// Invented values in Google's shapes; none is a real credential.
const ACCESS = "ya29.a0Invented-access-token-for-tests-only"
const REFRESH = "1//0gInvented-refresh-token-for-tests-only"
const SECRET = "GOCSPX-invented-client-secret"

describe("redaction", () => {
  it("removes Google's token and secret shapes", () => {
    for (const value of [ACCESS, REFRESH, SECRET]) {
      expect(redact(`failed with ${value} at the token endpoint`)).not.toContain(value)
      expect(reasonOf(new Error(`bad ${value}`))).not.toContain(value.slice(8))
    }
  })

  it("removes a bearer header, a key=value pair and a URL's query", () => {
    expect(redact(`Authorization: Bearer ${ACCESS}`)).not.toContain(ACCESS)
    expect(redact("refresh_token=abcdefgh12345678")).toBe("refresh_token=[redacted]")
    expect(redact("https://oauth2.example.invalid/token?code=abc#x")).toBe("https://oauth2.example.invalid/token")
  })

  it("cuts a known secret out by value", () => {
    expect(withoutSecret(`echo ${SECRET}`, SECRET)).toBe("echo [redacted]")
  })
})
