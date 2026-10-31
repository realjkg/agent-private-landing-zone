import { pathToFileURL } from "node:url";

import { costPaths, costRequestOf, readLocalCostConfig, writeCostSnapshot, COST_CONFIG_FILE, COST_STATUS_FILE } from "../cost/local.js";
import { brokerCostRead, costStatusLines, readCostStatus, type CostRead } from "../cost/status.js";

/**
 * `./alz cost status`: read the cost baseline's state from AWS, read-only (plan item 5; owner direction 6536926009).
 *
 * It reads the budget, its alerts and recipients, the unit's tags, cost-allocation tag activation and the CUR 2.0 export
 * through the tool broker's fixed read commands (src/cost/status.ts), prints a few concise lines from the redacted status
 * (`costStatusLines`: recipient emails masked), and saves the typed status for this computer's console panel and readiness
 * item (src/cost/local.ts, owner-only). It creates, changes and deletes nothing, gates nothing and leaves ACT disabled.
 * The budget name, required tags, export and analytics choice come from the one cost configuration, config/cost.json.
 */

export const COST_USAGE = [
  "Usage: ./alz cost status --account <12-digit account> [--unit <deletion unit id> --region <region>] [--export-arn <arn>]",
  "  Reads the budget, alerts, tags, cost-allocation tags and cost export from AWS (read-only) with the AWS sign-in in this terminal.",
  "  Uses " + COST_CONFIG_FILE + " for the budget name, required tags and export. Saves the result to " + COST_STATUS_FILE + " for the console.",
];

const FLAGS = { "--account": "accountId", "--unit": "unitId", "--region": "region", "--export-arn": "exportArn" } as const;
type Target = { accountId?: string; unitId?: string; region?: string; exportArn?: string };

export type CostCliDeps = {
  read?: CostRead;
  configPath?: string;
  statusPath?: string;
  now?: () => Date;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

/** Exit 0 when the read completed (whatever it found: the status is advisory), 2 for a refused request or a failed read. */
export async function runCostCommand(args: readonly string[], deps: CostCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const refuse = (code: string, why: string): number => { err("COST_STATUS_BLOCKED: " + code); err(why); return 2; };
  const [sub, ...rest] = args;
  if (sub !== "status") { for (const line of COST_USAGE) out(line); return sub === undefined || sub === "--help" ? 0 : 2; }
  const target: Target = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = FLAGS[rest[i] as keyof typeof FLAGS];
    const value = rest[i + 1];
    if (key === undefined || value === undefined || value.startsWith("--") || target[key] !== undefined) {
      for (const line of COST_USAGE) err(line);
      return 2;
    }
    target[key] = value;
  }
  if (target.accountId === undefined) return refuse("COST_STATUS_ACCOUNT_REQUIRED", "Name the account to read with --account <12-digit account>.");
  const paths = costPaths();
  const local = readLocalCostConfig(deps.configPath ?? paths.config);
  if (local.state === "NONE") return refuse("COST_CONFIG_MISSING", "No cost configuration at " + COST_CONFIG_FILE + ". Write the landing zone's cost section there first.");
  if (local.state === "INVALID") return refuse("COST_CONFIG_INVALID", "The cost configuration has problems at: " + local.issues.map((i) => i.path + " " + i.code).join(", ") + ".");
  const read = deps.read ?? brokerCostRead({ cwd: process.cwd() });
  let status;
  try {
    status = await readCostStatus(costRequestOf(local.config, { ...target, accountId: target.accountId }), read, (deps.now ?? (() => new Date()))());
  } catch (error) {
    // A refused request names its code; anything else is a failed read, never a stack trace or an AWS message.
    const code = error instanceof Error && /^COST_STATUS_[A-Z_]+$/.test(error.message) ? error.message : "COST_STATUS_READ_FAILED";
    return refuse(code, "Nothing was saved. Check the account, unit, region and export, and the AWS sign-in in this terminal.");
  }
  for (const line of costStatusLines(status)) out(line);
  writeCostSnapshot(status, deps.statusPath ?? paths.status);
  out("Saved for this computer's console and readiness: " + COST_STATUS_FILE + " (owner-only; local state, not evidence).");
  out("Read-only: nothing was created, changed or deleted. ACT remains disabled.");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCostCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => {
    console.error("COST_STATUS_BLOCKED: COST_STATUS_FAILED");
    process.exitCode = 2;
  });
}
