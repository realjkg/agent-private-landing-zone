import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeBudgetAction, validateCostConfig, type CostConfig, type CostProvisioningLimits } from "../design/cost.js";
import { writePrivateFileAtomic } from "../tools/private-file.js";
import { COST_SNAPSHOT_SCHEMA_VERSION, isCostStatus } from "./shape.js";
import type { CostStatus, CostStatusRequest } from "./status.js";

export { isCostStatus } from "./shape.js";

/**
 * The cost status on this computer (plan item 5; owner direction 2026-10-31, issue #39 comment 6536926009).
 *
 * Two local files, both read-only for everything but `./alz cost status`:
 * - `config/cost.json`: the operator's `cost` configuration (src/design/cost.ts), the one configuration source the build,
 *   the provisioning limits and this panel share. It holds recipient addresses, so it is not committed (.gitignore).
 * - `.runs/cost/status.json`: the typed status the last `./alz cost status` read from AWS, owner-only (0600). It is local
 *   operator state, never evidence: any summary, log or record made from it uses `redactCostStatus` (src/cost/status.ts).
 *
 * Readiness (src/apply/readiness.ts) and the console (GET /pilot/cost in src/cli/ui-channel.ts) read these files and call no
 * cloud. Nothing here writes outside `.runs/cost`, gates ACT or changes a resource. A missing, unreadable or malformed file
 * is reported as such, never as a status that passes.
 */

/** The repository root, found from this module, never from process.cwd(). Computed on use, so the module also loads where it is not a file. */
const repositoryRoot = (): string => resolve(fileURLToPath(new URL("../..", import.meta.url)));
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const COST_CONFIG_FILE = "config/cost.json";
export const COST_STATUS_FILE = ".runs/cost/status.json";

/** Where the cost configuration and the last status live, under `root` (the repository root by default). */
export const costPaths = (root: string = repositoryRoot()): { config: string; status: string } =>
  ({ config: join(root, COST_CONFIG_FILE), status: join(root, COST_STATUS_FILE) });

function readSmallJson(path: string): { found: false } | { found: true; value: unknown } | { found: true; unreadable: true } {
  let size: number;
  try { size = lstatSync(path).size; } catch { return { found: false }; }
  try {
    if (size > MAX_FILE_BYTES) throw new Error("too large");
    return { found: true, value: JSON.parse(readFileSync(path, "utf8")) as unknown };
  } catch { return { found: true, unreadable: true }; }
}

// --- the configuration ------------------------------------------------------------------------------------

export type LocalCostConfig =
  | { state: "NONE" }
  | { state: "INVALID"; issues: { path: string; code: string }[] }
  | { state: "OK"; config: CostConfig };

/** The operator's cost configuration, validated by the same rules the build uses. */
export function readLocalCostConfig(path: string = costPaths().config): LocalCostConfig {
  const file = readSmallJson(path);
  if (!file.found) return { state: "NONE" };
  if ("unreadable" in file) return { state: "INVALID", issues: [{ path: "$", code: "NOT_JSON" }] };
  const result = validateCostConfig(file.value);
  return result.ok ? { state: "OK", config: result.config } : { state: "INVALID", issues: result.issues.map(({ path: p, code }) => ({ path: p, code })) };
}

/** What the panel shows of the configuration: the values as configured, labeled as configuration, never as observed. */
export type CostConfigSummary = {
  label: "CONFIGURED";
  owner: string;
  tags: Record<string, string>;
  budget: { name: string; amount: string; currency: string; period: string; actualThresholds: number[]; forecastThresholds: number[];
    /** A budget tracks and alerts. Only an explicitly configured budget action does anything more, and it is named here. */
    control: "ALERT_ONLY" | "ALERT_AND_BUDGET_ACTION" };
  budgetAction: { enabled: false } | { enabled: true; effect: string; approvalModel: "MANUAL" | "AUTOMATIC"; thresholdPercent: number };
  notifications: { route: string; emails: string[]; snsTopicArn: string | null; encryption: string };
  limits: CostProvisioningLimits;
  review: { reviewBy: string; expiresOn: string | null };
  export: { mode: string; exportName: string; bucket: string | null; prefix: string; granularity: string; retentionDays: number | null };
  costAllocationTagActivation: "REQUESTED" | "NOT_REQUESTED";
  analytics: "OFF" | "ON";
};

