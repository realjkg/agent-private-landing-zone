import {
  createChangeSet,
  type ChangeSet,
  type ResourceChange,
} from "./changeset.js";

const RECAP =
  /^([^\s:]+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)/gm;

export function normalizeAnsibleCheck(
  output: string,
): ChangeSet {
  const resources:
    ResourceChange[] = [];

  for (
    const match of
    output.matchAll(RECAP)
  ) {
    const host = match[1];
    const changed =
      Number(match[3]);
    const unreachable =
      Number(match[4]);
    const failed =
      Number(match[5]);

    resources.push({
      address:
        "ansible:host:" + host,
      type: "managed-host",
      operation:
        unreachable > 0 ||
        failed > 0
          ? "UNKNOWN"
          : changed > 0
            ? "UPDATE"
            : "SAME",
    });
  }

  if (resources.length === 0) {
    resources.push({
      address:
        "ansible:preview:unknown",
      type: "check-mode",
      operation: "UNKNOWN",
    });
  }

  return createChangeSet(
    "ANSIBLE",
    resources,
  );
}
