import { operationGroups } from "./registry.js";
import { FAMILY_TITLES, type OperationSpec } from "./types.js";

/** One help line per command group, e.g. `./alz enterprise [list|<subcommand>] [args]`. */
export function groupHelpLines(catalog?: readonly OperationSpec[]): string[] {
  return [...operationGroups(catalog)].map(([group, specs]) =>
    "  ./alz " + group + " [list|<subcommand>] [args]  " + FAMILY_TITLES[specs[0].family] +
    " (" + specs.length + ")");
}

export type GroupResolution =
  | { kind: "list"; lines: string[] }
  | { kind: "run"; script: string; args: string[] }
  | { kind: "unknown-subcommand"; lines: string[] };

/**
 * Resolve `./alz <group> [subcommand] [args]` for a catalog command group.
 * Null means the first word is not a group.
 */
export function resolveGroupCommand(
  group: string,
  rest: string[],
  catalog?: readonly OperationSpec[],
): GroupResolution | null {
  const specs = operationGroups(catalog).get(group);
  if (!specs) return null;
  const lines = specs.map((spec) =>
    "  ./alz " + group + " " + spec.command!.sub + (spec.command!.args?.length ? " " + spec.command!.args.join(" ") : "") +
    "  " + spec.summary + " [" + spec.safety + "]");
  const [sub, ...args] = rest;
  if (sub === undefined || sub === "list") return { kind: "list", lines };
  const spec = specs.find((candidate) => candidate.command!.sub === sub);
  return spec ? { kind: "run", script: spec.cliScript!, args: [...(spec.command!.args ?? []), ...args] } : { kind: "unknown-subcommand", lines };
}
