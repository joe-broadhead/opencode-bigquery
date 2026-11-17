// Small assertions shared by package C's tests, so each test says what it means.
/** The NEEDS_PLAN reason a refusal carries, or undefined when it is not a NEEDS_PLAN. */
export function needsPlan(output: Record<string, unknown>): string | undefined {
  return output.error === "NEEDS_PLAN" ? (output.reason as string | undefined) : undefined
}
