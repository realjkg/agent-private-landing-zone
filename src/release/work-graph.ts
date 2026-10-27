import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PRODUCTION_RELEASE_GATES } from "../qualification/release-admission.js";

/**
 * The release work graph (config/release/work-graph.json): the one dependency graph of the remaining release work, with
 * who owns each task, its branch and PR, its status, the gates it advances and the evidence that accepts it. It is the
 * second of the release mandate's three authoritative records, beside the release scope (config/release/scope.json) and
 * the candidate and admission record (the scope's candidate and manifest, and the admission report). What runs next is
 * derived from it, not claimed. Status summaries (docs/work-graph.md) are generated from it, never kept by hand.
 */
export const WORK_STATUSES = ["DONE", "IN_PROGRESS", "READY", "QUEUED", "BLOCKED", "HOLD"] as const;
export type WorkStatus = typeof WORK_STATUSES[number];
export const WORK_OWNERS = ["COORDINATOR", "LANE", "OWNER", "DEPENDABOT", "EXTERNAL"] as const;
export type WorkOwner = typeof WORK_OWNERS[number];

export type WorkNode = {
  id: string;
  title: string;
  owner: WorkOwner;
  status: WorkStatus;
  dependsOn: string[];
  /** Release gates this task advances (src/qualification/release-admission.ts). */
  gates: string[];
  branch?: string;
  prs?: number[];
  /** Merge commits that integrated the task. Required when DONE, unless the task integrates nothing (an owner action). */
  merges?: string[];
  /** Why the task cannot run, for BLOCKED and HOLD. */
  blockedBy?: string;
  /** The evidence that proves the task done: the exact test, check or record, and on which head or target. Every task names it. */
  acceptance: string;
  /** The next concrete action, for every task that is not DONE. */
  next?: string;
};
export type WorkGraph = { schemaVersion: 1; updated: string; nodes: WorkNode[] };

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, min = 1): value is string => typeof value === "string" && value.trim().length >= min;
const KEYS = new Set(["id", "title", "owner", "status", "dependsOn", "gates", "branch", "prs", "merges", "blockedBy", "acceptance", "next"]);

export function loadWorkGraph(root: string): unknown {
  return JSON.parse(readFileSync(join(root, "config", "release", "work-graph.json"), "utf8")) as unknown;
}

/** Every reason the graph is not a well-formed, acyclic graph whose claims hold together. */
export function workGraphProblems(graph: unknown): string[] {
  if (!isRecord(graph) || graph.schemaVersion !== 1 || !Array.isArray(graph.nodes)) return ["work graph: not a schemaVersion 1 object with nodes"];
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(graph.updated))) problems.push("work graph: updated must be a date");
  const gates = new Set(PRODUCTION_RELEASE_GATES.map((gate) => gate.id));
  const nodes = graph.nodes as unknown[];
  const ids = new Map<string, WorkNode>();
  for (const raw of nodes) {
    if (!isRecord(raw) || typeof raw.id !== "string") { problems.push("work graph: every node needs an id"); continue; }
    const node = raw as WorkNode;
    const at = node.id + ": ";
    if (!ID.test(node.id)) problems.push(at + "id must be lower-case words joined by hyphens");
    if (ids.has(node.id)) problems.push(at + "listed twice");
    ids.set(node.id, node);
    for (const key of Object.keys(raw)) if (!KEYS.has(key)) problems.push(at + "unknown field " + key);
    if (!text(node.title, 5)) problems.push(at + "title must say what the task is");
    if (!WORK_OWNERS.includes(node.owner)) problems.push(at + "owner must be one of " + WORK_OWNERS.join(", "));
    if (!WORK_STATUSES.includes(node.status)) problems.push(at + "status must be one of " + WORK_STATUSES.join(", "));
    if (!Array.isArray(node.dependsOn) || !node.dependsOn.every((x) => typeof x === "string")) problems.push(at + "dependsOn must list task ids");
    if (!Array.isArray(node.gates) || !node.gates.every((x) => typeof x === "string")) problems.push(at + "gates must list gate ids");
    else for (const gate of node.gates) if (!gates.has(gate)) problems.push(at + gate + " is not a release gate");
    if (node.prs !== undefined && !(Array.isArray(node.prs) && node.prs.every((x) => Number.isInteger(x) && x > 0))) problems.push(at + "prs must be PR numbers");
    if (node.merges !== undefined && !(Array.isArray(node.merges) && node.merges.every((x) => typeof x === "string" && SHA.test(x)))) problems.push(at + "merges must be full commit SHAs");
    if (node.branch !== undefined && !text(node.branch)) problems.push(at + "branch must name a branch");
    if (!text(node.acceptance, 10)) problems.push(at + "acceptance must name the evidence that proves the task done");
    if (node.status === "DONE") {
      if (node.owner !== "OWNER" && !(node.merges && node.merges.length > 0)) problems.push(at + "DONE needs the merge commits that integrated it");
      if (node.next !== undefined) problems.push(at + "a DONE task has no next action");
    } else if (!text(node.next, 10)) problems.push(at + "next must say the next concrete action");
    if ((node.status === "BLOCKED" || node.status === "HOLD") && !text(node.blockedBy, 10)) problems.push(at + node.status + " needs blockedBy");
  }
  for (const node of ids.values()) {
    for (const dep of Array.isArray(node.dependsOn) ? node.dependsOn : []) {
      const target = ids.get(dep);
      if (!target) { problems.push(node.id + ": depends on unknown task " + dep); continue; }
      if (node.status === "DONE" && target.status !== "DONE") problems.push(node.id + ": DONE before its dependency " + dep);
    }
  }
  // Depth-first search for a cycle: a graph with one is not a plan.
  const state = new Map<string, "VISITING" | "DONE">();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === "DONE") return;
    if (state.get(id) === "VISITING") { problems.push("work graph: dependency cycle " + [...path, id].join(" -> ")); return; }
    state.set(id, "VISITING");
    for (const dep of ids.get(id)?.dependsOn ?? []) if (ids.has(dep)) visit(dep, [...path, id]);
    state.set(id, "DONE");
  };
  for (const id of ids.keys()) visit(id, []);
  return problems;
}

