import type { IaCAdapter } from "./types.js";
import { runAllowlistedProcess } from "../tools/process.js";

export const opentofuAdapter: IaCAdapter = {
  engine: "OPENTOFU",

  version(context) {
    return runAllowlistedProcess(
      "opentofu_version",
      "tofu",
      ["version", "-json"],
      context.cwd,
    );
  },

  validate(context) {
    return [
      runAllowlistedProcess(
        "opentofu_fmt_check",
        "tofu",
        ["fmt", "-check", "-recursive"],
        context.cwd,
      ),
      runAllowlistedProcess(
        "opentofu_validate",
        "tofu",
        ["validate", "-json"],
        context.cwd,
      ),
    ];
  },

  preview(context) {
    return runAllowlistedProcess(
      "opentofu_plan",
      "tofu",
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
