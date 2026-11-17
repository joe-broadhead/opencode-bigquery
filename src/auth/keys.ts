/**
 * The DPoP key (design §3.2): a P-256 key generated at each sign-in, kept apart from OpenCode's credential store, in
 * the plugin's own state folder at 0600 inside a 0700 folder. Google binds the refresh token to it, so a copied
 * `auth.json` alone cannot mint tokens; the docs say a process running as the same user that reads both files is not
 * stopped.
 *
 * The key id is the RFC 7638 JWK thumbprint, so a stored sign-in record names exactly one key: a re-sign-in overwrites
 * `<alias>.jwk`, and the old record's `keyId` no longer matches anything, which is how the old refresh token becomes
 * unusable without ever calling Google's project-wide `/revoke` (design §3.1).
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface PublicJwk {
  readonly kty: "EC"
  readonly crv: "P-256"
  readonly x: string
  readonly y: string
}

export interface DpopKey {
  /** RFC 7638 thumbprint of the public key, base64url: the sign-in record's `keyId`. */
  readonly keyId: string
  /** The private JWK, with `d`. Never logged, never returned in a result, never put in a credential. */
  readonly jwk: PublicJwk & { readonly d: string }
}

/** The plugin's own state folder, as `src/wiring.ts` names it: `$XDG_STATE_HOME/opencode-bigquery`. */
export function stateDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "opencode-bigquery")
}

/** The folder the DPoP keys live in. Outside OpenCode's credential store, as the disclosure says. */
export const keysDirOf = (stateDir: string) => join(stateDir, "keys")

const KEY_VERSION = 1
const PART = /^[A-Za-z0-9_-]{43}$/
const ALIAS = /^[a-z][a-z0-9-]*$/

/** A new P-256 key. Its `keyId` is RFC 7638's thumbprint: the SHA-256 of the canonical public JWK. */
export function generateKey(): DpopKey {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const exported = privateKey.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string; y?: string; d?: string }
  if (exported.kty !== "EC" || exported.crv !== "P-256" || !exported.x || !exported.y || !exported.d) {
    throw new Error("the generated DPoP key did not export as a P-256 JWK")
  }
  const jwk = { kty: "EC" as const, crv: "P-256" as const, x: exported.x, y: exported.y, d: exported.d }
  return { keyId: thumbprint(jwk), jwk }
}

/** RFC 7638: SHA-256 over the required public members, in lexicographic order, base64url. */
export function thumbprint(jwk: PublicJwk): string {
  return createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url")
}

/** The public half, as a DPoP proof's header carries it. */
export function publicJwk(key: DpopKey): PublicJwk {
  return { kty: "EC", crv: "P-256", x: key.jwk.x, y: key.jwk.y }
}

/** `keys/<alias>.jwk`, the one path the design pins; the alias is validated, so it cannot leave the folder. */
export function keyPath(stateDir: string, alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`invalid account alias ${JSON.stringify(alias)}`)
  return join(keysDirOf(stateDir), `${alias}.jwk`)
}

/**
 * Writes the key with mode 0600 in a 0700 folder, atomically: a temporary file in the same folder, fsynced by rename.
 * The previous key at that path is replaced, which is deliberate (design §3.1): an old record's `keyId` stops matching.
 */
export function writeKey(stateDir: string, alias: string, key: DpopKey, deps: { readonly chmod?: typeof chmodSync; readonly writeFile?: typeof writeFileSync; readonly rename?: typeof renameSync; readonly mkdir?: typeof mkdirSync } = {}): void {
  const chmod = deps.chmod ?? chmodSync
  const writeFile = deps.writeFile ?? writeFileSync
  const rename = deps.rename ?? renameSync
  const mkdir = deps.mkdir ?? mkdirSync
  const dir = keysDirOf(stateDir)
  mkdir(stateDir, { recursive: true, mode: 0o700 })
  chmod(stateDir, 0o700)
  mkdir(dir, { recursive: true, mode: 0o700 })
  chmod(dir, 0o700)
  const temporary = join(dir, `.${alias}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    writeFile(temporary, `${JSON.stringify({ version: KEY_VERSION, kid: key.keyId, jwk: key.jwk })}\n`, { mode: 0o600, flag: "wx" })
    chmod(temporary, 0o600)
    rename(temporary, keyPath(stateDir, alias))
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  chmod(keyPath(stateDir, alias), 0o600)
}

/**
 * The key a record names, or undefined when the file is missing, malformed, or a different key (a re-sign-in happened
 * elsewhere). A refresh with the credential record but without this key cannot proceed (design §3.1, §14.1).
 */
export function readKey(stateDir: string, alias: string, keyId?: string): DpopKey | undefined {
  if (!ALIAS.test(alias)) return undefined
  const path = keyPath(stateDir, alias)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed["version"] !== KEY_VERSION || typeof parsed["kid"] !== "string") return undefined
  const jwk = parsed["jwk"]
  if (!isRecord(jwk) || jwk["kty"] !== "EC" || jwk["crv"] !== "P-256" || typeof jwk["x"] !== "string" || typeof jwk["y"] !== "string" || typeof jwk["d"] !== "string") return undefined
  if (!PART.test(jwk["x"]) || !PART.test(jwk["y"]) || !PART.test(jwk["d"])) return undefined
  const key: DpopKey = { keyId: parsed["kid"], jwk: { kty: "EC", crv: "P-256", x: jwk["x"], y: jwk["y"], d: jwk["d"] } }
  if (thumbprint(key.jwk) !== key.keyId) return undefined
  if (keyId !== undefined && keyId !== key.keyId) return undefined
  return key
}

/** Deletes the key, and only that file. Sign-out and a new sign-in both go through here; Google's `/revoke` is never called. */
export function deleteKey(stateDir: string, alias: string): boolean {
  if (!ALIAS.test(alias)) return false
  const path = keyPath(stateDir, alias)
  if (!existsSync(path)) return false
  // A symbolic link would make this delete a file outside the plugin's own folder; the plugin only writes regular files.
  if (!statSync(path).isFile()) return false
  rmSync(path, { force: true })
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
