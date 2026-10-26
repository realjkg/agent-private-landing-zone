import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { releaseAdmission } from "../src/cli/release-admission.js";
import { releaseStatusView } from "../src/release/docs.js";
import { loadWorkGraph, runnableTasks, workGraphProblems, type WorkGraph, type WorkNode } from "../src/release/work-graph.js";
import { mergeBlockers, OWNER_BUDGET, resumeState, schedule, type Checkpoint, type PrFacts, type SchedulerState } from "../src/release/scheduler.js";
import type { ReleaseAdmissionReport } from "../src/qualification/release-admission.js";
import type { RowReport } from "../src/release/acceptance.js";
import {
  loadReleaseScope, loadReleaseStatus, renderReleaseStatus, scopeProblems, statusProblems,
  type GateStatusEntry, type ReleaseScope, type ReleaseStatus,
} from "../src/release/status.js";

// The release gate status (config/release/status.json) against the scope, the admission review and the journey matrix.

const root = process.cwd();
const candidate = "c".repeat(40);
const evidence = "e".repeat(64);
const shippedScope = loadReleaseScope(root);
const shippedStatus = loadReleaseStatus(root) as ReleaseStatus;
const clone = <T>(value: T): T => structuredClone(value);
const frozen = (): ReleaseScope => ({ ...clone(shippedScope), candidate });
const withEntry = (gate: string, change: Partial<GateStatusEntry>): ReleaseStatus => {
  const status = clone(shippedStatus);
  const at = status.gates.findIndex((x) => x.gate === gate);
  status.gates[at] = { ...status.gates[at]!, ...change };
  return status;
};
const admitted = (...ids: string[]): ReleaseAdmissionReport => ({
  sourceCommit: candidate, readyForIndependentReleaseReview: false, productionReleaseApproved: false, infrastructureAct: "DISABLED",
  actPilot: null, blockers: [], candidateIdentityHash: "0".repeat(64),
  gates: ids.map((id) => ({ id, mode: "CI", status: "EVIDENCE_PRESENT", blockers: [], evidenceSha256: evidence })),
});
const row = (cloud: string, path: string, implemented: boolean, live: RowReport["live"]): RowReport => ({
  cloud, path, implemented, live, status: implemented ? "SYNTHETIC_PASS" : "NOT_IMPLEMENTED",
  steps: { prepare: "SYNTHETIC_PASS", preview: "SYNTHETIC_PASS", approve: "SYNTHETIC_PASS", execute: "SYNTHETIC_PASS", observe: "SYNTHETIC_PASS", cleanup: "SYNTHETIC_PASS" },
});
const passing = (gate: string): Partial<GateStatusEntry> => ({ status: "PASS", candidate, evidenceMode: "LIVE", evidenceRefs: [".runs/release/" + gate + "-" + evidence + ".json"] });

