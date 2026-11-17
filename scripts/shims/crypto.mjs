// Bundled for gaxios's `await import("crypto")`, a fallback it reaches only where globalThis.crypto is missing: a static
// import of the built-in instead, so the bundle makes no dynamic import.
export * from "node:crypto"
