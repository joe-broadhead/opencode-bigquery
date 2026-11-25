// A source's own refusals, in the contract's form. A source read that fails is a refusal the register reports with the
// contract's table (contract §12): `CURSOR_INVALID` from a cursor another account issued, `SOURCE_UNKNOWN` from a name
// this plugin does not have, `TOO_LARGE` from a snapshot the `table` shape cannot carry.

import type { ErrorCode } from "@we-the-rebel-alliance/plugin-contract/events";
import { RegisterError, refusal } from "@we-the-rebel-alliance/plugin-contract/register";

/** A source refusal, thrown to the register. */
export function sourceError(code: ErrorCode, what: string, next: string): RegisterError {
  return new RegisterError(refusal(code, what, next));
}
