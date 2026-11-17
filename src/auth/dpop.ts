/**
 * DPoP proofs (RFC 9449, and Google's "Construct a DPoP proof" in the desktop-app OAuth page, design §17 [27]).
 *
 * Google's page fixes every shape here: the header is `typ: dpop+jwt`, `alg: ES256` and the public JWK; the payload is
 * `jti`, `htm`, `htu`, `iat` and, when Google has given one, `nonce`; a proof is a new, unique JWT for every token
 * request; for an authorization code exchange the `jti` is `BASE64URL(SHA256(code))`, and for a refresh it is a unique
 * per-request value. The signature is ES256 in JWS's raw `R | S` form (`dsaEncoding: ieee-p1363`).
 *
 * Nothing here sends anything: `postToken` in google.ts owns the request and the `DPoP-Nonce` cache.
 */
import { createHash, createPrivateKey, randomBytes, sign, type JsonWebKey as CryptoJsonWebKey } from "node:crypto"
import { GOOGLE } from "../domain/google.js"
import { publicJwk, type DpopKey } from "./keys.js"

/** The token endpoint's URL as the proof's `htu`: the endpoint, without query or fragment. */
export const TOKEN_HTU = GOOGLE.token

export interface ProofInput {
  /** Unique per request; the code exchange derives it from the code. */
  readonly jti: string
  /** The `DPoP-Nonce` Google last gave for this key, when it gave one. */
  readonly nonce?: string
  /** Milliseconds since the epoch; the proof's `iat` is in seconds, as the JWT spec says. */
  readonly now: number
  readonly htu?: string
  readonly htm?: "POST"
}

/** A DPoP proof JWT for one token request. */
export function dpopProof(key: DpopKey, input: ProofInput): string {
  const header = { typ: "dpop+jwt", alg: "ES256", jwk: publicJwk(key) }
  const payload = {
    jti: input.jti,
    htm: input.htm ?? "POST",
    htu: input.htu ?? TOKEN_HTU,
    iat: Math.floor(input.now / 1000),
    ...(input.nonce !== undefined && input.nonce !== "" ? { nonce: input.nonce } : {}),
  }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const privateKey = createPrivateKey({ key: { ...key.jwk } as CryptoJsonWebKey, format: "jwk" })
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" })
  return `${signingInput}.${signature.toString("base64url")}`
}

/** The code exchange's `jti`, exactly as Google's page specifies: BASE64URL(SHA256(authorization code)). */
export function codeJti(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("base64url")
}

/** A refresh's `jti`: a unique per-request value, 128 random bits. */
export function refreshJti(): string {
  return randomBytes(16).toString("base64url")
}

/** The OAuth `state` value: 256 random bits, base64url. */
export function randomState(): string {
  return randomBytes(32).toString("base64url")
}

function base64url(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url")
}
