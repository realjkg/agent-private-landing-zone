import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import {
  tmpdir,
} from "node:os";
import {
  join,
} from "node:path";

import {
  runAllowlistedProcess,
} from "../tools/process.js";
import type {
  ToolResult,
} from "../tools/types.js";
import {
  workspaceFile,
} from "./safe-input.js";
import type {
  AdapterInput,
} from "./input.js";
import type {
  IaCAdapter,
} from "./types.js";

function blocked(
  reason: string,
): ToolResult {
  return {
    tool: "bicep_what_if",
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    blocked: true,
    reason,
  };
}

function required(
  value: string | undefined,
  label: string,
): string {
  if (!value) {
    throw new Error(
      label + " is required.",
    );
  }

  return value;
}

function whatIfArgs(
  contextCwd: string,
  input?: AdapterInput,
): string[] {
  const file =
    workspaceFile(
      contextCwd,
      input?.bicepFile,
      "bicepFile",
    );
  const scope =
    input?.azureScope;

  if (!scope) {
    throw new Error(
      "azureScope is required.",
    );
  }

  const args = [
    "deployment",
    scope === "resource-group"
      ? "group"
      : scope === "subscription"
        ? "sub"
        : scope === "management-group"
          ? "mg"
          : "tenant",
    "what-if",
  ];

  if (scope === "resource-group") {
    args.push(
      "--resource-group",
      required(
        input?.resourceGroup,
        "resourceGroup",
      ),
    );
  } else {
    args.push(
      "--location",
      required(
        input?.location,
        "location",
      ),
    );
  }

  if (
    scope === "management-group"
  ) {
    args.push(
      "--management-group-id",
      required(
        input?.managementGroupId,
        "managementGroupId",
      ),
    );
  }

  if (input?.deploymentName) {
    args.push(
      "--name",
      input.deploymentName,
    );
  }

  args.push(
    "--template-file",
    file,
    "--result-format",
    "ResourceIdOnly",
    "--validation-level",
    "ProviderNoRbac",
    "--no-pretty-print",
    "--no-prompt",
    "true",
    "--only-show-errors",
    "--output",
    "json",
  );

  if (input?.parametersPath) {
    args.push(
      "--parameters",
      "@" +
        workspaceFile(
          contextCwd,
          input.parametersPath,
          "parametersPath",
        ),
    );
  }

  return args;
}

export const bicepAdapter: IaCAdapter = {
  engine: "BICEP",

  version(context) {
    return runAllowlistedProcess(
      "bicep_version",
      "bicep",
      ["--version"],
      context.cwd,
    );
  },

  validate(context, input) {
    const file =
      workspaceFile(
        context.cwd,
        input?.bicepFile,
        "bicepFile",
      );

    const lint =
      runAllowlistedProcess(
        "bicep_lint",
        "bicep",
        [
          "lint",
          file,
          "--no-restore",
        ],
        context.cwd,
      );

    const temp =
      mkdtempSync(
        join(
          tmpdir(),
          "alz-bicep-",
        ),
      );

    const output =
      join(
        temp,
        "compiled.json",
      );

    const build =
      runAllowlistedProcess(
        "bicep_build",
        "bicep",
        [
          "build",
          file,
          "--no-restore",
          "--outfile",
          output,
        ],
        context.cwd,
      );

    rmSync(
      temp,
      {
        recursive: true,
        force: true,
      },
    );

    return [lint, build];
  },

  preview(context, input) {
    if (!context.allowCloudRead) {
      return blocked(
        "Bicep what-if requires explicit read-only Azure access.",
      );
    }

    return runAllowlistedProcess(
      "bicep_what_if",
      "az",
      whatIfArgs(
        context.cwd,
        input,
      ),
      context.cwd,
    );
  },
};
