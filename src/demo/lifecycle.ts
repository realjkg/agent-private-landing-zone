import { createHash } from "node:crypto";
import type { AgentState } from "../agent/types.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** An in-memory teaching model. Never an apply driver or live approval record. */
export class DemoLifecycle {
  readonly plan: Readonly<{
    kind: "SYNTHETIC_DEMO_ACT_PLAN_V1";
    provider: string;
    engine: string;
    designHash: string;
    baseline: readonly string[];
    additions: readonly string[];
  }>;
  readonly planHash: string;
  readonly cleanupHash: string;
  private phase: "PLANNED" | "BUILT" | "DESTROYED" = "PLANNED";
  private buildApproved = false;
  private cleanupApproved = false;
  private inventory: Set<string>;
  private events: string[] = ["DISCOVER_SIMULATED", "PLAN_SIMULATED"];

  constructor(state: AgentState) {
    if (!state.mock || !["brownfield", "greenfield"].includes(state.mock) ||
      !state.environment || state.environment.classification === "UNKNOWN" ||
      !state.design || state.design.status === "BLOCKED" ||
      !state.design.plugin.buildEligible || state.error || state.phase === "FAILED" ||
      state.phase === "BLOCKED" || state.environment.conflicts.length > 0) {
      throw new Error("DEMO_ACT_BLOCKED: a known, eligible fixture design is required.");
    }
    const baseline = state.environment.resources.map((resource) => resource.resourceId).sort();
    const additions = [`demo://${state.provider.toLowerCase()}/canary`];
    if (new Set(baseline).size !== baseline.length || additions.some((id) => baseline.includes(id))) {
      throw new Error("DEMO_ACT_OWNERSHIP_CONFLICT");
    }
    this.plan = Object.freeze({
      kind: "SYNTHETIC_DEMO_ACT_PLAN_V1", provider: state.provider, engine: state.engine,
      designHash: state.design.designHash,
      baseline: Object.freeze(baseline), additions: Object.freeze(additions),
    });
    this.planHash = digest(this.plan);
    this.cleanupHash = digest({ kind: "SYNTHETIC_DEMO_CLEANUP_V1", planHash: this.planHash, remove: additions });
    this.inventory = new Set(baseline);
  }

  approveBuild(planHash: string): void {
    if (this.phase !== "PLANNED" || planHash !== this.planHash) throw new Error("DEMO_APPROVAL_MISMATCH");
    this.buildApproved = true;
    this.events.push("BUILD_APPROVAL_SIMULATED");
  }

  build(): void {
    if (!this.buildApproved || this.phase !== "PLANNED") throw new Error("DEMO_BUILD_NOT_APPROVED");
    for (const id of this.plan.additions) this.inventory.add(id);
    this.phase = "BUILT";
    this.events.push("ACT_BUILD_SIMULATED", "VERIFY_BUILD_SIMULATED");
  }

  approveCleanup(cleanupHash: string): void {
    if (this.phase !== "BUILT" || cleanupHash !== this.cleanupHash) throw new Error("DEMO_CLEANUP_APPROVAL_MISMATCH");
    this.cleanupApproved = true;
    this.events.push("CLEANUP_APPROVAL_SIMULATED");
  }

  destroy(): void {
    if (!this.cleanupApproved || this.phase !== "BUILT") throw new Error("DEMO_CLEANUP_NOT_APPROVED");
    for (const id of this.plan.additions) this.inventory.delete(id);
    this.phase = "DESTROYED";
    this.events.push("ACT_DESTROY_SIMULATED", "VERIFY_CLEANUP_SIMULATED");
  }

  evidence() {
    const inventory = [...this.inventory].sort();
    return {
      kind: "SYNTHETIC_DEMO_ACT_EVIDENCE_V1" as const,
      evidenceBasis: "IN_MEMORY_SIMULATION" as const,
      liveActEnabled: false as const, cloudMutation: false as const, liveQualification: false as const,
      phase: this.phase, plan: this.plan, planHash: this.planHash, cleanupHash: this.cleanupHash,
      events: [...this.events], inventory,
      baselinePreserved: this.plan.baseline.every((id) => this.inventory.has(id)),
      demoResourcesRemaining: this.plan.additions.filter((id) => this.inventory.has(id)),
      cleanupVerified: this.phase === "DESTROYED" && digest(inventory) === digest(this.plan.baseline),
    };
  }
}

export function rehearseDemoAct(state: AgentState) {
  const demo = new DemoLifecycle(state);
  // These approvals are part of the scripted story, never a person's live consent.
  demo.approveBuild(demo.planHash);
  demo.build();
  const built = demo.evidence();
  demo.approveCleanup(demo.cleanupHash);
  demo.destroy();
  return { built, cleaned: demo.evidence() };
}
