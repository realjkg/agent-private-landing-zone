import type { EngineApplyRun, EngineCleanupRun, EngineSpec } from "../../src/apply/engine-spec.js";

/**
 * TEST FIXTURE (docs/act-pilot-gcp-api-driver.md, D5): turns a synchronous engine into one whose read steps return promises, as an
 * engine that reads the cloud over HTTPS would. Each wrapped step first yields to the event loop (so a signal or anything else
 * queued can run), then calls the hook for that step, logs it, and runs the engine's own step. The engine object is patched in
 * place for `body` only and restored afterward, whatever happens. Nothing in src/ can reach this.
 */
export type AsyncStep = "plan" | "qualify" | "prepare" | "rederive" | "execute" | "cleanupPrepare" | "planDestroy" | "cleanupExecute";
export type AsyncHooks = Partial<Record<AsyncStep, () => void | Promise<void>>>;

const yieldOnce = (): Promise<void> => new Promise((done) => setImmediate(done));

export async function withAsyncSteps<T>(engine: EngineSpec, hooks: AsyncHooks, body: (log: AsyncStep[]) => Promise<T>,
  extra: { qualify?: EngineSpec["qualify"] } = {}): Promise<T> {
  const log: AsyncStep[] = [];
  const target = engine as { -readonly [K in keyof EngineSpec]: EngineSpec[K] };
  const original = { plan: target.plan, qualify: target.qualify, openApply: target.openApply, openCleanup: target.openCleanup };
  const step = async <R>(name: AsyncStep, run: () => R | Promise<R>): Promise<R> => {
    await yieldOnce();
    await hooks[name]?.();
    log.push(name);
    return await run();
  };
  target.plan = (input) => step("plan", () => original.plan.call(engine, input));
  if (extra.qualify) {
    const qualify = extra.qualify;
    target.qualify = (input) => step("qualify", () => qualify(input));
  }
  target.openApply = (input) => {
    const run = original.openApply.call(engine, input);
    const wrapped: EngineApplyRun = {
      ...run,
      prepare: (snapshotPath) => step("prepare", () => run.prepare(snapshotPath)),
      rederive: (artifact) => step("rederive", () => run.rederive(artifact)),
      execute: (artifact, control) => step("execute", () => run.execute(artifact, control)),
    };
    return wrapped;
  };
  if (original.openCleanup) {
    const openCleanup = original.openCleanup;
    target.openCleanup = (input) => {
      const run = openCleanup.call(engine, input);
      const wrapped: EngineCleanupRun = {
        ...run,
        prepare: (snapshotPath) => step("cleanupPrepare", () => run.prepare(snapshotPath)),
        planDestroy: (addresses) => step("planDestroy", () => run.planDestroy(addresses)),
        execute: (control) => step("cleanupExecute", () => run.execute(control)),
      };
      return wrapped;
    };
  }
  try {
    return await body(log);
  } finally {
    target.plan = original.plan;
    target.openApply = original.openApply;
    target.openCleanup = original.openCleanup;
    if (original.qualify === undefined) delete target.qualify; else target.qualify = original.qualify;
  }
}

/** A stop signal as the driver sees one: its interceptor is a listener on the process, so emitting the event reaches it. */
export const signalNow = (signal: "SIGINT" | "SIGTERM" = "SIGINT"): void => { process.emit(signal as never); };
