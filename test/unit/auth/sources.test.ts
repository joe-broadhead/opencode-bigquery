// Two promises that a test can keep across every file package A owns: google-auth-library is reached only through the
// opt-in ADC path's dynamic import, so the plugin's start-up never loads it; and the auth code never calls Google's
// project-wide /revoke (design §3.1, §3.2).
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadAdcLibrary } from "../../../src/auth/adc-library.js"

const SRC = fileURLToPath(new URL("../../../src/auth", import.meta.url))

function sources(dir = SRC): { readonly path: string; readonly text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) ? [{ path: relative(SRC, path), text: readFileSync(path, "utf8") }] : []
  })
}

describe("the bundled ADC library", () => {
  it("is imported dynamically, by adc-library.ts alone, so start-up never evaluates it", () => {
    const importers = sources().filter((source) => /from\s+["']google-auth-library["']|import\(\s*["']google-auth-library["']\s*\)/.test(source.text))
    expect(importers.map((source) => source.path)).toEqual(["adc-library.ts"])
    expect(importers[0]!.text).toContain('await import("google-auth-library")')
    expect(importers[0]!.text).not.toMatch(/from\s+["']google-auth-library["']/)
  })

  it("loads the library when called", async () => {
    const library = await loadAdcLibrary()
    expect(typeof library.GoogleAuth).toBe("function")
    expect(typeof library.Impersonated).toBe("function")
  })
})

describe("revocation", () => {
  it("is never called from the auth code: Google's revocation is project-wide (design §3.1, R3-M1)", () => {
    for (const source of sources()) {
      expect(source.text, source.path).not.toContain("oauth2.googleapis.com/revoke")
      expect(source.text, source.path).not.toContain("accounts.google.com/o/oauth2/revoke")
      expect(source.text, source.path).not.toContain("REVOKE_ENDPOINTS")
    }
  })
})
