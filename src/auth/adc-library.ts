// Package A: the bundled google-auth-library, for the opt-in `adc` mode only (design §3.2). It is loaded on first use,
// so the plugin's start-up never runs it. esbuild bundles it into dist/index.js (scripts/build.mjs): the package keeps
// no runtime dependency, and NOTICE carries its licences.
export async function loadAdcLibrary() {
  const { GoogleAuth, Impersonated } = await import("google-auth-library")
  return { GoogleAuth, Impersonated }
}
