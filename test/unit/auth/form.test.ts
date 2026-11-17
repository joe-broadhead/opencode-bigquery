// The two-level form (design §3, §3.1, R2-M1, R3-L2): Read is the default and carries the disclosure verbatim; Read and
// write needs the acknowledgment; client precedence and the relay's hidden fields. No network.
import { describe, expect, it } from "vitest"
import { BigQueryError } from "../../../src/domain/errors.js"
import { DISCLOSURE, SCOPES, scopesFor } from "../../../src/domain/levels.js"
import { clientFromForm, clientFromOption, parseClientJson, resolveClient } from "../../../src/auth/client.js"
import { authorizationInstructions, integrationIdFor, integrationNames, readAnswer, redirectFor, signInForm, signInScopes, type StringField } from "../../../src/auth/form.js"

const CLIENT = { clientId: "invented.apps.googleusercontent.com", clientSecret: "GOCSPX-invented-client-secret" }

const field = (form: ReturnType<typeof signInForm>, key: string) => form.find((item) => item.key === key) as StringField

describe("the form", () => {
  it("offers Read as the default, with the disclosure and the pre-consent clause verbatim under it", () => {
    const form = signInForm("work", undefined)
    const access = field(form, "access")
    expect(access.default).toBe("read")
    const read = access.options!.find((option) => option.value === "read")!
    expect(read.label).toBe("Read")
    expect(read.description).toContain(DISCLOSURE.bound)
    expect(read.description).toContain(DISCLOSURE.formSuffix)
    expect(read.description).toContain(scopesFor("read").join(" "))
    expect(read.description).not.toContain(SCOPES.writeMarker)
  })

  it("shows and requests an account's extra scopes, such as drive.readonly for Drive external tables", () => {
    const drive = "https://www.googleapis.com/auth/drive.readonly"
    const form = signInForm("work", undefined, {}, [drive])
    const read = field(form, "access").options!.find((option) => option.value === "read")!
    expect(read.description).toContain(drive)
    expect(signInScopes("read", [drive])).toContain(drive)
    expect(authorizationInstructions("work", "read", [drive])).toContain(drive)
    // An extra that is already part of the level is not listed twice.
    expect(signInScopes("write", [SCOPES.writeMarker])).toEqual(scopesFor("write"))
  })

  it("offers Read and write with the marker and an unacknowledged, required checkbox", () => {
    const form = signInForm("work", undefined)
    const write = field(form, "access").options!.find((option) => option.value === "write")!
    expect(write.label).toBe("Read and write")
    expect(write.description).toContain(SCOPES.writeMarker)
    const confirm = form.find((item) => item.key === "confirmWrite")!
    expect(confirm.type).toBe("boolean")
    expect(confirm.required).toBe(true)
    expect(confirm.default).toBe(false)
    expect(confirm.when).toEqual([{ key: "access", op: "eq", value: "write" }])
  })

  it("hides a configured client's fields, and shows them for a one-time paste otherwise", () => {
    const open = signInForm("work", undefined)
    expect(field(open, "clientId").hidden).toBeUndefined()
    expect(field(open, "clientSecret").hidden).toBeUndefined()
    const configured = signInForm("work", CLIENT)
    expect(field(configured, "clientId")).toMatchObject({ hidden: true, default: CLIENT.clientId })
    expect(field(configured, "clientSecret")).toMatchObject({ hidden: true, default: CLIENT.clientSecret })
  })

  it("carries the host's hidden fields: the client JSON, the relay's redirect and callback port", () => {
    const form = signInForm("work", undefined, { redirectUri: "https://host.invalid/return", callbackPort: 4567 })
    expect(field(form, "clientJson")).toMatchObject({ hidden: true })
    expect(field(form, "redirectUri")).toMatchObject({ hidden: true, default: "https://host.invalid/return" })
    expect(form.find((item) => item.key === "callbackPort")).toMatchObject({ type: "integer", hidden: true, default: 4567, minimum: 1, maximum: 65_535 })
  })
})

