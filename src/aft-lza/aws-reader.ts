import type { AftLzaReader } from "./run.js";
import type { ControlObservation, PipelineObservation } from "./workflow.js";

/**
 * The real read-only reader: AWS CLI read calls only (list/describe/get), run through an injected executor that supplies the
 * federated DISCOVERY identity (the evidence runner's governed child environment). No ambient keys: the executor refuses to run
 * when the environment carries static access keys. Every call is on an allow-list; any other verb is refused before it runs.
 */
export type AwsExec = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** How many recent executions are read per pipeline. */
export const EXECUTION_WINDOW = 25;

const READ_VERBS = new Set([
  "organizations list-accounts", "organizations list-parents", "codepipeline list-pipeline-executions",
  "controltower list-enabled-controls", "configservice describe-compliance-by-config-rule",
  "controltower list-landing-zones", "controltower get-landing-zone", "controltower list-enabled-baselines",
  "organizations describe-organizational-unit", "cloudformation describe-stacks", "sts get-caller-identity",
]);

export function assertNoAmbientKeys(env: NodeJS.ProcessEnv): void {
  if (env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY) throw new Error("AMBIENT_AWS_KEYS: use the federated DISCOVERY identity, not static keys");
}

export class AwsCliReader implements AftLzaReader {
  constructor(private readonly exec: AwsExec, private readonly controlRules: string[] = []) {}

