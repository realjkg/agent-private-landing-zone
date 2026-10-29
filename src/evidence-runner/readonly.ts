import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { identityVariables } from "../tools/identity.js";
import type { JournalDocument } from "./journal.js";
import { runChild, sha256File, stageFolder, step, type StageContext, type StepResult } from "./steps.js";
import { READONLY_STAGE_OF, type Provider, type StageId } from "./types.js";

/**
 * The read-only stages S2, S3 and S4 (docs/evidence-runner.md, "Stages").
 *
 * 1. `identity`, in this process: the federated DISCOVERY identity names the expected account, tenant and subscription, or
 *    project (`identity.ts`, compared in the preflight). Nothing is read from a cloud before this passes.
 * 2. `provider-qualification`: the existing producer, `./alz qualify provider-aws|provider-azure`, as a child with the governed
 *    environment (`child.ts`): the federated identity's references, no operator session, a private HOME. Its output is quiet
 *    (a log file of the run) and its document is written into this stage's folder. The no-op stack is checked by that
 *    producer's own change-set preview against it, under the federated identity; the runner makes no cloud call itself.
 *
 * GCP has no read-only producer on main (the `gcp-provider` gate has none; delegated decision 4 sends it to a new PLAN), so the
 * GCP stage verifies the project and stops BLOCKED `NO_PRODUCER`, having read nothing from GCP.
 */
export type StageResult = { outcome: StepResult["outcome"]; code: string; detail: string; documents?: JournalDocument[] };

const PRODUCER: Readonly<Record<"aws" | "azure", { cloud: string; output: string; args: (ctx: StageContext, output: string) => string[] }>> = {
  aws: {
    cloud: "AWS", output: "provider-aws.json",
    args: (ctx, output) => ["qualify", "provider-aws", "--provider", "AWS", "--source-commit", ctx.config.candidateCommit, "--aws-stack", ctx.config.aws!.qualificationStack,
      "--aws-template", "qualification/provider/aws-noop-stack.yaml", "--output", output],
  },
  azure: {
    cloud: "AZURE", output: "provider-azure.json",
    args: (ctx, output) => ["qualify", "provider-azure", "--provider", "AZURE", "--source-commit", ctx.config.candidateCommit, "--azure-bicep", "qualification/provider/azure-noop.bicep",
      "--azure-scope", "subscription", "--azure-location", ctx.config.azure!.location, "--output", output],
  },
};

/** Whether a provider qualification document is the ready, non-mock evidence of this candidate and cloud (what admission checks first). */
/**
 * Whether the account the producer itself observed (its document's `observedIdentity`, from its own discovery) is the expected
 * one. Checked after the run and before the document is taken as evidence (review B1 on #349): the identity check before the
 * run proves what the tool was pointed at; this proves where it actually read. Unobserved is never a match.
 */
function observedMatches(value: Record<string, unknown>, provider: "aws" | "azure", config: StageContext["config"], env: NodeJS.ProcessEnv): { ok: true } | { ok: false; code: string; detail: string } {
  const observed = typeof value.observedIdentity === "object" && value.observedIdentity !== null ? value.observedIdentity as Record<string, unknown> : {};
  const expected: [string, string][] = provider === "aws" ? [["accountId", config.aws!.expectedAccountId]]
    : [["tenantId", config.azure!.expectedTenantId], ["subscriptionId", config.azure!.expectedSubscriptionId]];
  const missing = expected.filter(([key]) => typeof observed[key] !== "string").map(([key]) => key);
  if (missing.length > 0) return { ok: false, code: "IDENTITY_NOT_OBSERVED", detail: "the producer's document records no observed " + missing.join(" or ") + ", so where it read cannot be confirmed" };
  const wrong = expected.filter(([key, want]) => observed[key] !== want).map(([key, want]) => key + " " + String(observed[key]) + " (expected " + want + ")");
  if (wrong.length > 0) return { ok: false, code: "WRONG_ACCOUNT", detail: "the producer read the wrong " + wrong.join(" and ") };
  // The principal, as a consistency check (review N9 on #349), not proof: the AWS role the caller assumed against the configured
  // DISCOVERY role, and the Azure client id against ALZ_DISCOVERY_ARM_CLIENT_ID where one is configured.
  const variables = identityVariables(env, "DISCOVERY");
  const principal: [string, string | undefined][] = provider === "aws"
    ? [["roleName", variables.get("AWS_ROLE_ARN")?.split("/").pop()]]
    : [["clientId", variables.get("ARM_CLIENT_ID")?.toLowerCase()]];
  for (const [key, want] of principal) {
    if (want === undefined) continue;
    if (typeof observed[key] !== "string") return { ok: false, code: "PRINCIPAL_NOT_OBSERVED", detail: "the producer's document records no observed " + key + " to check against the configured " + want };
    if (observed[key] !== want) return { ok: false, code: "PRINCIPAL_MISMATCH", detail: "the producer signed in as " + key + " " + String(observed[key]) + ", not the configured " + want + " (a consistency check)" };
  }
  return { ok: true };
}