describe("reading the answer", () => {
  it("signs in at Read for anything but an explicit, acknowledged write", () => {
    expect(readAnswer({}).level).toBe("read")
    expect(readAnswer({ access: "READ" }).level).toBe("read")
    expect(readAnswer({ access: "write", confirmWrite: true }).level).toBe("write")
  })

  it("refuses an unacknowledged write before any network call", () => {
    expect(() => readAnswer({ access: "write" })).toThrow(/^INPUT_INVALID: Read and write was chosen without the acknowledgment/)
    expect(() => readAnswer({ access: "write", confirmWrite: "true" })).toThrow(/^INPUT_INVALID/)
  })

  it("reads Google's installed and web client JSON, and the two visible fields", () => {
    expect(readAnswer({ clientJson: JSON.stringify({ installed: { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret } }) }).form).toEqual(CLIENT)
    expect(readAnswer({ clientJson: JSON.stringify({ web: { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret, redirect_uris: ["https://host.invalid/return"] } }) }).form).toEqual({ ...CLIENT, redirectUris: ["https://host.invalid/return"] })
    expect(readAnswer({ clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret }).form).toEqual(CLIENT)
    expect(readAnswer({}).form).toBeUndefined()
  })

  it("refuses a half client, a bad JSON and a bad redirect with INPUT_INVALID", () => {
    expect(() => readAnswer({ clientId: CLIENT.clientId })).toThrow(BigQueryError)
    expect(() => readAnswer({ clientJson: "not json" })).toThrow(/^INPUT_INVALID/)
    expect(() => readAnswer({ clientJson: JSON.stringify({ web: { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret } }) })).toThrow(/^INPUT_INVALID/)
    expect(() => readAnswer({ redirectUri: "https://host.invalid/return" })).toThrow(/^INPUT_INVALID/)
    expect(() => readAnswer({ callbackPort: 0 })).toThrow(/^INPUT_INVALID/)
  })

  it("does not read the hidden client fields when a client is configured", () => {
    const answer = readAnswer({ access: "read", clientId: CLIENT.clientId, clientSecret: "" }, { configuredClient: true })
    expect(answer.form).toBeUndefined()
    expect(redirectFor(answer, { callbackPort: 4567 }).port).toBe(4567)
  })
})

describe("the client precedence", () => {
  it("is account, then plugin, then the form, then a previous form sign-in", () => {
    const account = { client: { clientId: "account.apps.googleusercontent.com" }, source: "account" as const }
    const plugin = { client: { clientId: "plugin.apps.googleusercontent.com" }, source: "plugin" as const }
    const form = { client: CLIENT, source: "form" as const }
    const previous = { client: { clientId: "previous.apps.googleusercontent.com" }, source: "form" as const }
    expect(resolveClient({ account: account.client, plugin: plugin.client, form: form.client, previous })).toEqual(account)
    expect(resolveClient({ plugin: plugin.client, form: form.client, previous })).toEqual(plugin)
    expect(resolveClient({ form: form.client, previous })).toEqual(form)
    expect(resolveClient({ previous })).toEqual(previous)
    expect(resolveClient({ previous: { ...previous, source: "plugin" } })).toBeUndefined()
    expect(resolveClient({})).toBeUndefined()
  })

  it("reads the option's two shapes", () => {
    expect(clientFromOption({ clientId: CLIENT.clientId, clientSecret: CLIENT.clientSecret })).toEqual(CLIENT)
    expect(clientFromOption({ installed: { client_id: CLIENT.clientId, client_secret: CLIENT.clientSecret } })).toEqual(CLIENT)
    expect(clientFromOption(undefined)).toBeUndefined()
    expect(clientFromForm("", "")).toBeUndefined()
  })

  it("parses Google's downloaded JSON", () => {
    expect(parseClientJson(JSON.stringify({ installed: { client_id: CLIENT.clientId } }))).toEqual({ clientId: CLIENT.clientId })
    expect(() => parseClientJson("[]")).toThrow(/^INPUT_INVALID/)
  })
})

describe("the instructions and the integration ids", () => {
  it("names the level and the scopes Google will show", () => {
    expect(authorizationInstructions("work", "write")).toContain("Read and write")
    expect(authorizationInstructions("work", "write")).toContain(SCOPES.writeMarker)
    expect(authorizationInstructions("work", "read")).toContain("Read access")
    expect(authorizationInstructions("work", "read")).not.toContain(SCOPES.writeMarker)
  })

  it("names the integration bigquery-<alias>, and distinguishes several accounts", () => {
    expect(integrationIdFor("work")).toBe("bigquery-work")
    const names = integrationNames({ work: { mode: "interactive" }, ci: { mode: "adc" } })
    expect(names.get("work")).toBe("Google Cloud (BigQuery)")
    expect(names.get("ci")).toBeUndefined()
    expect(integrationNames({ work: { mode: "interactive" }, home: { mode: "interactive" } }).get("work")).toContain("work")
  })
})
