import {
  readFileSync,
} from "node:fs";

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
    tool: "ansible_preview",
    ok: false,
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    blocked: true,
    reason,
  };
}

function playbookArgs(
  cwd: string,
  input?: AdapterInput,
): string[] {
  const args = [
    workspaceFile(
      cwd,
      input?.playbookPath,
      "playbookPath",
    ),
  ];

  if (input?.inventoryPath) {
    args.push(
      "--inventory",
      workspaceFile(
        cwd,
        input.inventoryPath,
        "inventoryPath",
      ),
    );
  }

  if (input?.limit) {
    args.push(
      "--limit",
      input.limit,
    );
  }

  return args;
}

export const ansibleAdapter: IaCAdapter = {
  engine: "ANSIBLE",

  version(context) {
    return runAllowlistedProcess(
      "ansible_version",
      "ansible-playbook",
      ["--version"],
      context.cwd,
    );
  },

  validate(context, input) {
    return [
      runAllowlistedProcess(
        "ansible_syntax_check",
        "ansible-playbook",
        [
          ...playbookArgs(
            context.cwd,
            input,
          ),
          "--syntax-check",
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
        "Ansible check mode loads playbook code and modules. Explicit project-code execution capability is required.",
      );
    }

    if (
      context.allowManagedAccess !== true
    ) {
      return blocked(
        "Ansible preview may connect to managed hosts. Explicit managed-host access is required.",
      );
    }

    const playbook =
      workspaceFile(
        context.cwd,
        input?.playbookPath,
        "playbookPath",
      );
    const source =
      readFileSync(
        playbook,
        "utf8",
      );

    if (
      /^\s*check_mode:\s*(false|no|off|0)\s*$/im.test(
        source,
      )
    ) {
      return blocked(
        "The playbook explicitly disables check mode. Preview is refused because tasks could execute normally.",
      );
    }

    return runAllowlistedProcess(
      "ansible_preview",
      "ansible-playbook",
      [
        ...playbookArgs(
          context.cwd,
          input,
        ),
        "--check",
        "--diff",
      ],
      context.cwd,
    );
  },
};
