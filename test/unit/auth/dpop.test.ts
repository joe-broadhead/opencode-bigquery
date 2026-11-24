// DPoP (design §3.2, R3-L1): the proof's shapes, the code exchange's jti, the refresh's unique jti, and the key file's
// place and modes. Google's desktop-app page is the source for every claim and header member.
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { codeJti, dpopProof, randomState, refreshJti, TOKEN_HTU } from "../../../src/auth/dpop.js"
import { deleteKey, generateKey, keyPath, readKey, stateDirOf, thumbprint, writeKey, keysDirOf } from "../../../src/auth/keys.js"

const root = mkdtempSync(join(tmpdir(), "bigquery-auth-keys-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>

describe("the DPoP proof", () => {
  it("carries Google's header and payload members, signed with the key it names", async () => {
    const key = generateKey()
    const proof = dpopProof(key, { jti: "invented-jti-1", now: Date.parse("2026-11-17T12:00:00Z") })
    const [header, payload, signature] = proof.split(".")
    expect(header && payload && signature).toBeTruthy()
    expect(decode(header!)).toEqual({ typ: "dpop+jwt", alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: key.jwk.x, y: key.jwk.y } })
    expect(decode(payload!)).toEqual({ jti: "invented-jti-1", htm: "POST", htu: TOKEN_HTU, iat: Math.floor(Date.parse("2026-11-17T12:00:00Z") / 1000) })
    const { verify, createPublicKey } = await import("node:crypto")
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: key.jwk.x, y: key.jwk.y } as never, format: "jwk" })
    expect(verify("sha256", Buffer.from(`${header}.${payload}`, "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true)
  })

  it("adds a nonce only when Google gave one", () => {
    const key = generateKey()
    const without = decode(dpopProof(key, { jti: "j1", now: 0 }).split(".")[1]!)
    const withNonce = decode(dpopProof(key, { jti: "j1", now: 0, nonce: "invented-nonce" }).split(".")[1]!)
    expect(without).not.toHaveProperty("nonce")
    expect(withNonce.nonce).toBe("invented-nonce")
  })

  it("derives the code exchange's jti from the code, and a refresh's from fresh randomness", () => {
    const code = "4/invented-authorization-code"
    expect(codeJti(code)).toBe(createHash("sha256").update(code, "utf8").digest("base64url"))
    expect(refreshJti()).not.toBe(refreshJti())
    expect(refreshJti()).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe("the key file", () => {
  it("lives in the plugin's state folder, 0600 inside a 0700 folder, and holds no token", () => {
    const stateDir = join(root, "state")
    const key = generateKey()
    writeKey(stateDir, "work", key)
    const path = keyPath(stateDir, "work")
    expect(path).toBe(join(keysDirOf(stateDir), "work.jwk"))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(keysDirOf(stateDir)).mode & 0o777).toBe(0o700)
    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    const body = readFileSync(path, "utf8")
    expect(body).not.toContain("ya29.")
    expect(body).not.toContain("1//")
    expect(readKey(stateDir, "work", key.keyId)?.jwk).toEqual(key.jwk)
  })

  it("is the RFC 7638 thumbprint, so a record names exactly one key", () => {
    const key = generateKey()
    expect(thumbprint(key.jwk)).toBe(key.keyId)
    const stateDir = join(root, "state-2")
    writeKey(stateDir, "work", key)
    expect(readKey(stateDir, "work", "another-key")).toBeUndefined()
    expect(deleteKey(stateDir, "work")).toBe(true)
    expect(readKey(stateDir, "work", key.keyId)).toBeUndefined()
    expect(deleteKey(stateDir, "work")).toBe(false)
  })

  it("is replaced by a new sign-in: one file per alias, the new kid, the old key gone", () => {
    const stateDir = join(root, "state-3")
    const first = generateKey()
    const second = generateKey()
    writeKey(stateDir, "work", first)
    writeKey(stateDir, "work", second)
    expect(readKey(stateDir, "work", first.keyId)).toBeUndefined()
    expect(readKey(stateDir, "work", second.keyId)?.keyId).toBe(second.keyId)
  })

  it("defaults to $XDG_STATE_HOME/bigquery-plugin, outside OpenCode's credential store", () => {
    expect(stateDirOf({ XDG_STATE_HOME: "/invented/state" })).toBe(join("/invented/state", "bigquery-plugin"))
  })
})
