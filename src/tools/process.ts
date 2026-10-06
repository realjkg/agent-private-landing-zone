import { spawnSync } from "node:child_process";

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

  return {
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
}