function producerVerdict(path: string, cloud: string, candidate: string): { ready: boolean; detail: string; value?: Record<string, unknown> } {
  let value: Record<string, unknown>;
  try { value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return { ready: false, detail: "its document is not JSON" }; }
  const blockers = Array.isArray(value.blockers) ? value.blockers.length : -1;
  if (value.provider !== cloud) return { ready: false, detail: "its document names provider " + String(value.provider) };
  if (value.sourceCommit !== candidate) return { ready: false, detail: "its document names another source commit" };
  if (value.ready !== true || blockers !== 0) return { ready: false, detail: "the producer reported BLOCKED with " + Math.max(blockers, 0) + " blocker(s); read them in its document" };
  return { ready: true, detail: "the producer reported READY", value };
}

export async function readonlyStage(ctx: StageContext, provider: Provider): Promise<StageResult> {
  const stage: StageId = READONLY_STAGE_OF[provider];
  const identity = ctx.preflight.identities.find((check) => check.provider === provider);
  if (!identity || identity.code === "NOT_CONFIGURED") return { outcome: "SKIPPED", code: "NOT_CONFIGURED", detail: "No " + provider + " block in the configuration." };
  if (identity.status !== "PASS") return { outcome: "BLOCKED", code: identity.code, detail: identity.detail };
  const verified = await step(ctx, stage, "identity", {}, async () => ({ outcome: "PASS", code: "VERIFIED", detail: identity.detail }));
  if (verified.outcome !== "PASS") return { outcome: verified.outcome, code: verified.code ?? "IDENTITY", detail: verified.detail };
  if (provider === "gcp") {
    return { outcome: "BLOCKED", code: "NO_PRODUCER",
      detail: "The project is verified, but no read-only GCP inventory producer exists on main for the gcp-provider gate (delegated decision 4: a new PLAN names it). Nothing was read from GCP." };
  }
  const producer = PRODUCER[provider];
  const output = ctx.runDirRel + "/" + stageFolder(stage) + "/" + producer.output;
  const ran = await step(ctx, stage, "provider-qualification", {}, async () => {
    const file = join(ctx.root, output);
    const stamp = (): string | undefined => { try { const stat = lstatSync(file); return stat.isFile() ? stat.ino + ":" + stat.size + ":" + stat.mtimeMs : "not-a-file"; } catch { return undefined; } };
    const before = stamp();
    const result = await runChild(ctx, stage, { args: producer.args(ctx, output), io: "LOGGED", logName: "provider-qualification", readonlyProducer: true });
    // The producer exits 1 when its verdict is BLOCKED and still writes its document: keep it, so the person can read why.
    // A document this run's producer did not write (left from an earlier attempt) is never taken.
    const after = stamp();
    if (after === undefined || after === "not-a-file" || after === before) return result.outcome === "PASS" ? { ...result, outcome: "BLOCKED", code: "EVIDENCE_DOCUMENT_NOT_FOUND", detail: "The producer passed but wrote no " + output + "." } : result;
    const documents: JournalDocument[] = [{ name: "provider-" + provider, path: output, sha256: sha256File(file) }];
    const verdict = producerVerdict(file, producer.cloud, ctx.config.candidateCommit);
    if (result.outcome === "PASS" && verdict.ready) {
      const where = observedMatches(verdict.value!, provider, ctx.config, ctx.env);
      if (!where.ok) return { outcome: "FAIL", code: where.code, exitCode: result.exitCode, documents, detail: "./alz qualify provider-" + provider + ": " + where.detail + "; the document is kept but is not evidence." };
      return { ...result, documents, detail: "./alz qualify provider-" + provider + ": " + verdict.detail + ", in the expected account." };
    }
    return { outcome: "FAIL", code: "PRODUCER_NOT_READY", exitCode: result.exitCode, documents, detail: "./alz qualify provider-" + provider + ": " + verdict.detail + ". " + result.detail };
  });
  return { outcome: ran.outcome, code: ran.outcome === "PASS" ? "PRODUCED" : ran.code ?? "PRODUCER", detail: ran.detail, documents: ran.documents };
}
