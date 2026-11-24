/**
 * The plugin's tools, one spec each, in opencode-gws's pattern: a spec is the one definition of a tool, and it feeds
 * both the model's tool (`buildTool`) and, for a read, the scripts' tools RPC method (`scriptMethod`), so the two
 * cannot drift apart. A tool validates its input with its zod schema, asserts its action, runs, and returns
 * `{ output, content, metadata }`: Code Mode receives `output`; a direct call shows `content`, compact JSON cut at the
 * inline cap with a note to narrow the call. A plugin error reaches the model as a tool error with metadata
 * `{ code, next }`.
 */
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { JsonSchema, MethodClass, PluginMethod } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import * as z from "zod"
import { NAMESPACE } from "./constants.js"
import { BigQueryError } from "./domain/errors.js"

/** Inline cap for a direct call's text, in bytes. */
export const MAX_INLINE_BYTES = 100_000

/** One permission assert, as `ctx.permission.assert` takes it, without the call's own session, agent and source. */
export interface AssertRequest {
  readonly action: string
  readonly resources: readonly string[]
  /** The patterns "Always" saves; absent means the prompt offers no Always. */
  readonly save?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** The call a spec runs for, from the model's tool context or a script's RPC call. */
export interface Call {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
  /** `tool` for the model's tool, `rpc` for a script: a script cannot answer an ask. */
  readonly via: "tool" | "rpc"
  /** The resource the RPC resolved before dispatch (`<account>:<operation>`), when the method has a resolver. */
  readonly resource?: string
  /** The host's permission check, bound to this call's session, agent and source. Throws when denied or rejected. */
  readonly assert: (request: AssertRequest) => Promise<void>
}

export interface Outcome<O> {
  readonly output: O
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ToolSpec<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  /** The tool's name without the namespace; the model sees `bigquery_<name>`. */
  readonly name: string
  /** The permission action: `bigquery.<name>`. */
  readonly action: string
  /** True when the tool changes nothing anywhere: the declaration's `readOnly`. */
  readonly readOnly: boolean
  /** What the tool can do, in the source contract's classes. Only `read` tools become tools RPC methods. */
  readonly class: MethodClass
  readonly description: string
  readonly input: I
  readonly output: O
  /** The tools RPC resolver: the `<account>:<operation>` a script's call acts on. Reads only. */
  readonly resource?: (input: unknown) => string | null
  readonly resourceKind?: "read" | "any"
  run(input: z.output<I>, call: Call): Promise<Outcome<z.output<O>>>
}

export function parse<I extends z.ZodType>(schema: I, input: unknown): z.output<I> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  throw new BigQueryError(
    "INPUT_INVALID",
    `The input does not fit the tool's schema: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
  )
}

/** Compact JSON for a direct call, cut at the inline cap. */
export function render(output: unknown, maxBytes = MAX_INLINE_BYTES): { text: string; truncated: boolean } {
  const text = JSON.stringify(output) ?? ""
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return { text, truncated: false }
  const cut = Buffer.from(text).subarray(0, maxBytes).toString("utf8")
  return { text: `${cut}\n…[truncated: ${maxBytes} of ${bytes} bytes shown; narrow the call to see the rest]`, truncated: true }
}

/** The host's assert, as the specs see it. */
export type HostAssert = (request: {
  sessionID: string
  agent: string
  action: string
  resources: string[]
  save?: string[]
  metadata: Record<string, unknown>
  source: { type: "tool"; messageID: string; id: string }
}) => Promise<void>

type CallIdentity = { readonly sessionID: string; readonly agent: string; readonly messageID: string; readonly id: string; readonly signal: AbortSignal }

/** A call bound to the host's assert, with the tool source the tools RPC's hook recognises. */
export function bindCall(identity: CallIdentity, via: Call["via"], assert: HostAssert, resource?: string): Call {
  return {
    sessionID: identity.sessionID,
    agent: identity.agent,
    messageID: identity.messageID,
    id: identity.id,
    signal: identity.signal,
    via,
    ...(resource !== undefined ? { resource } : {}),
    assert: (request) =>
      assert({
        sessionID: identity.sessionID,
        agent: identity.agent,
        action: request.action,
        resources: [...request.resources],
        ...(request.save ? { save: [...request.save] } : {}),
        metadata: { ...request.metadata },
        source: { type: "tool", messageID: identity.messageID, id: identity.id },
      }),
  }
}

/** A plugin error as the model sees it; anything else (a host denial, a rejection) propagates untouched. */
function toolError(error: unknown): unknown {
  if (!(error instanceof BigQueryError)) return error
  return new ToolError({ message: error.message, metadata: { code: error.code, next: error.next } })
}

/** A spec as the model's tool, for `ctx.tool.transform`'s `editor.add`. */
export function buildTool(spec: ToolSpec, assert: HostAssert) {
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    options: { namespace: NAMESPACE, permission: spec.action, codemode: true },
    execute: async (raw: unknown, context: CallIdentity) => {
      try {
        const outcome = await spec.run(parse(spec.input, raw), bindCall(context, "tool", assert))
        const rendered = render(outcome.output)
        return { output: outcome.output, content: rendered.text, metadata: { ...outcome.metadata, ...(rendered.truncated ? { truncated: true } : {}) } }
      } catch (error) {
        throw toolError(error)
      }
    },
  }
}

/** A read spec as a tools RPC method: the same input check, the same asserts, the same run. */
export function scriptMethod(spec: ToolSpec, assert: HostAssert): PluginMethod {
  if (spec.class !== "read" || !spec.readOnly) throw new Error(`${spec.action} is not a read, so it is never a tools RPC method`)
  return {
    kind: "plugin",
    name: spec.name,
    action: spec.action,
    class: "read",
    description: spec.description,
    input: schemaOf(spec.input, "input"),
    output: schemaOf(spec.output, "output"),
    ...(spec.resource ? { resource: spec.resource, ...(spec.resourceKind ? { resourceKind: spec.resourceKind } : {}) } : {}),
    run: async (input, call) => (await spec.run(parse(spec.input, input), bindCall(call as CallIdentity, "rpc", assert, (call as { resource?: string }).resource))).output,
  }
}

function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema
  } catch {
    return { type: "object" }
  }
}
