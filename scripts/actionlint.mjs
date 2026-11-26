// Run actionlint the way the CI job does, without making a clean clone install it by hand.
//
// If actionlint is already on PATH (as it is in CI), use it. Otherwise download the official pinned release from
// upstream, verify its SHA-256, cache it under the user's cache directory and run it. The upstream address and the
// checksum are the integrity check; no copy of the binary is kept in this repository.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const VERSION = "1.7.12"
const SUMS = {
  "darwin-amd64": "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
  "darwin-arm64": "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
  "freebsd-386": "7170cc3db006f83154583dc385c84bea3f6ee767a167bb9ca41de6593ebbb186",
  "freebsd-amd64": "3de1b027d0b749e81d6d972cbf5d14dc708a275248da1ba4eed4a9af707d1339",
  "linux-386": "72a44b32c2d032700e6d0c23ca2f540b67519ec68db098ddfcfa96059e61f723",
  "linux-amd64": "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
  "linux-arm64": "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
  "linux-armv6": "ae4a0a5227578e66f5d00ee02788d5c64fdae1fa6484ab88ceaeee9359c28fa4",
  "windows-386": "cdc8643b2c8dc890c76ad16095da97e75f86572805cc3573cc13f31ea0f19127",
  "windows-amd64": "6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9",
  "windows-arm64": "cadcf7ea4efe3a68728893813643cebe1185e5b1d4be5b96245f65c9a4d5ea41",
}
const PLATFORMS = { darwin: "darwin", linux: "linux", win32: "windows", freebsd: "freebsd" }
const ARCHES = { x64: "amd64", ia32: "386", arm64: "arm64", arm: "armv6" }
const args = process.argv.slice(2)

const onPath = spawnSync("actionlint", ["-version"], { stdio: "ignore" })
if (!onPath.error && onPath.status === 0) {
  const result = spawnSync("actionlint", args, { stdio: "inherit" })
  process.exit(result.status ?? 1)
}

const platform = PLATFORMS[process.platform]
const arch = ARCHES[process.arch]
if (platform === undefined || arch === undefined) {
  console.error(`actionlint: no pinned download for ${process.platform}/${process.arch}; install actionlint on PATH`)
  process.exit(1)
}
const asset = `actionlint_${VERSION}_${platform}_${arch}${process.platform === "win32" ? ".zip" : ".tar.gz"}`
const expected = SUMS[`${platform}-${arch}`]
if (expected === undefined) {
  console.error(`actionlint: no SHA-256 pin for ${asset}; install actionlint on PATH`)
  process.exit(1)
}

const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "actionlint", VERSION)
const binary = join(cache, process.platform === "win32" ? "actionlint.exe" : "actionlint")
if (!existsSync(binary)) {
  mkdirSync(cache, { recursive: true })
  const archive = join(cache, asset)
  const response = await fetch(`https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${asset}`)
  if (!response.ok) {
    console.error(`actionlint: download failed: ${response.status} ${response.statusText}`)
    process.exit(1)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (digest !== expected) {
    console.error(`actionlint: sha256 mismatch for ${asset}: got ${digest}, expected ${expected}`)
    process.exit(1)
  }
  writeFileSync(archive, bytes)
  const extract = spawnSync("tar", ["-xf", archive, "-C", cache], { stdio: "inherit" })
  rmSync(archive, { force: true })
  if (extract.status !== 0) {
    console.error(`actionlint: could not extract ${asset}`)
    process.exit(1)
  }
}

const result = spawnSync(binary, args, { stdio: "inherit" })
if (result.error) {
  console.error(`actionlint: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
