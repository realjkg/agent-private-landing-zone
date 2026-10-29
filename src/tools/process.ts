import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  emitDebugDiagnostic,
} from "../debug/context.js";
import { sanitizeDiagnosticText } from "../observability/redaction.js";
import {
  approvedToolDirs,
  buildChildEnvironment,
  type ChildEnvironment,
  redactSecrets,
  resolveExecutable,
} from "./child-env.js";
import { type ExecutionIdentity, isExecutionIdentity } from "./identity.js";
import { createChildSandbox } from "./private-workdir.js";
import { PROFILES, type ProcessProfile } from "./profiles.js";
import type { ToolResult } from "./types.js";

/**
 * The governed process runner (docs/runner-hardening.md).
 *
 * A tool runs with: an empty environment plus only what its profile allows
 * from an explicitly injected identity; an executable found in approved
 * directories rather than the inherited PATH; its own private HOME and
 * TMPDIR; a timeout and an output cap; no shell; and redacted diagnostics.
 * It cannot give a child anything the caller did not name, so the operator's
 * ambient credentials and configuration are unreachable.
 *
 * Not enforced here, because Node cannot: network confinement beyond refusing
 * unapproved endpoint overrides, and the number of processes a child may
 * start. Those belong to the container or host (see the doc).
 */
export type BoundedProcessOptions = {
  profile: ProcessProfile;
  /** The runner's own environment. Defaults to `process.env`; injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** Approved executable directories. Defaults to `approvedToolDirs(env)`. */
  toolDirs?: readonly string[];
  /** Which injected identity feeds the child. Defaults to DISCOVERY. */
  identity?: string;
  /** When set, `cwd` must stay inside it. */
  root?: string;
  /** Keep a failed run's stderr out of the debug diagnostic's detail (engines that can quote secrets). Default: unchanged. */
  suppressDetail?: boolean;
};

/**
 * A child that can be stopped while it runs. `stopWhen` is polled; true (or the
 * profile's time limit, or a SIGINT/SIGTERM sent to this process when
 * `forwardSignals` is set) sends the child SIGINT, its graceful stop (held
 * until `holdInterruptUntil` matches, when set), and SIGKILL to its process
 * group `graceMs` after the request. `stopped` is set once a stop
 * was requested, whatever exit code the child then reports.
 */
export type StoppableProcessOptions = BoundedProcessOptions & {
  stopWhen: () => boolean;
  pollMs?: number;
  graceMs?: number;
  forwardSignals?: boolean;
  /** Runs once, as soon as a stop is requested (kill switch, time limit or signal), before the grace period. A caller removes plaintext it no longer needs. */
  onStop?: () => void;
  /**
   * When set, the graceful stop (SIGINT) is held until a line of the child's stdout matches, for an engine that silently
   * drops an interrupt received before it can act on one (Terraform before its apply walk starts). The SIGKILL after
   * `graceMs` still counts from the stop request, whether or not the SIGINT was sent yet, so the bound is unchanged.
   */
  holdInterruptUntil?: RegExp;
};

/**
 * Every signal that means "stop": Ctrl-C, `kill`, the terminal closing (SIGHUP)
 * and Ctrl-\ (SIGQUIT). A stoppable child is detached into its own process
 * group, so none of them reaches it on its own; they are intercepted here.
 */
export const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/** The longest unfinished stdout line kept while a held stop waits for its readiness line. */
const READINESS_LINE_LIMIT = 4096;

let interceptors = 0;
/**
 * True while a run has taken over the stop signals (see `interceptStopSignals`).
 * A CLI's own handler must then leave the exit to that run, which stops its
 * engine, finalizes its evidence and ledger, and returns normally.
 */
export const stopSignalsIntercepted = (): boolean => interceptors > 0;

/** First in line, so the run hears a stop signal before any handler that ends the process. Returns the function that stops listening. */
export function interceptStopSignals(onSignal: () => void): () => void {
  interceptors += 1;
  for (const signal of STOP_SIGNALS) process.prependListener(signal, onSignal);
  let off = false;
  return () => {
    if (off) return;
    off = true;
    interceptors -= 1;
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  };
}

export type StoppableResult = ToolResult & { stopped: boolean; notStarted?: boolean };

/**
 * Node reads child output in chunks and checks `maxBuffer` afterwards, so a
 * capped child can still hand back up to one chunk more than the limit. The
 * cap is enforced here, on the bytes returned.
 */
function cap(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes
    ? { text, cut: false }
    : { text: bytes.subarray(0, maxBytes).toString("utf8"), cut: true };
}

function failure(
  tool: ToolResult["tool"],
  command: string[],
  reason: string,
  extra: Partial<ToolResult> = {},
): ToolResult {
  return {
    tool, ok: false, exitCode: null, stdout: "", stderr: reason, durationMs: 0, command, ...extra,
  };
}

type Prepared = {
  path: string; directory: string; command: string[]; profile: ProcessProfile;
  child: ChildEnvironment; sandbox: ReturnType<typeof createChildSandbox>;
};

