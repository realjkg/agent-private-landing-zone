import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How the runner relates to each production release gate (the PLAN on issue #39, section C).
 *
 * AUTO: an unattended read-only stage runs the existing producer. GUIDED: a person at the terminal runs the existing
 * `./alz apply` commands and types every phrase. OWNER: an owner-run step on another host or by hand. NO_PRODUCER: no
 * producer exists on main, so the runner reports the gate and writes nothing for it (delegated decision 4,
 * 6433391052). OUT_OF_SCOPE: the owner's release scope excludes the gate (config/release/scope.json).
 *
 * The runner never imports the gate registry (`src/qualification/release-admission.ts`), because that module loads the
 * pilot apply path. It reads the gate ids from `config/release/status.json`, whose own check requires every registry gate
 * once, in admission order, and derives each gate's mode from its id here. `test/evidence-preflight.test.ts` pins both
 * against the registry, so a gate added there without a mapping here fails a test, and an unknown id fails closed.
 */
export type GateMode =
  | "CI" | "PRIVATE_MODEL" | "LIVE_PROVIDER" | "LIVE_PREVIEW" | "ISOLATED_RECOVERY" | "LIFECYCLE" | "SECURITY_SCAN" | "LIVE_METRIC"
  | "LIVE_ACT" | "ACT_RECOVERY" | "INDEPENDENT_REVIEW" | "UNKNOWN";
export type GateRunnerMode = "AUTO" | "GUIDED" | "OWNER" | "NO_PRODUCER" | "OUT_OF_SCOPE";
export type GatePlan = { id: string; mode: GateRunnerMode; slice?: string; note: string };

const FIXED: Readonly<Record<string, GateMode>> = {
  "source-ci": "CI", "release-archive": "CI", "arm64-final-image": "SECURITY_SCAN", "private-model-runtime": "PRIVATE_MODEL",
  "aws-provider": "LIVE_PROVIDER", "azure-provider": "LIVE_PROVIDER", "isolated-recovery": "ISOLATED_RECOVERY",
  "act-run-recovery": "ACT_RECOVERY", "security-review:independent": "INDEPENDENT_REVIEW",
};
const PREFIXED: readonly [string, GateMode][] = [
  ["preview:", "LIVE_PREVIEW"], ["lifecycle:", "LIFECYCLE"], ["platform:", "LIFECYCLE"], ["act:", "LIVE_ACT"], ["pillar:", "LIVE_METRIC"],
];

/** The release gate mode an id names, by the registry's naming. UNKNOWN for an id this table does not know. */
export function gateModeOf(id: string): GateMode {
  if (Object.hasOwn(FIXED, id)) return FIXED[id];
  return PREFIXED.find(([prefix]) => id.startsWith(prefix))?.[1] ?? "UNKNOWN";
}

const NO_PRODUCER_PLAN = "A new PLAN names this gate's producer (delegated decision 4); the runner writes nothing for it.";

function planFor(id: string): GatePlan {
  const mode = gateModeOf(id);
  switch (mode) {
    case "CI":
      return { id, mode: "NO_PRODUCER", note: "The producer is in open PR #274 and not on main yet. " + NO_PRODUCER_PLAN };
    case "SECURITY_SCAN":
    case "ISOLATED_RECOVERY":
    case "INDEPENDENT_REVIEW":
    case "LIVE_METRIC":
      return { id, mode: "NO_PRODUCER", note: NO_PRODUCER_PLAN };
    case "PRIVATE_MODEL":
      return { id, mode: "OWNER", note: "Run ./alz models verify --production on the target model host. In this build the runner has no model stage; a later slice may add one for the model host." };
    case "LIVE_PROVIDER":
      return id === "aws-provider"
        ? { id, mode: "AUTO", slice: "S2", note: "Needs the federated qualification identity and the owner's no-op stack; BLOCKED until both exist." }
        : { id, mode: "AUTO", slice: "S3", note: "Needs the federated qualification identity; BLOCKED until it exists." };
    case "LIVE_PREVIEW":
      return { id, mode: "GUIDED", slice: "S5", note: "Produced at seal after the owner's reviewed pin (owner input); only for the pinned path." };
    case "LIVE_ACT":
      return id === "act:aws-cdk"
        ? { id, mode: "GUIDED", slice: "S5", note: "CDK_CLEANUP_NOT_IMPLEMENTED until the CDK cleanup slices land; only for the pinned path." }
        : { id, mode: "GUIDED", slice: "S5", note: "A person runs the DEV apply after the owner's pin; only for the pinned path." };
    case "ACT_RECOVERY":
      return { id, mode: "GUIDED", slice: "S5", note: "Optional recovery stage after the pin (./alz apply record-recovery)." };
    case "LIFECYCLE":
      return id.startsWith("platform:")
        ? { id, mode: "OWNER", note: "The owner runs ./alz lifecycle on a disposable host of this platform; the runner does not ingest its report yet." }
        : { id, mode: "NO_PRODUCER", note: NO_PRODUCER_PLAN };
    case "UNKNOWN":
      return { id, mode: "NO_PRODUCER", note: "Unmapped gate id. " + NO_PRODUCER_PLAN };
  }
}

/** One entry per gate id, in the given order. A gate the owner's scope excludes is OUT_OF_SCOPE. */
export function gatePlan(ids: readonly string[], outOfScope: ReadonlySet<string>): GatePlan[] {
  return ids.map((id) => outOfScope.has(id)
    ? { id, mode: "OUT_OF_SCOPE", note: "Excluded by the owner's release scope (config/release/scope.json)." }
    : planFor(id));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The release gate ids (config/release/status.json) and the scope's exclusions (config/release/scope.json), read as data. */
export function releaseGates(root: string): { ids: string[]; outOfScope: Set<string> } {
  const read = (name: string): unknown => JSON.parse(readFileSync(join(root, "config", "release", name), "utf8")) as unknown;
  const status = read("status.json");
  const scope = read("scope.json");
  if (!isRecord(status) || !Array.isArray(status.gates) || !isRecord(scope) || !Array.isArray(scope.outOfScope)) {
    throw new Error("config/release/status.json or scope.json is not in the expected shape.");
  }
  const ids = status.gates.map((entry) => isRecord(entry) && typeof entry.gate === "string" ? entry.gate : "");
  if (ids.some((id) => id === "")) throw new Error("config/release/status.json names a gate without an id.");
  return { ids, outOfScope: new Set(scope.outOfScope.flatMap((entry) => isRecord(entry) && typeof entry.gate === "string" ? [entry.gate] : [])) };
}
