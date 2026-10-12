import { ANY_IDENTITY_VARIABLE } from "../tools/identity.js";
import type { ToolResult } from "../tools/types.js";

/**
 * How an engine step ends the run with a code (never engine output, which can
 * quote plan or state values). Engine specs (`engine-spec.ts`) throw these; the
 * driver and sealing report only the code.
 */
class EngineStop extends Error {
  constructor(readonly code: string) { super(code); }
}
export const stop = (code: string): never => { throw new EngineStop(code); };

/** The code in a thrown error: ours, or one the preview adapter's shared helpers throw. Anything else is UNEXPECTED. */
export function codeOf(error: unknown): string {
  if (error instanceof EngineStop) return error.code;
  const adapter = error instanceof Error ? /^TERRAFORM_ADAPTER:(.+)$/.exec(error.message) : null;
  return adapter ? adapter[1] : "UNEXPECTED";
}

/** A step that needs no credentials is given none. */
export const withoutIdentities = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !ANY_IDENTITY_VARIABLE.test(key)));

/** A result a step can be judged by. A credential the runner refused (a newline, an unapproved host) would otherwise mean a run with no identity. */
export function assertUsable(result: ToolResult): void {
  if (result.refusedEnvironment?.length) stop("ENVIRONMENT_REFUSED");
  if (result.truncated) stop("OUTPUT_TRUNCATED");
}

/** The stdout of a step that succeeded; any refusal, truncation or non-zero exit stops with a code. */
export function checkedOutput(result: ToolResult): string {
  assertUsable(result);
  return result.ok ? result.stdout : stop(result.exitCode === null ? "NOT_RUN" : "EXIT_" + result.exitCode);
}