/** Tasks that can run now: not finished, not blocked or held, with every dependency DONE. */
export function runnableTasks(graph: WorkGraph): WorkNode[] {
  const done = new Set(graph.nodes.filter((node) => node.status === "DONE").map((node) => node.id));
  return graph.nodes.filter((node) => node.status !== "DONE" && node.status !== "BLOCKED" && node.status !== "HOLD" &&
    node.dependsOn.every((dep) => done.has(dep)));
}

/** Task ids that start with this prefix are execution paths: capabilities with their own acceptance evidence. */
export const EXECUTION_PATH_PREFIX = "path-";

/** The work graph as a readable page (docs/work-graph.md), from a graph that has already been checked. */
export function renderWorkGraph(graph: WorkGraph): string {
  const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
  const runnable = new Set(runnableTasks(graph).map((node) => node.id));
  const order: readonly WorkStatus[] = ["IN_PROGRESS", "READY", "BLOCKED", "QUEUED", "HOLD", "DONE"];
  const rows = [...graph.nodes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const link = (node: WorkNode) => [node.branch ? "`" + node.branch + "`" : "", ...(node.prs ?? []).map((pr) => "#" + pr)].filter(Boolean).join(" ");
  // The execution paths (ids starting "path-"), reported as blocker -> owner -> required evidence -> next action.
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const paths = graph.nodes.filter((node) => node.id.startsWith(EXECUTION_PATH_PREFIX));
  const openDeps = (node: WorkNode) => node.dependsOn.filter((id) => byId.get(id)?.status !== "DONE");
  const pathSection = paths.length === 0 ? [] : [
    "## Execution paths",
    "",
    "**Paths completed:** " + paths.filter((node) => node.status === "DONE").length + " of " + paths.length + ".",
    "",
    "| Path | Status | Blocker | Owner | Required evidence | Next action |",
    "| --- | --- | --- | --- | --- | --- |",
    ...paths.map((node) => "| `" + node.id + "` " + cell(node.title) + " | " + node.status + " | " +
      cell(node.status === "DONE" ? "none" : [
        ...(openDeps(node).length ? ["open tasks " + openDeps(node).map((id) => "`" + id + "` (" + (byId.get(id)?.owner ?? "?") + ")").join(", ")] : []),
        ...(node.blockedBy ? [node.blockedBy] : []),
      ].join("; ") || "none") + " | " + node.owner + " | " + cell(node.acceptance) + " | " + cell(node.next ?? "none") + " |"),
    "",
    "## All tasks",
    "",
  ];
  return [
    "# Release work graph",
    "",
    "<!-- Generated by `npm run docs:release` from config/release/work-graph.json. Do not edit by hand. -->",
    "",
    "**Updated:** " + graph.updated + ". **Runnable now:** " + (runnable.size === 0 ? "none" : [...runnable].map((id) => "`" + id + "`").join(", ") + ".") ,
    "",
    ...pathSection,
    "| Task | Status | Owner | Depends on | Branch / PRs | Acceptance evidence | Next action or result |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((node) => "| `" + node.id + "` " + cell(node.title) + " | " + node.status + (runnable.has(node.id) ? " (runnable)" : "") + " | " + node.owner + " | " +
      (node.dependsOn.length === 0 ? "none" : node.dependsOn.map((dep) => "`" + dep + "`").join(", ")) + " | " + cell(link(node) || "none") + " | " + cell(node.acceptance) + " | " +
      cell(node.status === "DONE" ? (node.merges?.length ? "Integrated: " + node.merges.map((sha) => "`" + sha.slice(0, 7) + "`").join(", ") : "Owner action complete") :
        (node.blockedBy ? "Blocked by: " + node.blockedBy + ". " : "") + (node.next ?? "")) + " |"),
    "",
  ].join("\n");
}