  private async call(service: string, verb: string, args: string[], region?: string): Promise<{ denied: boolean; value?: Record<string, unknown> }> {
    if (!READ_VERBS.has(service + " " + verb)) throw new Error("NOT_A_READ_CALL: " + service + " " + verb);
    const full = [service, verb, ...args, "--output", "json", ...(region ? ["--region", region] : [])];
    const result = await this.exec(full);
    if (result.code !== 0) {
      if (/AccessDenied|UnauthorizedOperation|not authorized/i.test(result.stderr)) return { denied: true };
      throw new Error("AWS_READ_FAILED: " + service + " " + verb + ": " + result.stderr.slice(0, 300));
    }
    return { denied: false, value: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
  }

  async pipelineExecutions(pipelineName: string, region: string): Promise<PipelineObservation[]> {
    const r = await this.call("codepipeline", "list-pipeline-executions", ["--pipeline-name", pipelineName, "--max-items", String(EXECUTION_WINDOW)], region);
    // A denied read is not "no executions": callers would read it as never deployed.
    if (r.denied) throw new Error("AWS_READ_DENIED: codepipeline list-pipeline-executions " + pipelineName);
    const rows = (r.value?.pipelineExecutionSummaries as Array<Record<string, unknown>> | undefined) ?? [];
    return rows.map((row) => ({
      pipelineName, executionId: String(row.pipelineExecutionId),
      sourceRevision: String(((row.sourceRevisions as Array<Record<string, unknown>> | undefined) ?? [])[0]?.revisionId ?? ""),
      status: (["InProgress", "Succeeded", "Failed", "Stopped", "Superseded"].includes(String(row.status)) ? row.status : "Unknown") as PipelineObservation["status"],
      evidence: "OBSERVED" as const,
    })).reverse(); // the API lists newest first
  }

  async findAccountByEmail(email: string) {
    const r = await this.call("organizations", "list-accounts", []);
    if (r.denied) return { lookup: "ACCESS_DENIED" as const };
    const match = ((r.value?.Accounts as Array<Record<string, unknown>> | undefined) ?? []).filter((a) => String(a.Email).toLowerCase() === email.toLowerCase());
    if (match.length !== 1) return { lookup: "NOT_FOUND" as const };
    const id = String(match[0]!.Id);
    const p = await this.call("organizations", "list-parents", ["--child-id", id]);
    if (p.denied) return { lookup: "ACCESS_DENIED" as const };
    const parent = ((p.value?.Parents as Array<Record<string, unknown>> | undefined) ?? [])[0];
    return { lookup: "FOUND" as const, account: { accountId: id, name: String(match[0]!.Name), email: String(match[0]!.Email), parentOuId: String(parent?.Id ?? ""), status: String(match[0]!.Status), evidence: "OBSERVED" as const } };
  }

  /** The identity the reads actually ran as, recorded in the report so it is bound to an account and role. */
  async callerArn(): Promise<string | undefined> {
    const r = await this.call("sts", "get-caller-identity", []);
    return r.denied || typeof r.value?.Arn !== "string" ? undefined : r.value.Arn;
  }

  /** The landing zone and its drift status (Control Tower home Region). */
  async landingZone(region: string): Promise<{ arn: string; driftStatus: string } | undefined> {
    const list = await this.call("controltower", "list-landing-zones", [], region);
    const arn = ((list.value?.landingZones as Array<Record<string, unknown>> | undefined) ?? [])[0]?.arn;
    if (list.denied || typeof arn !== "string") return undefined;
    const zone = await this.call("controltower", "get-landing-zone", ["--landing-zone-identifier", arn], region);
    if (zone.denied) return undefined;
    const status = ((zone.value?.landingZone as Record<string, unknown> | undefined)?.driftStatus as Record<string, unknown> | undefined)?.status;
    return { arn, driftStatus: String(status ?? "UNKNOWN") };
  }

  async ouArn(ouId: string): Promise<string | undefined> {
    const r = await this.call("organizations", "describe-organizational-unit", ["--organizational-unit-id", ouId]);
    const arn = (r.value?.OrganizationalUnit as Record<string, unknown> | undefined)?.Arn;
    return r.denied || typeof arn !== "string" ? undefined : arn;
  }

  /** Baselines and controls enabled on the OU, with Control Tower's drift summary. Undefined when unreadable. */
  async enabledOnOu(ouArn: string, region: string): Promise<{ baselines?: Array<{ arn: string; driftStatus: string }>; controls?: Array<{ arn: string; driftStatus: string }> }> {
    const drift = (row: Record<string, unknown>): string => {
      const summary = (row.driftStatusSummary ?? {}) as Record<string, unknown>;
      const inherited = ((summary.types as Record<string, unknown> | undefined)?.inheritance as Record<string, unknown> | undefined)?.status;
      return String(summary.driftStatus ?? inherited ?? "UNKNOWN");
    };
    const b = await this.call("controltower", "list-enabled-baselines", ["--filter", JSON.stringify({ targetIdentifiers: [ouArn] })], region);
    const c = await this.call("controltower", "list-enabled-controls", ["--target-identifier", ouArn], region);
    return {
      baselines: b.denied ? undefined : ((b.value?.enabledBaselines as Array<Record<string, unknown>> | undefined) ?? []).map((row) => ({ arn: String(row.arn ?? row.baselineIdentifier), driftStatus: drift(row) })),
      controls: c.denied ? undefined : ((c.value?.enabledControls as Array<Record<string, unknown>> | undefined) ?? []).map((row) => ({ arn: String(row.arn ?? row.controlIdentifier), driftStatus: drift(row) })),
    };
  }

  /** LZA's AWSAccelerator-* stacks in one Region with their last recorded drift status. Undefined when unreadable. */
  async lzaStacks(region: string): Promise<Array<{ region: string; stackName: string; driftStatus: string }> | undefined> {
    const r = await this.call("cloudformation", "describe-stacks", [], region);
    if (r.denied) return undefined;
    return ((r.value?.Stacks as Array<Record<string, unknown>> | undefined) ?? [])
      .filter((stack) => String(stack.StackName).startsWith("AWSAccelerator-"))
      .map((stack) => ({ region, stackName: String(stack.StackName), driftStatus: String((stack.DriftInformation as Record<string, unknown> | undefined)?.StackDriftStatus ?? "UNKNOWN") }));
  }

  /** AWS Config rule compliance per Region, read with the discovery identity's assumed audit view of the account. */
  async controls(_accountId: string, regions: string[]): Promise<ControlObservation[]> {
    const out: ControlObservation[] = [];
    for (const region of regions) {
      if (this.controlRules.length === 0) continue;
      const r = await this.call("configservice", "describe-compliance-by-config-rule", ["--config-rule-names", ...this.controlRules], region);
      if (r.denied) { for (const rule of this.controlRules) out.push({ region, controlId: rule, result: "UNKNOWN", evidence: "OBSERVED", ref: "access-denied" }); continue; }
      const rows = (r.value?.ComplianceByConfigRules as Array<Record<string, unknown>> | undefined) ?? [];
      for (const rule of this.controlRules) {
        const row = rows.find((x) => x.ConfigRuleName === rule);
        const c = String((row?.Compliance as Record<string, unknown> | undefined)?.ComplianceType ?? "");
        out.push({ region, controlId: rule, result: c === "COMPLIANT" ? "PASS" : c === "NON_COMPLIANT" ? "FAIL" : "UNKNOWN", evidence: "OBSERVED", ref: "config:" + region + ":" + rule });
      }
    }
    return out;
  }
}
