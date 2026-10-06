import {
  randomUUID,
} from "node:crypto";

import {
  runAllowlistedProcess,
} from "../tools/process.js";
import type {
  ToolResult,
} from "../tools/types.js";
import {
  safeName,
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
    tool: "cloudformation_preview",
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    blocked: true,
    reason,
  };
}

function templateUri(
  path: string,
): string {
  return "file://" + path;
}

function parameterArgs(
  cwd: string,
  input?: AdapterInput,
): string[] {
  if (!input?.parametersPath) {
    return [];
  }

  return [
    "--parameters",
    templateUri(
      workspaceFile(
        cwd,
        input.parametersPath,
        "parametersPath",
      ),
    ),
  ];
}

export const cloudformationAdapter: IaCAdapter = {
  engine: "CLOUDFORMATION",

  version(context) {
    return runAllowlistedProcess(
      "cloudformation_version",
      "aws",
      ["--version"],
      context.cwd,
    );
  },

  validate(context, input) {
    const template =
      workspaceFile(
        context.cwd,
        input?.templatePath,
        "templatePath",
      );

    return [
      runAllowlistedProcess(
        "cloudformation_validate",
        "aws",
        [
          "cloudformation",
          "validate-template",
          "--template-body",
          templateUri(template),
          "--output",
          "json",
          "--query",
          "{Description:Description,Capabilities:Capabilities,CapabilitiesReason:CapabilitiesReason}",
        ],
        context.cwd,
      ),
    ];
  },

  preview(context, input) {
    if (
      context.allowPreviewWrite !== true
    ) {
      return blocked(
        "CloudFormation Change Sets are preview-control-plane writes and require explicit preview-write capability.",
      );
    }

    if (
      input?.changeSetType !== "UPDATE"
    ) {
      return blocked(
        "CloudFormation CREATE previews are not enabled because they create a REVIEW_IN_PROGRESS stack shell. Use UPDATE for existing stacks; greenfield remains Design-only until zero-residue preview is available.",
      );
    }

    const stackName =
      safeName(
        input.stackName,
        "stackName",
      );
    const template =
      workspaceFile(
        context.cwd,
        input.templatePath,
        "templatePath",
      );
    const changeSetName =
      "alz-preview-" +
      randomUUID()
        .replace(/-/g, "")
        .slice(0, 16);

    const args = [
      "cloudformation",
      "create-change-set",
      "--stack-name",
      stackName,
      "--change-set-name",
      changeSetName,
      "--change-set-type",
      "UPDATE",
      "--template-body",
      templateUri(template),
      ...parameterArgs(
        context.cwd,
        input,
      ),
    ];

    if (
      input.capabilities &&
      input.capabilities.length > 0
    ) {
      args.push(
        "--capabilities",
        ...input.capabilities,
      );
    }

    args.push(
      "--output",
      "json",
    );

    const create =
      runAllowlistedProcess(
        "cloudformation_preview",
        "aws",
        args,
        context.cwd,
      );

    if (!create.ok) {
      return create;
    }

    let changeSetId = "";

    try {
      const parsed =
        JSON.parse(create.stdout) as {
          Id?: string;
        };
      changeSetId = parsed.Id ?? "";
    } catch {
      return {
        ...create,
        ok: false,
        stderr:
          create.stderr +
          "\nCloudFormation create-change-set returned invalid JSON.",
      };
    }

    if (!changeSetId) {
      return {
        ...create,
        ok: false,
        stderr:
          create.stderr +
          "\nCloudFormation change-set ID is missing.",
      };
    }

    const wait =
      runAllowlistedProcess(
        "cloudformation_preview",
        "aws",
        [
          "cloudformation",
          "wait",
          "change-set-create-complete",
          "--change-set-name",
          changeSetId,
        ],
        context.cwd,
      );

    const describe =
      runAllowlistedProcess(
        "cloudformation_preview",
        "aws",
        [
          "cloudformation",
          "describe-change-set",
          "--change-set-name",
          changeSetId,
          "--no-include-property-values",
          "--no-paginate",
          "--output",
          "json",
          "--query",
          "{Status:Status,StatusReason:StatusReason,Changes:Changes[].{ResourceChange:{Action:ResourceChange.Action,LogicalResourceId:ResourceChange.LogicalResourceId,ResourceType:ResourceChange.ResourceType,Replacement:ResourceChange.Replacement}}}",
        ],
        context.cwd,
      );

    const cleanup =
      runAllowlistedProcess(
        "cloudformation_preview",
        "aws",
        [
          "cloudformation",
          "delete-change-set",
          "--change-set-name",
          changeSetId,
        ],
        context.cwd,
      );

    let noChanges = false;
    if (describe.ok) {
      try {
        const parsed =
          JSON.parse(describe.stdout) as {
            Status?: string;
            StatusReason?: string;
          };
        noChanges =
          parsed.Status === "FAILED" &&
          /didn.t contain changes|no changes/i.test(
            parsed.StatusReason ?? "",
          );
      } catch {
        noChanges = false;
      }
    }

    return {
      ...describe,
      ok:
        describe.ok &&
        cleanup.ok &&
        (wait.ok || noChanges),
      durationMs:
        create.durationMs +
        wait.durationMs +
        describe.durationMs +
        cleanup.durationMs,
      stderr: [
        create.stderr,
        wait.stderr,
        describe.stderr,
        cleanup.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
      command: [
        "aws",
        "cloudformation",
        "preview-update-change-set",
      ],
    };
  },
};
