import {
  runAllowlistedProcess,
} from "../tools/process.js";
import type {
  ToolResult,
} from "../tools/types.js";
import type {
  AdapterInput,
} from "./input.js";
import {
  workspaceFile,
} from "./safe-input.js";
import type {
  IaCAdapter,
} from "./types.js";

function blocked(
  reason: string,
): ToolResult {
  return {
    tool: "crossplane_preview",
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    blocked: true,
    reason,
  };
}

function renderArgs(
  cwd: string,
  input?: AdapterInput,
): string[] {
  return [
    "composition",
    "render",
    workspaceFile(
      cwd,
      input?.xrPath,
      "xrPath",
    ),
    workspaceFile(
      cwd,
      input?.compositionPath,
      "compositionPath",
    ),
    workspaceFile(
      cwd,
      input?.functionsPath,
      "functionsPath",
    ),
    "-a",
    "render.crossplane.io/runtime-docker-pull-policy=Never",
  ];
}

export const crossplaneAdapter: IaCAdapter = {
  engine: "CROSSPLANE",

  version(context) {
    return runAllowlistedProcess(
      "crossplane_version",
      "crossplane",
      ["version"],
      context.cwd,
    );
  },

  validate(context, input) {
    const extensions =
      workspaceFile(
        context.cwd,
        input?.extensionsPath,
        "extensionsPath",
      );
    const manifest =
      workspaceFile(
        context.cwd,
        input?.manifestPath,
        "manifestPath",
      );

    return [
      runAllowlistedProcess(
        "crossplane_validate",
        "crossplane",
        [
          "resource",
          "validate",
          extensions,
          manifest,
          "--output",
          "json",
        ],
        context.cwd,
      ),
    ];
  },

  preview(context, input) {
    if (
      context.allowProjectCodeExecution !==
      true
    ) {
      return blocked(
        "Crossplane render can execute composition functions. Explicit project-code execution capability is required.",
      );
    }

    return runAllowlistedProcess(
      "crossplane_preview",
      "crossplane",
      renderArgs(
        context.cwd,
        input,
      ),
      context.cwd,
    );
  },
};
