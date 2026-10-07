import {
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  resolve,
} from "node:path";

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
  safeName,
  workspaceFile,
} from "./safe-input.js";
import type {
  IaCAdapter,
} from "./types.js";
import {
  cloudformationAdapter,
} from "./cloudformation.js";

type CdkManifest = {
  artifacts?: Record<
    string,
    {
      type?: string;
      properties?: {
        templateFile?: string;
      };
    }
  >;
};

function blocked(
  reason: string,
): ToolResult {
  return {
    tool: "cdk_preview",
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    blocked: true,
    reason,
  };
}

function synthArgs(
  stack: string | undefined,
  output: string,
): string[] {
  const args = [
    "synth",
    "--quiet",
    "--no-lookups",
    "--path-metadata",
    "false",
    "--asset-metadata",
    "false",
    "--version-reporting",
    "false",
    "--output",
    output,
  ];

  if (stack) {
    args.push(stack);
  }

  return args;
}

function synthesizedTemplate(
  cwd: string,
  output: string,
  stack?: string,
): string {
  const manifestPath =
    resolve(cwd, output, "manifest.json");
  const manifest = JSON.parse(
    readFileSync(
      manifestPath,
      "utf8",
    ),
  ) as CdkManifest;

  const entries = Object.entries(
    manifest.artifacts ?? {},
  ).filter(
    ([, artifact]) =>
      artifact.type ===
        "aws:cloudformation:stack" &&
      artifact.properties?.templateFile,
  );

  const selected = stack
    ? entries.find(
        ([id]) => id === stack,
      )
    : entries.length === 1
      ? entries[0]
      : undefined;

  if (!selected) {
    throw new Error(
      stack
        ? "CDK stack was not found in the synthesized manifest."
        : "CDK synthesis produced zero or multiple stacks; specify input.stack.",
    );
  }

  const template =
    selected[1].properties
      ?.templateFile;

  if (!template) {
    throw new Error(
      "CDK synthesized template is missing.",
    );
  }

  return resolve(
    cwd,
    output,
    template,
  );
}

function synth(
  context: Parameters<
    IaCAdapter["version"]
  >[0],
  input?: AdapterInput,
): {
  result: ToolResult;
  output: string;
  template?: string;
} {
  const output =
    ".runs/cdk/synth";
  const absoluteOutput =
    resolve(context.cwd, output);

  rmSync(
    absoluteOutput,
    {
      recursive: true,
      force: true,
    },
  );
  mkdirSync(
    absoluteOutput,
    {
      recursive: true,
      mode: 0o700,
    },
  );

  const result =
    runAllowlistedProcess(
      "cdk_synth",
      "cdk",
      synthArgs(
        input?.stack,
        output,
      ),
      context.cwd,
    );

  if (!result.ok) {
    return { result, output };
  }

  return {
    result,
    output,
    template:
      synthesizedTemplate(
        context.cwd,
        output,
        input?.stack,
      ),
  };
}

export const cdkAdapter: IaCAdapter = {
  engine: "AWS_CDK",

  version(context) {
    return runAllowlistedProcess(
      "cdk_version",
      "cdk",
      ["--version"],
      context.cwd,
    );
  },

  validate(context, input) {
    if (
      context.allowProjectCodeExecution !==
      true
    ) {
      return [
        blocked(
          "CDK synthesis executes project code. Explicit project-code execution capability is required.",
        ),
      ];
    }

    const built =
      synth(context, input);

    if (!built.result.ok) {
      return [built.result];
    }

    const templatePath =
      built.template
        ? workspaceFile(
            context.cwd,
            built.template,
            "CDK synthesized template",
          )
        : undefined;

    return [
      built.result,
      ...cloudformationAdapter.validate(
        context,
        {
          ...input,
          templatePath,
        },
      ),
    ];
  },

  preview(context, input) {
    if (
      context.allowProjectCodeExecution !==
      true
    ) {
      return blocked(
        "CDK preview executes project code during synthesis. Explicit project-code execution capability is required.",
      );
    }

    if (
      context.allowCloudRead !== true
    ) {
      return blocked(
        "CDK preview requires explicit read-only AWS access.",
      );
    }

    if (
      context.allowPreviewWrite !== true
    ) {
      return blocked(
        "CDK preview uses a temporary CloudFormation Change Set and requires explicit preview-write capability.",
      );
    }

    const stackName =
      safeName(
        input?.stackName,
        "stackName",
      );

    const built =
      synth(context, input);

    if (!built.result.ok) {
      return built.result;
    }

    if (!built.template) {
      return blocked(
        "CDK synthesis did not produce a CloudFormation template.",
      );
    }

    return cloudformationAdapter.preview(
      context,
      {
        ...input,
        stackName,
        changeSetType: "UPDATE",
        templatePath:
          built.template,
      },
    );
  },
};
