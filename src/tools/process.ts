import { spawnSync } from "node:child_process";

import {
  emitDebugDiagnostic,
} from "../debug/context.js";
import type { ToolResult } from "./types.js";

export function runAllowlistedProcess(
  tool: ToolResult["tool"],
  executable: string,
  args: string[],
  cwd: string,
): ToolResult {
  const startedAt = Date.now();

  const result = spawnSync(
    executable,
    args,
    {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      env: {
        ...process.env,
        CI: "1",
        TF_IN_AUTOMATION: "1",
      },
    },
  );

  const output: ToolResult = {
    tool,
    ok:
      result.status === 0 &&
      !result.error,
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr:
      (result.stderr ?? "") +
      (result.error
        ? "\n" + result.error.message
        : ""),
    durationMs:
      Date.now() - startedAt,
    command: [executable, ...args],
  };

  emitDebugDiagnostic({
    kind: "ADAPTER",
    component:
      "allowlisted-process",
    status: output.ok
      ? "OK"
      : "FAILED",
    durationMs:
      output.durationMs,
    detail: output.ok
      ? undefined
      : output.stderr,
    attributes: {
      tool,
      commandClass:
        executable,
      exitCode:
        output.exitCode,
      stdoutBytes:
        Buffer.byteLength(
          output.stdout,
        ),
      stderrBytes:
        Buffer.byteLength(
          output.stderr,
        ),
      stdoutExcerpt:
        output.stdout.slice(
          0,
          160,
        ),
      stderrExcerpt:
        output.stderr.slice(
          0,
          160,
        ),
    },
  });

  return output;
}
