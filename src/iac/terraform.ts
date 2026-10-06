import type { IaCAdapter } from "./types.js";
import { runAllowlistedProcess } from "../tools/process.js";

export const terraformAdapter: IaCAdapter = {
  engine: "TERRAFORM",

  version(context) {
    return runAllowlistedProcess(
      "terraform_version",
      "terraform",
      ["version", "-json"],
      context.cwd,
    );
  },

  validate(context) {
    return [
      runAllowlistedProcess(
        "terraform_fmt_check",
        "terraform",
        ["fmt", "-check", "-recursive"],
        context.cwd,
      ),
      runAllowlistedProcess(
        "terraform_validate",
        "terraform",
        ["validate", "-json"],
        context.cwd,
      ),
    ];
  },

  preview(context) {
    return runAllowlistedProcess(
      "terraform_plan",
      "terraform",
      [
        "plan",
        "-input=false",
        "-lock=false",
        "-refresh=false",
        "-out=.agentic-preview.tfplan",
      ],
      context.cwd,
    );
  },
};