export function costConfigSummary(config: CostConfig): CostConfigSummary {
  const action = config.budgetAction;
  return {
    label: "CONFIGURED", owner: config.owner, tags: { ...config.tags },
    budget: { name: config.budget.name, amount: config.budget.amount, currency: config.budget.currency, period: config.budget.period,
      actualThresholds: [...config.budget.actualThresholds], forecastThresholds: [...config.budget.forecastThresholds],
      control: action.enabled ? "ALERT_AND_BUDGET_ACTION" : "ALERT_ONLY" },
    budgetAction: action.enabled
      ? { enabled: true, effect: describeBudgetAction(config), approvalModel: action.approvalModel, thresholdPercent: action.thresholdPercent }
      : { enabled: false },
    notifications: { route: config.notifications.route, emails: [...config.notifications.emails],
      snsTopicArn: config.notifications.snsTopicArn ?? null, encryption: config.notifications.encryption },
    limits: structuredClone(config.limits),
    review: { reviewBy: config.review.reviewBy, expiresOn: config.review.expiresOn ?? null },
    export: { mode: config.export.mode, exportName: config.export.exportName, bucket: config.export.bucketName ?? null,
      prefix: config.export.prefix, granularity: config.export.granularity,
      retentionDays: config.export.mode === "NEW_BUCKET" ? config.export.retentionDays : null },
    costAllocationTagActivation: config.activateCostAllocationTags ? "REQUESTED" : "NOT_REQUESTED",
    analytics: config.analytics,
  };
}

/** The read request for an account, from the configuration: one source for the budget name, tags, export and analytics. */
export function costRequestOf(config: CostConfig, target: { accountId: string; unitId?: string; region?: string; exportArn?: string }): CostStatusRequest {
  return {
    accountId: target.accountId, budgetName: config.budget.name, requiredTagKeys: Object.keys(config.tags).sort(),
    ...(target.unitId !== undefined ? { unitId: target.unitId } : {}), ...(target.region !== undefined ? { region: target.region } : {}),
    ...(target.exportArn !== undefined ? { exportArn: target.exportArn } : { exportName: config.export.exportName }),
    ...(config.export.bucketName !== undefined ? { expectedBucket: config.export.bucketName } : {}),
    analytics: config.analytics === "ON" ? "on" : "off",
  };
}

// --- the last status read --------------------------------------------------------------------------------------

export type CostSnapshot = { state: "NONE" } | { state: "UNREADABLE" } | { state: "OK"; status: CostStatus };

/** The file `./alz cost status` writes: the status inside a versioned envelope, so a format change is refused, never misread. */
export type CostSnapshotFile = { schemaVersion: typeof COST_SNAPSHOT_SCHEMA_VERSION; kind: "ALZ_COST_STATUS_SNAPSHOT"; status: CostStatus };

/** The saved status, or NONE (no file) or UNREADABLE (not JSON, another or no schema version, or any field not as written). */
export function readCostSnapshot(path: string = costPaths().status): CostSnapshot {
  const file = readSmallJson(path);
  if (!file.found) return { state: "NONE" };
  if ("unreadable" in file) return { state: "UNREADABLE" };
  const envelope = file.value;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return { state: "UNREADABLE" };
  const { schemaVersion, kind, status } = envelope as Record<string, unknown>;
  if (schemaVersion !== COST_SNAPSHOT_SCHEMA_VERSION || kind !== "ALZ_COST_STATUS_SNAPSHOT" || !isCostStatus(status)) return { state: "UNREADABLE" };
  return { state: "OK", status };
}

/**
 * Saves the typed status for this computer's console and readiness: the folder is owner-only (0700, tightened when it already
 * exists) and the file is written by `writePrivateFileAtomic` (0600 on every rewrite, never through a link, replaced whole).
 */
export function writeCostSnapshot(status: CostStatus, path: string = costPaths().status): void {
  if (!isCostStatus(status)) throw new Error("COST_STATUS_INVALID");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const folder = lstatSync(dir);
  if (folder.isSymbolicLink() || !folder.isDirectory()) throw new Error("COST_STATUS_FOLDER_INVALID");
  if ((folder.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  const file: CostSnapshotFile = { schemaVersion: COST_SNAPSHOT_SCHEMA_VERSION, kind: "ALZ_COST_STATUS_SNAPSHOT", status };
  writePrivateFileAtomic(path, JSON.stringify(file, null, 2) + "\n");
}
