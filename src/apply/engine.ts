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
