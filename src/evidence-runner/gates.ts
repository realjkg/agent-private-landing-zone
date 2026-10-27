import { PRODUCTION_RELEASE_GATES, type ReleaseGate } from "../qualification/release-admission.js";

/**
 * How the runner relates to each production release gate (the PLAN on issue #39, section C).
 *
 * AUTO: an unattended read-only stage runs the existing producer. GUIDED: a person at the terminal runs the existing
 * `./alz apply` commands and types every phrase. OWNER: an owner-run step on another host or by hand. NO_PRODUCER: no
 * producer exists on main, so the runner reports the gate and writes nothing for it (delegated decision 4,
 * 6433391052). OUT_OF_SCOPE: the owner's release scope excludes the gate (config/release/scope.json).
 */
export type GateRunnerMode = "AUTO" | "GUIDED" | "OWNER" | "NO_PRODUCER" | "OUT_OF_SCOPE";
export type GatePlan = { id: string; mode: GateRunnerMode; slice?: string; note: string };

const NO_PRODUCER_PLAN = "A new PLAN names this gate's producer (delegated decision 4); the runner writes nothing for it.";

function planFor(gate: ReleaseGate): GatePlan {
  const { id } = gate;
  switch (gate.mode) {
    case "CI":
      return { id, mode: "NO_PRODUCER", note: "The producer is in open PR #274 and not on main yet. " + NO_PRODUCER_PLAN };
    case "SECURITY_SCAN":
    case "ISOLATED_RECOVERY":
    case "INDEPENDENT_REVIEW":
    case "LIVE_METRIC":
      return { id, mode: "NO_PRODUCER", note: NO_PRODUCER_PLAN };
    case "PRIVATE_MODEL":
      return { id, mode: "OWNER", note: "Run ./alz models verify --production on the target model host." };
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
      return id.startsWith("platform:") || id === "lifecycle:clean-install" || id === "lifecycle:uninstall"
        ? { id, mode: "NO_PRODUCER", note: "The producer is the lifecycle runner in open PR #281, run on each disposable host. " + NO_PRODUCER_PLAN }
        : { id, mode: "NO_PRODUCER", note: NO_PRODUCER_PLAN };
    default: {
      // A gate mode added later fails closed until someone maps it.
      const unmapped: never = gate.mode;
      return { id, mode: "NO_PRODUCER", note: "Unmapped gate mode " + String(unmapped) + ". " + NO_PRODUCER_PLAN };
    }
  }
}

/** One entry per production release gate, in registry order. A gate the owner's scope excludes is OUT_OF_SCOPE. */
export function gatePlan(outOfScope: ReadonlySet<string>, gates: readonly ReleaseGate[] = PRODUCTION_RELEASE_GATES): GatePlan[] {
  return gates.map((gate) => outOfScope.has(gate.id)
    ? { id: gate.id, mode: "OUT_OF_SCOPE", note: "Excluded by the owner's release scope (config/release/scope.json)." }
    : planFor(gate));
}