/** Everything both runners check and build before a child exists: arguments, identity, directory, executable, environment. */
function prepare(
  tool: ToolResult["tool"],
  executable: string,
  args: string[],
  cwd: string,
  options: BoundedProcessOptions,
): Prepared | ToolResult {
  const command = [executable, ...args];
  const base = options.env ?? process.env;
  const profile = options.profile;

  if (!/^[A-Za-z0-9._-]+$/.test(executable) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    return failure(tool, command, "Executable or arguments rejected.", {
      blocked: true, reason: "Executable must be a bare name and arguments plain strings.",
    });
  }

  if (options.identity !== undefined && !isExecutionIdentity(options.identity)) {
    return failure(tool, command, "Unknown execution identity.", {
      blocked: true, reason: "Unknown execution identity. Only DISCOVERY, STATE, STATE_WRITE, APPLY and CHANGESET exist.",
    });
  }

  const directory = resolve(cwd);
  try {
    if (!statSync(directory).isDirectory()) throw new Error("not a directory");
  } catch {
    return failure(tool, command, "Working directory does not exist: " + directory);
  }
  if (options.root !== undefined) {
    const relation = relative(resolve(options.root), directory);
    if (relation === ".." || relation.startsWith(".." + sep)) {
      return failure(tool, command, "Working directory escapes the allowed root.", {
        blocked: true, reason: "Working directory escapes the allowed root.",
      });
    }
  }

  const dirs = options.toolDirs ?? approvedToolDirs(base);
  const path = resolveExecutable(executable, dirs);
  if (path === undefined) {
    return failure(tool, command,
      executable + " was not found in the approved tool directories (" + dirs.join(", ") +
      "). Install it there, or add its directory to ALZ_TOOL_DIRS.");
  }

  const sandbox = createChildSandbox();
  try {
    const child = buildChildEnvironment({
      profile, base, toolDirs: dirs, home: sandbox.home, tmp: sandbox.tmp, identity: options.identity,
    });
    return { path, directory, command, profile, child, sandbox };
  } catch (error) {
    sandbox.remove();
    throw error;
  }
}

