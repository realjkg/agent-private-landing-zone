import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

import {
  emitDebugDiagnostic,
} from "../debug/context.js";
import { sanitizeDiagnosticText } from "../observability/redaction.js";
import {
  approvedToolDirs,
  buildChildEnvironment,
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
};

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

export function runBoundedProcess(
  tool: ToolResult["tool"],
  executable: string,
  args: string[],
  cwd: string,
  options: BoundedProcessOptions,
): ToolResult {
  const startedAt = Date.now();
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
      blocked: true, reason: "Unknown execution identity. Only DISCOVERY and STATE exist.",
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
    const result = spawnSync(path, args, {
      cwd: directory,
      encoding: "utf8",
      shell: false,
      timeout: profile.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: profile.maxOutputBytes,
      windowsHide: true,
      env: child.env,
    });

    const out = cap(result.stdout ?? "", profile.maxOutputBytes);
    const err = cap((result.stderr ?? "") + (result.error ? "\n" + result.error.message : ""), profile.maxOutputBytes);
    const truncated = out.cut || err.cut ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS";
    const clean = (text: string) => redactSecrets(text, child.secretValues);
    const output: ToolResult = {
      tool,
      ok: result.status === 0 && !result.error,
      exitCode: result.status,
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
      detail: output.ok ? undefined : sanitizeDiagnosticText(output.stderr),
      attributes: {
        tool,
        commandClass: executable,
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
  } finally {
    sandbox.remove();
  }
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
