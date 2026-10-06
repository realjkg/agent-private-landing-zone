import type { IaCAdapter } from "./types.js";
import { runAllowlistedProcess } from "../tools/process.js";

export const pulumiAdapter: IaCAdapter = {
  engine: "PULUMI",

  version(context) {
    return runAllowlistedProcess(
      "pulumi_version",
      "pulumi",
      ["version"],
      context.cwd,
    );
  },

  validate(context) {
    return [
      runAllowlistedProcess(
        "pulumi_version",
        "pulumi",
        ["version"],
        context.cwd,
      ),
    ];
  },

  preview(context) {
    return runAllowlistedProcess(
      "pulumi_preview",
      "pulumi",
      [
        "preview",
        "--non-interactive",
        "--diff",
      ],
      context.cwd,
    );
  },
};