/** Caps, redacts, classifies and reports one finished child. */
function conclude(
  tool: ToolResult["tool"],
  prepared: Prepared,
  startedAt: number,
  raw: { stdout: string; stderr: string; status: number | null; error?: Error },
  options: BoundedProcessOptions,
): ToolResult {
  const { command, profile, child } = prepared;
  const out = cap(raw.stdout, profile.maxOutputBytes);
  const err = cap(raw.stderr + (raw.error ? "\n" + raw.error.message : ""), profile.maxOutputBytes);
  const truncated = out.cut || err.cut || (raw.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
  const clean = (text: string) => redactSecrets(text, child.secretValues);
  const output: ToolResult = {
    tool,
    ok: raw.status === 0 && !raw.error,
    exitCode: raw.status,
    stdout: clean(out.text),
    stderr: clean(err.text),
    durationMs: Date.now() - startedAt,
    command,
    ...(truncated ? { truncated: true } : {}),
    ...(child.refused.length > 0 ? { refusedEnvironment: child.refused } : {}),
  };

  emitDebugDiagnostic({
    kind: "ADAPTER",
    component: "allowlisted-process",
    status: output.ok ? "OK" : "FAILED",
    durationMs: output.durationMs,
    detail: output.ok || options.suppressDetail ? undefined : sanitizeDiagnosticText(output.stderr),
    attributes: {
      tool,
      commandClass: command[0],
      exitCode: output.exitCode,
      stdoutBytes: Buffer.byteLength(output.stdout),
      stderrBytes: Buffer.byteLength(output.stderr),
      truncated,
      refusedEnvironmentCount: child.refused.length,
      // Plan, state and program output can carry secrets: engine tools never log excerpts.
      ...(profile.suppressExcerpts ? {} : {
        stdoutExcerpt: sanitizeDiagnosticText(output.stdout, 160),
        stderrExcerpt: sanitizeDiagnosticText(output.stderr, 160),
      }),
    },
  });
  return output;
}

export function runBoundedProcess(
  tool: ToolResult["tool"],
  executable: string,
  args: string[],
  cwd: string,
  options: BoundedProcessOptions,
): ToolResult {
  const startedAt = Date.now();
  const prepared = prepare(tool, executable, args, cwd, options);
  if ("tool" in prepared) return prepared;
  try {
    const result = spawnSync(prepared.path, args, {
      cwd: prepared.directory,
      encoding: "utf8",
      shell: false,
      timeout: prepared.profile.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: prepared.profile.maxOutputBytes,
      windowsHide: true,
      env: prepared.child.env,
    });
    return conclude(tool, prepared, startedAt, {
      stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status, error: result.error,
    }, options);
  } finally {
    prepared.sandbox.remove();
  }
}

/**
 * The names (never values) of identity variables the runner would refuse to
 * give a child with these options. Lets a caller fail closed before it commits
 * to a step that cannot be undone, using the runner's own environment rules.
 */
export function refusedVariables(options: Pick<BoundedProcessOptions, "profile" | "env" | "toolDirs" | "identity">): string[] {
  return buildChildEnvironment({
    profile: options.profile, base: options.env ?? process.env, toolDirs: options.toolDirs ?? [], home: "/", tmp: "/", identity: options.identity,
  }).refused;
}

/**
 * The same checks, environment and limits as `runBoundedProcess`, for a child
 * that must stay stoppable (a real apply). Output beyond the cap is dropped
 * rather than stopping the child: killing an apply for being chatty is worse
 * than losing its text, and the time limit still bounds the run.
 */
export function runStoppableProcess(
  tool: ToolResult["tool"],
  executable: string,
  args: string[],
  cwd: string,
  options: StoppableProcessOptions,
): Promise<StoppableResult> {
  const startedAt = Date.now();
  const prepared = prepare(tool, executable, args, cwd, options);
  if ("tool" in prepared) return Promise.resolve({ ...prepared, stopped: false });
  // The last look before the child exists.
  if (options.stopWhen()) {
    prepared.sandbox.remove();
    return Promise.resolve({ ...failure(tool, prepared.command, "Stopped before the process started."), stopped: true, notStarted: true });
  }
  const { profile } = prepared;
  return new Promise<StoppableResult>((resolveResult) => {
    const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
    const kept = { out: 0, err: 0 };
    let stopped = false;
    let finished = false;
    let hardKill: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;

    const child: ChildProcess = spawn(prepared.path, args, {
      cwd: prepared.directory, shell: false, windowsHide: true, env: prepared.child.env,
      // Its own process group, so the final kill reaches the providers terraform started.
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = (signal: NodeJS.Signals, group: boolean): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, signal); else child.kill(signal);
      } catch { /* already gone */ }
    };
    // Whether the child can act on SIGINT now; until then a requested stop waits for `holdInterruptUntil` to match.
    let interruptible = options.holdInterruptUntil === undefined;
    const requestStop = (): void => {
      if (stopped || finished) return;
      stopped = true;
      try { options.onStop?.(); } catch { /* a failing remover must not keep the engine from being told to stop */ }
      if (interruptible) kill("SIGINT", false);
      hardKill = setTimeout(() => kill("SIGKILL", true), options.graceMs ?? 60_000);
    };
    if (options.holdInterruptUntil !== undefined) {
      const ready = options.holdInterruptUntil;
      const decoder = new StringDecoder("utf8");
      let partial = "";
      const watch = (data: Buffer): void => {
        if (interruptible) return;
        const lines = (partial + decoder.write(data)).split("\n");
        // The unfinished last line is kept for the next chunk, bounded: a readiness line is short.
        partial = (lines.pop() ?? "").slice(-READINESS_LINE_LIMIT);
        if (!lines.some((line) => ready.test(line))) return;
        interruptible = true;
        partial = "";
        child.stdout?.off("data", watch);
        // A stop that was held is delivered now, exactly once.
        if (stopped && !finished) kill("SIGINT", false);
      };
      child.stdout?.on("data", watch);
    }
    const keep = (which: "out" | "err") => (data: Buffer): void => {
      // One byte past the cap is enough for `cap` to see the output was cut.
      const room = profile.maxOutputBytes + 1 - kept[which];
      if (room <= 0) return;
      const part = data.length > room ? data.subarray(0, room) : data;
      chunks[which].push(part);
      kept[which] += part.length;
    };
    child.stdout?.on("data", keep("out"));
    child.stderr?.on("data", keep("err"));

    const poll = setInterval(() => { if (options.stopWhen()) requestStop(); }, options.pollMs ?? 1000);
    const deadline = setTimeout(requestStop, profile.timeoutMs);
    const stopListening = options.forwardSignals ? interceptStopSignals(requestStop) : () => undefined;

    const finish = (status: number | null): void => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(deadline);
      if (hardKill) clearTimeout(hardKill);
      stopListening();
      try {
        const result = conclude(tool, prepared, startedAt, {
          stdout: Buffer.concat(chunks.out).toString("utf8"), stderr: Buffer.concat(chunks.err).toString("utf8"),
          status, error: spawnError,
        }, options);
        resolveResult({ ...result, stopped });
      } finally {
        prepared.sandbox.remove();
      }
    };
    child.on("error", (error) => { spawnError = error; if (child.pid === undefined) finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/**
 * Runs one of the executables the broker's adapters use, under its profile.
 * An executable with no profile is refused: adding a tool means writing its
 * profile, which is where its permitted environment and hosts are decided.
 */
export function runAllowlistedProcess(
  tool: ToolResult["tool"],
  executable: string,
  args: string[],
  cwd: string,
  identity?: ExecutionIdentity,
): ToolResult {
  const profile = PROFILES[executable];
  if (profile === undefined) {
    return failure(tool, [executable, ...args], "Executable has no process profile.", {
      blocked: true, reason: "Executable has no process profile.",
    });
  }
  return runBoundedProcess(tool, executable, args, cwd, { profile, identity });
}