test("the shipped scope and status check, nothing passes before a candidate is frozen, and the release view is current", async () => {
  const view = await releaseStatusView(root);
  assert.deepEqual(view.problems, []);
  assert.equal(shippedScope.candidate, null);
  assert.ok(shippedStatus.gates.every((x) => x.status !== "PASS"));
  assert.equal(readFileSync(join(root, "docs", "release-status.md"), "utf8"), view.markdown, "run npm run docs:release");
  assert.match(view.markdown!, /## Ready \(0\)[\s\S]*## Needs attention[\s\S]*## Not qualified[\s\S]*## Out of scope[\s\S]*## Primary action/);
});

test("a PASS needs the frozen candidate, LIVE evidence, and the admission review finding that gate's cited evidence", () => {
  const gate = "source-ci";
  const scope = frozen();
  const journeys: RowReport[] = [];
  assert.deepEqual(statusProblems(withEntry(gate, passing(gate)), { scope, journeys, admission: admitted(gate) }), []);
  const refusals: [string, ReleaseStatus, ReleaseScope, ReleaseAdmissionReport | undefined][] = [
    ["no candidate frozen", withEntry(gate, { ...passing(gate), candidate: null }), shippedScope, admitted(gate)],
    ["synthetic", withEntry(gate, { ...passing(gate), evidenceMode: "SYNTHETIC" }), scope, admitted(gate)],
    ["no admission review", withEntry(gate, passing(gate)), scope, undefined],
    ["admission found nothing", withEntry(gate, passing(gate)), scope, admitted("release-archive")],
    ["another hash cited", withEntry(gate, { ...passing(gate), evidenceRefs: ["other.json"] }), scope, admitted(gate)],
    ["stale candidate", withEntry(gate, { ...passing(gate), candidate: "d".repeat(40) }), scope, admitted(gate)],
    ["review of another commit", withEntry(gate, passing(gate)), scope, { ...admitted(gate), sourceCommit: "d".repeat(40) }],
  ];
  for (const [name, status, s, admission] of refusals) {
    assert.notDeepEqual(statusProblems(status, { scope: s, journeys, ...(admission ? { admission } : {}) }), [], name);
  }
});

test("an ACT path passes only with its journey row implemented through cleanup and live, for the full-lifecycle scope", () => {
  const gate = "act:aws-terraform";
  const context = (journeys: RowReport[]) => ({ scope: frozen(), journeys, admission: admitted(gate) });
  const status = withEntry(gate, passing(gate));
  status.primary = "act:aws-cdk"; // a passed gate is no longer the primary action
  assert.deepEqual(statusProblems(status, context([row("AWS", "TERRAFORM", true, "LIVE_PASS")])), []);
  for (const journeys of [[], [row("AWS", "TERRAFORM", false, "LIVE_PASS")], [row("AWS", "TERRAFORM", true, "BLOCKED")], [row("AWS", "CDK", true, "LIVE_PASS")]]) {
    assert.ok(statusProblems(status, context(journeys)).some((x) => x.includes("journey row")));
  }
});

test("OUT_OF_SCOPE only for a gate the owner's scope excludes, and the scope cannot exclude its own platforms or paths", () => {
  const journeys: RowReport[] = [];
  assert.ok(statusProblems(withEntry("lifecycle:upgrade", { status: "OUT_OF_SCOPE" }), { scope: shippedScope, journeys }).some((x) => x.includes("OUT_OF_SCOPE needs")));
  assert.ok(statusProblems(withEntry("preview:pulumi-aws-greenfield", { status: "NOT_RUN", nextAction: "Run the Pulumi preview." }), { scope: shippedScope, journeys })
    .some((x) => x.includes("excludes this gate")));
  const excluding = (gate: string) => scopeProblems({ ...clone(shippedScope), outOfScope: [...shippedScope.outOfScope, { gate, reason: "Not wanted for this release." }] });
  for (const gate of ["platform:win32-x64", "act:aws-cdk"]) assert.ok(excluding(gate).some((x) => x.includes("cannot be excluded")), gate);
  assert.ok(excluding("preview:nonexistent").some((x) => x.includes("not a release gate")));
  assert.ok(excluding("preview:pulumi-aws-greenfield").some((x) => x.includes("twice")));
  assert.ok(scopeProblems({ ...clone(shippedScope), outOfScope: [{ gate: "lifecycle:upgrade", reason: "" }] }).some((x) => x.includes("why")));
});

test("the scope must name the owner's decision and exactly the platforms and paths the admission gates define", () => {
  assert.deepEqual(scopeProblems(shippedScope), []);
  for (const change of [
    { decision: { by: "AGENT", ref: shippedScope.decision.ref, recorded: "2026-10-25" } },
    { platforms: shippedScope.platforms.filter((x) => x !== "win32-arm64") },
    { actPaths: [...shippedScope.actPaths, "act:gcp-terraform"] },
    { candidate: "HEAD" },
    { manifest: "release/manifest.json" },
    { journey: "EXECUTE_ONLY" },
  ]) assert.notDeepEqual(scopeProblems({ ...clone(shippedScope), ...change }), [], JSON.stringify(change));
});

test("every gate is listed once in admission order, with an owner, a tested scope, invalidation and a next action", () => {
  const journeys: RowReport[] = [];
  const check = (status: unknown) => statusProblems(status, { scope: shippedScope, journeys });
  const missing = clone(shippedStatus); missing.gates.pop();
  const reordered = clone(shippedStatus); reordered.gates.reverse();
  for (const status of [missing, reordered]) assert.ok(check(status).some((x) => x.includes("every release gate once")));
  for (const change of [
    { owner: "SOMEONE" as never }, { status: "DONE" as never }, { testedScope: "" }, { invalidatedBy: [] }, { nextAction: "" },
    { evidenceMode: "LIVE" as const, evidenceRefs: [] }, { evidenceMode: null, evidenceRefs: ["x.json"] }, { candidate: "abc" },
  ]) assert.notDeepEqual(check(withEntry("source-ci", change)), [], JSON.stringify(change));
  assert.ok(check({ ...clone(shippedStatus), primary: "preview:pulumi-aws-greenfield" }).some((x) => x.includes("primary")));
});

test("the release view puts failures under Needs attention, names the primary action, and labels synthetic progress", () => {
  const status = withEntry("source-ci", { status: "FAIL", nextAction: "Fix the failing type check on the candidate." });
  delete status.primary;
  const view = renderReleaseStatus(status, shippedScope);
  assert.match(view, /## Needs attention \(\d+\)\n\n[^#]*`source-ci` \| CI \| FAIL/);
  assert.match(view, /## Primary action\n\n`source-ci` \(CI\): Fix the failing type check/);
  assert.match(view, /`act:aws-terraform`[^\n]*Synthetic progress only/);
});

test("the admission CLI explains itself and refuses to review without exactly one manifest", async () => {
  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => { printed.push(line); };
  try { await releaseAdmission(["--help"]); } finally { console.log = log; }
  assert.match(printed.join("\n"), /--manifest/);
  for (const args of [[], ["--manifest"], ["--manifest", "--help"], ["--other", "x.json"]]) {
    await assert.rejects(releaseAdmission(args), /RELEASE_ADMISSION_REQUIRES_MANIFEST/, JSON.stringify(args));
  }
});

test("the shipped work graph checks, its page is current, and what runs next is derived from its dependencies", async () => {
  const view = await releaseStatusView(root);
  assert.equal(readFileSync(join(root, "docs", "work-graph.md"), "utf8"), view.workGraph, "run npm run docs:release");
  const graph = loadWorkGraph(root) as WorkGraph;
  assert.deepEqual(workGraphProblems(graph), []);
  // Derived from the graph as shipped, so the check holds as tasks move to DONE.
  const runnable = new Set(runnableTasks(graph).map((node) => node.id));
  const done = new Set(graph.nodes.filter((node) => node.status === "DONE").map((node) => node.id));
  for (const node of graph.nodes) {
    const ready = !["DONE", "BLOCKED", "HOLD"].includes(node.status) && node.dependsOn.every((id) => done.has(id));
    assert.equal(runnable.has(node.id), ready, node.id + " runs exactly when it is open and its dependencies are DONE");
  }
  assert.ok(!runnable.has("guided-journey-ui"), "a held task never runs");
  assert.ok(!runnable.has("candidate-freeze"), "the freeze waits on the integrated synthetic matrix");
});

test("the work graph refuses a cycle, an unknown dependency or gate, a DONE task without its merge, and an unexplained block", () => {
  const graph = structuredClone(loadWorkGraph(root)) as WorkGraph;
  const at = (id: string) => graph.nodes.find((node) => node.id === id)!;
  const variants: [string, (g: WorkGraph) => void, RegExp][] = [
    ["cycle", (g) => { g.nodes.find((n) => n.id === "baseline-repair")!.dependsOn = ["dependency-updates"]; }, /dependency cycle/],
    ["unknown dependency", (g) => { g.nodes[0]!.dependsOn = ["no-such-task"]; }, /unknown task/],
    ["unknown gate", (g) => { g.nodes[0]!.gates = ["preview:nope"]; }, /not a release gate/],
    ["DONE without merge", (g) => { const n = g.nodes.find((x) => x.id === "release-gate-matrix")!; delete n.merges; }, /DONE needs the merge/],
    ["short sha", (g) => { g.nodes.find((x) => x.id === "release-gate-matrix")!.merges = ["6b4cc53"]; }, /full commit SHAs/],
    ["DONE before dependency", (g) => { const n = g.nodes.find((x) => x.id === "candidate-freeze")!; n.status = "DONE"; n.merges = ["a".repeat(40)]; delete n.next; }, /DONE before its dependency/],
    ["blocked without reason", (g) => { delete g.nodes.find((x) => x.id === "live-qualification")!.blockedBy; }, /needs blockedBy/],
    ["no next action", (g) => { delete g.nodes.find((x) => x.id === "candidate-freeze")!.next; }, /next must say/],
    ["duplicate", (g) => { g.nodes.push({ ...(g.nodes[0] as WorkNode) }); }, /listed twice/],
    ["unknown field", (g) => { (g.nodes[0] as Record<string, unknown>).approvedBy = "agent"; }, /unknown field/],
  ];
  assert.ok(at("baseline-repair") && at("candidate-freeze").status !== "DONE");
  for (const [name, change, pattern] of variants) {
    const copy = structuredClone(graph);
    change(copy);
    assert.match(workGraphProblems(copy).join(" | "), pattern, name);
  }
});

// The scheduler's decision step (src/release/scheduler.ts), on a small graph.
const sha = (c: string) => c.repeat(40);
const node = (id: string, change: Partial<WorkNode> = {}): WorkNode =>
  ({ id, title: "Task " + id, owner: "LANE", status: "QUEUED", dependsOn: [], gates: [], next: "Do the task " + id, ...change });
const facts = (pr: number, change: Partial<PrFacts> = {}): PrFacts => ({
  pr, head: sha("a"), open: true, merged: false, checksGreen: true, checksFailed: false, qaPassed: true,
  verdict: { result: "NO_BLOCKING_ISSUES", head: sha("a"), commentId: 1 }, laterBlocking: false, compatibleWithMain: true,
  policyChange: false, onHold: false, repairRounds: 0, ...change,
});
const idle: SchedulerState = { active: {}, reviewing: [] };
const graphOf = (...nodes: WorkNode[]): WorkGraph => ({ schemaVersion: 1, updated: "2026-10-26", nodes });

test("scheduler: a head merges only when all nine mandate conditions hold, one merge per tick", () => {
  assert.deepEqual(mergeBlockers(facts(1)), []);
  const failing: [string, Partial<PrFacts>][] = [
    ["closed", { open: false }], ["on hold", { onHold: true }], ["checks", { checksGreen: false }], ["qa", { qaPassed: false }],
    ["no review", { verdict: undefined }], ["stale review", { head: sha("b") }],
    ["blocking review", { verdict: { result: "BLOCKING", head: sha("a"), commentId: 2 } }], ["later finding", { laterBlocking: true }],
    ["behind main", { compatibleWithMain: false }], ["policy change", { policyChange: true }],
  ];
  for (const [name, change] of failing) assert.notDeepEqual(mergeBlockers(facts(1, change)), [], name);
  const actions = schedule(graphOf(node("a", { status: "IN_PROGRESS", prs: [1] }), node("b", { status: "IN_PROGRESS", prs: [2] })),
    [facts(1), facts(2)], idle);
  assert.deepEqual(actions.filter((x) => x.kind === "MERGE").map((x) => x.pr), [1], "integration is serialized");
  assert.ok(actions.some((x) => x.kind === "WAIT" && x.pr === 2));
});

test("scheduler: an unreviewed green head gets the one reviewer slot; a blocking result or failed check goes back to its owner", () => {
  const unreviewed = { verdict: { result: "NO_BLOCKING_ISSUES" as const, head: sha("b"), commentId: 1 } };
  const graph = graphOf(node("a", { status: "IN_PROGRESS", prs: [1] }), node("b", { status: "IN_PROGRESS", prs: [2] }));
  const actions = schedule(graph, [facts(1, unreviewed), facts(2, unreviewed)], idle);
  assert.deepEqual(actions.filter((x) => x.kind === "REVIEW").map((x) => x.pr), [1], "one reviewer at a time");
  assert.equal(schedule(graph, [facts(1, unreviewed)], { active: {}, reviewing: [{ pr: 9, head: sha("c") }] })
    .filter((x) => x.kind === "REVIEW").length, 0, "a busy slot waits");
  const blocked = schedule(graph, [facts(1, { verdict: { result: "BLOCKING", head: sha("a"), commentId: 3 } }), facts(2, { checksGreen: false, checksFailed: true })], idle);
  assert.deepEqual(blocked.filter((x) => x.kind === "FIX").map((x) => [x.pr, (x as { owner: string }).owner]), [[1, "LANE"], [2, "LANE"]]);
  assert.equal(blocked.filter((x) => x.kind === "MERGE").length, 0);
});

test("scheduler: a task past its repair limit escalates and stops only its dependents; independent work keeps moving", () => {
  const graph = graphOf(
    node("stuck", { status: "IN_PROGRESS", prs: [1] }),
    node("after-stuck", { dependsOn: ["stuck"] }),
    node("independent", { owner: "COORDINATOR" }),
    node("owner-only", { owner: "OWNER" }),
  );
  const actions = schedule(graph, [facts(1, { repairRounds: 3, verdict: { result: "BLOCKING", head: sha("a"), commentId: 4 } })], idle);
  assert.ok(actions.some((x) => x.kind === "ESCALATE" && x.task === "stuck"));
  assert.ok(actions.some((x) => x.kind === "DISPATCH" && x.task === "independent"), "a blocked task does not stop the release");
  assert.ok(!actions.some((x) => x.task === "after-stuck"), "its dependents wait");
  assert.ok(!actions.some((x) => x.kind === "DISPATCH" && x.task === "owner-only"), "owner tasks are never dispatched to an agent");
});

test("scheduler: one lane at a time, one owner per task, and a resumed session forgets workers it cannot see", () => {
  const graph = graphOf(node("x"), node("y"), node("z", { owner: "COORDINATOR" }));
  assert.deepEqual(schedule(graph, [], idle).filter((x) => x.kind === "DISPATCH").map((x) => x.task), ["x", "z"], "the lane budget is one");
  assert.deepEqual(schedule(graph, [], { active: { x: "LANE" }, reviewing: [] }).filter((x) => x.kind === "DISPATCH").map((x) => x.task), ["z"]);
  const checkpoint: Checkpoint = { schemaVersion: 1, tick: 7, at: "2026-10-26T06:00:00Z", mainHead: sha("d"), last: [],
    state: { active: { x: "LANE", z: "COORDINATOR" }, reviewing: [{ pr: 5, head: sha("e") }] } };
  assert.deepEqual(resumeState(checkpoint, new Set(["z"])), { active: { z: "COORDINATOR" }, reviewing: [] },
    "a lost worker's task returns to the scheduler for re-dispatch");
  assert.equal(OWNER_BUDGET.lanes, 1);
  assert.equal(OWNER_BUDGET.reviewers, 1);
});
