// Bundled in place of node-fetch, which gaxios (google-auth-library's HTTP client) imports on Node: the runtime's own
// fetch, read at call time so a test's replacement is used. Bun never reaches it; gaxios uses Bun's fetch there.
const fetch = (...args) => globalThis.fetch(...args)
export default fetch
export const Headers = globalThis.Headers
export const Request = globalThis.Request
export const Response = globalThis.Response
