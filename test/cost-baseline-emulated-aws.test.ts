import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { writeQualificationEvidence } from "../src/apply/contract.js";
import { runApply, sealPreview, type ApplyDeps } from "../src/apply/driver.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { prepareApply, type Prepared } from "../src/apply/prepare.js";
import { AWS } from "../src/apply/providers/aws.js";
import { loadSealedPlan } from "../src/apply/seal.js";
import { APPLY_ADAPTER } from "../src/apply/terraform.js";
import type { ApplyEvidence } from "../src/apply/types.js";
import { renderAwsCostBaseline } from "../src/build/cost-baseline.js";
import { reviewedAwsLock, writeCostBaselineProject } from "../src/build/cost-project.js";
import { sha256 } from "../src/build/provenance.js";
import { costBaselinePreview } from "../src/build/terraform-preview.js";
import { costRequestOf } from "../src/cost/local.js";
import { readCostStatus, type CostRead } from "../src/cost/status.js";
import { resolveCostConfig } from "../src/design/cost.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { ADAPTER_VERSION, terraformArgvDigest } from "../src/teardown/driver/adapters/terraform.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import {
  AWS_DEV_TARGET, AWS_REGION, NOW, REQUESTER, SOURCE_COMMIT, approvalFor, awsContractJson, awsIdentityEnv, awsRoleArn, human, writeReviewedContract,
} from "./helpers/apply-fixtures.js";

/**
 * OPT-IN EMULATED JOURNEY (docs/cost-baseline-deploy.md): the cost baseline through the existing workflow, with the REAL Terraform
 * engine and HashiCorp's REAL aws provider 6.68.0, against EMULATED AWS endpoints. Skipped unless ALZ_SIM_TERRAFORM (a Terraform 1.x
 * binary), ALZ_SIM_MOTO (the `moto_server` of a moto[server] install) and ALZ_SIM_AWS_PROVIDER_DIR are all set, so default CI is
 * unaffected. EMULATED evidence only: it is never provider qualification, a live acceptance or a release approval, and ACT stays
 * DISABLED; the contract below is a synthetic test file written into a temporary folder, never `config/act-pilot-contract.json`.
 *
 * The journey: render → the build's preview driver (init, fmt, validate, plan, show; src/build/terraform-preview.ts) → the
 * project writer (src/build/cost-project.ts) → `prepare` twice, as the canary needs → `seal` under a `limits` contract derived
 * from config/act-pilot-contract.aws-dev-limits.example.json → approve → `apply` → `readCostStatus` through an emulated reader.
 * And the refusal: a contract whose limits leave out one rendered type is RESOURCE_NOT_IN_LIMITS at seal, and nothing is sealed.
 *
 * What is emulated, and by what (test/helpers/cost-emulator.cjs routes every connection; any other host is refused):
 * - moto: STS (web identity), S3 (the state backend with use_lockfile, and the export bucket with its policy, lifecycle,
 *   encryption, ownership controls and public access block), S3 Control (bucket tags), SNS (the topic, its policy, the email
 *   subscription) and the tagging API the status reads.
 * - A test-only in-memory stub, because moto 5.2 lacks these: AWS Budgets' DescribeSubscribersForNotification and
 *   ListTagsForResource/TagResource (moto implements budgets create/describe/notifications only), and every AWS Data Exports
 *   (`bcm-data-exports`) call (moto has no such service). The stub answers the aws provider's JSON calls well enough for create and
 *   read; it is not a model of those services. The stub's export never delivers, as no real export does on its first day.
 * - Not emulated at all: Cost Explorer's ListCostAllocationTags (moto 5.2 has no such call). The reader sends it to moto, which
 *   refuses it, so the status reports that part UNKNOWN; the test asserts exactly that and never fills it in.
 * - The Terraform registry protocol is answered locally from HashiCorp's own release files the operator downloaded (the provider
 *   zip, SHA256SUMS, its signature and HashiCorp's public key); Terraform verifies the signature and the reviewed lock's hash.
 *
 * DEV MODE ONLY setup (never an operator step; operators use ./alz). About 1 GB of disk per engine step while it runs:
 *   python3 -m venv <scratch>/moto && <scratch>/moto/bin/pip install "moto[server]"
 *   mkdir <scratch>/aws-6.68.0 && cd <scratch>/aws-6.68.0 && B=https://releases.hashicorp.com/terraform-provider-aws/6.68.0 &&
 *     curl -O $B/terraform-provider-aws_6.68.0_linux_amd64.zip -O $B/terraform-provider-aws_6.68.0_SHA256SUMS \
 *          -O $B/terraform-provider-aws_6.68.0_SHA256SUMS.sig && curl -o hashicorp.asc https://www.hashicorp.com/.well-known/pgp-key.txt
 *   ALZ_SIM_TERRAFORM=<verified terraform> ALZ_SIM_MOTO=<scratch>/moto/bin/moto_server ALZ_SIM_AWS_PROVIDER_DIR=<scratch>/aws-6.68.0 \
 *     npx tsx --test test/cost-baseline-emulated-aws.test.ts
 */
const TERRAFORM = process.env.ALZ_SIM_TERRAFORM;
const MOTO = process.env.ALZ_SIM_MOTO;
const PROVIDER_DIR = process.env.ALZ_SIM_AWS_PROVIDER_DIR;
const SKIP = !TERRAFORM || !MOTO || !PROVIDER_DIR
  ? "set ALZ_SIM_TERRAFORM, ALZ_SIM_MOTO and ALZ_SIM_AWS_PROVIDER_DIR to run the EMULATED cost baseline journey (docs/cost-baseline-deploy.md)" : false;

const [BUCKET, ...KEY_PARTS] = AWS_DEV_TARGET.backend.split("/");
const STATE_KEY = KEY_PARTS.join("/");
const ACCOUNT = AWS_DEV_TARGET.account;
const TOKEN_CANARY = "emulated-not-a-real-token-CANARY_WEB_IDENTITY";
const POLICY = "pilot-policy-2026-11-01";
const ZIP = "terraform-provider-aws_6.68.0_linux_amd64.zip";
/** Every name the emulator answers; the certificate covers exactly these. */
const SANS = ["sts.us-east-1.amazonaws.com", "sns.us-east-1.amazonaws.com", "tagging.us-east-1.amazonaws.com", "*.s3.us-east-1.amazonaws.com", "*.s3.amazonaws.com",
  "*.s3-control.us-east-1.amazonaws.com", "budgets.amazonaws.com", "bcm-data-exports.us-east-1.api.aws", "registry.terraform.io",
  "releases.hashicorp.com", "emulator.invalid"];

const CONFIG = resolveCostConfig(JSON.parse(readFileSync("config/cost.example.json", "utf8")));
type Limits = { regions: string[]; resources: { type: string; max: number }[] };
/** The shipped example's DEV limits: every type the renderer emits, regions us-east-2 and us-east-1. */
const EXAMPLE_LIMITS = (JSON.parse(readFileSync("config/act-pilot-contract.aws-dev-limits.example.json", "utf8")) as
  { targets: { DEV: { limits: Limits } } }).targets.DEV.limits;

const freePort = (): Promise<number> => new Promise((done, fail) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => done(port)); });
  server.on("error", fail);
});
async function waitForPort(port: number, limitMs = 30_000): Promise<void> {
  const end = Date.now() + limitMs;
  for (;;) {
    const open = await new Promise<boolean>((done) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); done(true); });
      socket.on("error", () => done(false));
    });
    if (open) return;
    if (Date.now() > end) throw new Error("the emulator did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("EMULATED cost baseline journey: real Terraform and aws provider, moto plus a test stub, limits contract", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "alz-sim-cost-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  const repo = process.cwd();
  let counter = 0;
  const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
  const KILL = join(root, "KILL");
  let moto: ChildProcess | undefined;
  let helper: ChildProcess | undefined;
  let motoPort = 0, stubPort = 0, proxyUrl = "", caFile = "", connectsLog = "";
  let ca: Buffer;
  let toolDir = "", contractPath = "", evidence = "";
  let env: NodeJS.ProcessEnv;
  let deps: ApplyDeps;

  /** One HTTPS request straight to a loopback port, with the given SNI and Host (never through the proxy). */
  const request = (port: number, host: string, method: string, path: string, headers: Record<string, string> = {}, body = ""): Promise<{ status: number; body: string }> =>
    new Promise((done, fail) => {
      const req = https.request({ host: "127.0.0.1", port, servername: host.split(":")[0], ca, method, path, agent: false,
        headers: { host, "content-length": String(Buffer.byteLength(body)), ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", fail);
      req.end(body);
    });
  /** moto accepts any signature; the access key decides the account, so the reader uses keys moto issued for a role in the account. */
  const signed = (service: string, accessKey: string): Record<string, string> => ({
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/20261101/us-east-1/${service}/aws4_request, SignedHeaders=host, Signature=${"0".repeat(64)}`,
  });
  const jsonCall = async (port: number, host: string, service: string, target: string, body: unknown, accessKey = "AKIAFAKEEMULATORONLY"): Promise<unknown> => {
    const response = await request(port, host, "POST", "/", { "content-type": "application/x-amz-json-1.1", "x-amz-target": target, ...signed(service, accessKey) },
      JSON.stringify(body));
    const parsed = response.body ? JSON.parse(response.body) as Record<string, unknown> : {};
    // The AWS CLI's error text, which the status reader classifies: "(<Type>) when calling ...".
    if (response.status !== 200) throw new Error("An error occurred (" + String(parsed.__type ?? response.status).split("#").pop() + ") when calling " + target + ": " + String(parsed.Message ?? parsed.message ?? ""));
    return parsed;
  };
  const connects = (): string[] => (existsSync(connectsLog) ? readFileSync(connectsLog, "utf8").split("\n").filter((l) => l.startsWith("CONNECT ")) : []);

  before(async () => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs
    for (const name of [ZIP, "terraform-provider-aws_6.68.0_SHA256SUMS", "terraform-provider-aws_6.68.0_SHA256SUMS.sig", "hashicorp.asc"]) {
      assert.ok(existsSync(join(PROVIDER_DIR as string, name)), "ALZ_SIM_AWS_PROVIDER_DIR lacks " + name);
    }
    // The zip must be the one HashiCorp's SHA256SUMS names (Terraform verifies the signature over that file itself).
    const sums = readFileSync(join(PROVIDER_DIR as string, "terraform-provider-aws_6.68.0_SHA256SUMS"), "utf8");
    const zipSha = createHash("sha256").update(readFileSync(join(PROVIDER_DIR as string, ZIP))).digest("hex");
    assert.ok(sums.includes(zipSha + "  " + ZIP), "the provider zip is not the one SHA256SUMS names");
    const free = statfsSync(root);
    assert.ok(free.bavail * free.bsize > 3 * 1024 ** 3, "the journey needs about 3 GB free while the engine steps run");

    toolDir = fresh("tools");
    symlinkSync(TERRAFORM as string, join(toolDir, "terraform"));
    const binarySha = createHash("sha256").update(readFileSync(TERRAFORM as string)).digest("hex");
    const engineVersion = (JSON.parse(execFileSync(TERRAFORM as string, ["version", "-json"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" })) as { terraform_version: string }).terraform_version;

    const emu = fresh("emulator");
    const key = join(emu, "key.pem");
    caFile = join(emu, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", caFile, "-subj", "/CN=alz-sim-cost",
      "-addext", "subjectAltName=" + SANS.map((name) => "DNS:" + name).join(",")], { stdio: "ignore" });
    ca = readFileSync(caFile);
    motoPort = await freePort();
    moto = spawn(MOTO as string, ["-H", "127.0.0.1", "-p", String(motoPort), "-c", caFile, "-k", key], { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: emu } });
    await waitForPort(motoPort);
    connectsLog = join(emu, "connects.log");
    helper = spawn(process.execPath, [join(repo, "test/helpers/cost-emulator.cjs"), String(motoPort), key, caFile, resolve(PROVIDER_DIR as string), connectsLog],
      { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH ?? "" } });
    const ports = await new Promise<{ proxyPort: number; stubPort: number }>((done, fail) => {
      helper!.once("error", fail);
      helper!.stdout?.once("data", (chunk: Buffer) => done(JSON.parse(chunk.toString().trim()) as { proxyPort: number; stubPort: number }));
      helper!.once("exit", () => fail(new Error("the emulator helper exited")));
    });
    stubPort = ports.stubPort;
    proxyUrl = "http://127.0.0.1:" + ports.proxyPort;
    assert.equal((await request(stubPort, "emulator.invalid", "POST", "/__emulator/account/" + ACCOUNT)).status, 200);
    const created = await request(motoPort, BUCKET + ".s3.us-east-1.amazonaws.com", "PUT", "/", signed("s3", "AKIAFAKEEMULATORONLY"));
    assert.equal(created.status, 200, "the state bucket exists in the emulator: " + created.body);

    // TEST FIXTURE, as in test/apply-emulated-aws.test.ts: the qualification attestation is forged because no person can attest an
    // emulator run. It records the REAL binary hash and version, and is never evidence of identity separation.
    const vault = fresh("qualification");
    for (const [adapterVersion, argvDigest] of [[APPLY_ADAPTER.adapterVersion, APPLY_ADAPTER.argvDigest], [ADAPTER_VERSION, terraformArgvDigest("TERRAFORM")]]) {
      const written = await writeQualificationEvidence({
        schemaVersion: 1, engine: "TERRAFORM", realEngine: true, backendIdentitySeparated: true,
        accountId: ACCOUNT, region: AWS_REGION, backend: AWS_DEV_TARGET.backend, workspace: "default",
        stateWriteClientId: awsRoleArn("STATE_WRITE", "DEV"), applyClientId: awsRoleArn("APPLY", "DEV"), terraformSha256: binarySha,
        adapterVersion, argvDigest, engineVersion, qualifiedAt: "2026-10-11T00:00:00.000Z",
      }, AWS, vault);
      assert.ok(written.ok, JSON.stringify(written));
    }
    contractPath = join(fresh("contract"), "act-pilot-contract.json");
    evidence = fresh("evidence");
    env = { ...awsIdentityEnv("DEV") };
    const tokens = fresh("tokens");
    for (const identity of ["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"]) {
      const tokenFile = join(tokens, identity.toLowerCase() + "-token");
      writeFileSync(tokenFile, TOKEN_CANARY + "\n", { mode: 0o600 });
      env["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"] = tokenFile;
    }
    env.ALZ_NETWORK_HTTPS_PROXY = proxyUrl;
    env.ALZ_NETWORK_SSL_CERT_FILE = caFile;
    deps = {
      contractPath, qualificationDir: vault, evidenceDir: evidence, nonces: openNonceStore(fresh("nonces")), env,
      now: () => NOW, scratchParent: fresh("scratch"), toolDirs: [toolDir, "/usr/bin", "/bin"], killPollMs: 100, killGraceMs: 30_000, sourceCommit: SOURCE_COMMIT,
    };
  });

  after(async () => {
    moto?.kill("SIGKILL");
    helper?.kill("SIGKILL");
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    removeTree(root);
  });

  /** A SYNTHETIC limits contract: the fixture contract with the given limits on every target in place of the canary. */
  const writeLimitsContract = (limits: Limits): void => {
    const base = awsContractJson(KILL, { policyVersion: POLICY });
    writeReviewedContract(contractPath, { ...base, targets: Object.fromEntries(Object.entries(base.targets).map(([environment, target]) => {
      const { canary: _canary, ...rest } = target as Record<string, unknown>;
      return [environment, { ...rest, limits }];
    })) });
  };
  const prepareDeps = () => ({ contractPath, qualificationDir: deps.qualificationDir, toolDirs: [toolDir] });

  /** The project, prepared twice as for the canary: the second pass binds the unit tags the first printed. */
  async function preparedProject(): Promise<{ projectRoot: string; prepared: Prepared }> {
    const projectRoot = join(fresh("built"), "project");
    writeCostBaselineProject({ config: CONFIG, projectRoot, region: AWS_REGION, previewArtifactSha256: sha256(renderAwsCostBaseline(CONFIG).terraform) });
    copyFileSync(join(projectRoot, "terraform.tfvars.example.json"), join(projectRoot, "terraform.tfvars.json"));
    const first = await prepareApply({ environment: "DEV", projectRoot }, prepareDeps());
    assert.ok(first.ok, first.ok ? "" : first.code + " " + first.message);
    const tfvars = JSON.parse(readFileSync(join(projectRoot, "terraform.tfvars.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(projectRoot, "terraform.tfvars.json"), JSON.stringify({ ...tfvars, unit_tags: first.summary.unit.tags }, null, 2) + "\n");
    const prepared = await prepareApply({ environment: "DEV", projectRoot }, prepareDeps());
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.code + " " + prepared.message);
    return { projectRoot, prepared };
  }
  const seal = (p: { projectRoot: string; prepared: Prepared }) => sealPreview({
    invocation: human(AWS_DEV_TARGET), environment: "DEV", target: AWS_DEV_TARGET, manifest: p.prepared.manifest, projectRoot: p.projectRoot,
    policyVersion: p.prepared.request.policyVersion, resolved: p.prepared.request.resolved, requester: REQUESTER,
  }, deps);

  const rendered = renderAwsCostBaseline(CONFIG).metadata.creates;

  it("EMULATED: the build's preview driver plans the rendered baseline with the reviewed lock: create-only, exactly the rendered addresses", () => {
    const folder = fresh("preview");
    const tokenFile = env.ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE as string;
    const hcl = renderAwsCostBaseline(CONFIG).terraform;
    const result = costBaselinePreview(folder, hcl, SOURCE_COMMIT, reviewedAwsLock(join(repo)), {
      terraform: TERRAFORM,
      // The driver passes its environment on; here it is only the emulator's network settings and a DISCOVERY-like web identity.
      env: { PATH: "/usr/bin:/bin", HOME: fresh("home"), HTTPS_PROXY: proxyUrl, SSL_CERT_FILE: caFile, TF_VAR_aws_region: AWS_REGION,
        AWS_ROLE_ARN: awsRoleArn("DISCOVERY", "DEV"), AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile, AWS_REGION, AWS_EC2_METADATA_DISABLED: "true" },
    });
    assert.deepEqual(result.createdAddresses, rendered.map((c) => c.address));
    assert.equal(result.createOnly, true);
    assert.equal(result.validatedArtifactHash, sha256(hcl));
    removeTree(join(folder, ".terraform"));
  });

  it("EMULATED refusal: limits that leave out one rendered type stop the seal with RESOURCE_NOT_IN_LIMITS, and nothing is sealed", async () => {
    writeLimitsContract({ ...EXAMPLE_LIMITS, resources: EXAMPLE_LIMITS.resources.filter((r) => r.type !== "aws_sns_topic_subscription") });
    const result = await seal(await preparedProject());
    assert.equal(result.ok, false);
    const refusal = result as { code: string; message: string };
    assert.equal(refusal.code, "RESOURCE_NOT_IN_LIMITS", refusal.message);
    assert.match(refusal.message, /aws_sns_topic_subscription/);
    assert.ok(!("path" in refusal), "no sealed plan path is returned");
  });

  // Bounded: a host the emulator does not serve makes the provider retry, so the step fails here instead of waiting forever.
  it("EMULATED journey: prepare, seal under the example's limits, approve, apply, then the cost status read back through the emulator", { timeout: 15 * 60_000 }, async () => {
    writeLimitsContract(EXAMPLE_LIMITS);
    const project = await preparedProject();
    const sealed = await seal(project);
    assert.ok(sealed.ok, JSON.stringify(sealed));
    assert.deepEqual(sealed.sealed.changes.map((c) => [c.address, c.action]), rendered.map((c) => [c.address, "CREATE"]));
    assert.equal(sealed.sealed.unit?.unitId, project.prepared.summary.unit.unitId);
    const loaded = await loadSealedPlan(sealed.path);
    assert.ok(loaded.ok);
    const applied = await runApply({
      invocation: human(AWS_DEV_TARGET), environment: "DEV", target: { ...AWS_DEV_TARGET }, sealedPlan: { sealed: loaded.sealed, planBytes: loaded.planBytes },
      manifest: project.prepared.manifest, projectRoot: project.projectRoot, approvals: [approvalFor(sealed.sealed, "alice")],
    }, deps);
    assert.ok(applied.ok, JSON.stringify(applied));
    const record = await readEncryptedEvidence<ApplyEvidence>(join(evidence, sealed.sealed.artifactSha256 + ".apply.evidence"));
    assert.equal(record.outcome, "SUCCEEDED");
    assert.ok(!JSON.stringify(record).includes(TOKEN_CANARY) && !JSON.stringify(applied).includes(TOKEN_CANARY), "no token in the result or evidence");

    // The state the apply wrote to the emulated backend names every rendered resource.
    const state = await request(motoPort, BUCKET + ".s3.us-east-1.amazonaws.com", "GET", "/" + STATE_KEY, signed("s3", "AKIAFAKEEMULATORONLY"));
    assert.equal(state.status, 200, state.body);
    const inState = (JSON.parse(state.body) as { resources: { mode: string; type: string; name: string; instances: { index_key?: string }[] }[] }).resources
      .filter((r) => r.mode === "managed").flatMap((r) => r.instances.map((i) => r.type + "." + r.name + (i.index_key !== undefined ? '["' + i.index_key + '"]' : "")));
    assert.deepEqual(inState.sort(), rendered.map((c) => c.address));

    // The emulated reader: each cost read the broker would run, sent as its API call to the emulator that serves it.
    const assumed = await request(motoPort, "sts.us-east-1.amazonaws.com", "POST", "/", { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: awsRoleArn("DISCOVERY", "DEV"), RoleSessionName: "cost-status", WebIdentityToken: "emulated" }).toString());
    const accessKey = /<AccessKeyId>([A-Z0-9]+)<\/AccessKeyId>/.exec(assumed.body)?.[1];
    assert.ok(accessKey, "moto issued keys for the DISCOVERY role in the fixture account");
    const read: CostRead = async (r) => {
      const n = r.notification as Record<string, string> | undefined;
      const notification = n && { NotificationType: n.notificationType, ComparisonOperator: n.comparisonOperator, Threshold: Number(n.threshold), ThresholdType: n.thresholdType };
      const budgets = (op: string, body: unknown) => jsonCall(stubPort, "budgets.amazonaws.com", "budgets", "AWSBudgetServiceGateway." + op, body);
      const exportsCall = (op: string, body: unknown) => jsonCall(stubPort, "bcm-data-exports.us-east-1.api.aws", "bcm-data-exports", "AWSBillingAndCostManagementDataExports." + op, body);
      switch (r.tool) {
        case "aws_budgets_describe_budgets": return budgets("DescribeBudgets", { AccountId: r.accountId });
        case "aws_budgets_describe_notifications": return budgets("DescribeNotificationsForBudget", { AccountId: r.accountId, BudgetName: r.budgetName });
        case "aws_budgets_describe_subscribers": return budgets("DescribeSubscribersForNotification", { AccountId: r.accountId, BudgetName: r.budgetName, Notification: notification });
        case "aws_bcm_list_exports": return exportsCall("ListExports", {});
        case "aws_bcm_get_export": return exportsCall("GetExport", { ExportArn: r.exportArn });
        case "aws_bcm_list_executions": return exportsCall("ListExecutions", { ExportArn: r.exportArn });
        // Sent to moto, which has no such call: the answer is moto's own refusal, never a filled-in list.
        case "aws_ce_list_cost_allocation_tags": return jsonCall(motoPort, "tagging.us-east-1.amazonaws.com", "ce", "AWSInsightsIndexService.ListCostAllocationTags", { Type: "UserDefined" }, accessKey);
        case "aws_tagging_get_resources": return jsonCall(motoPort, "tagging.us-east-1.amazonaws.com", "tagging", "ResourceGroupsTaggingAPI_20170126.GetResources",
          { TagFilters: [{ Key: "alz-unit", Values: [r.unitId] }] }, accessKey);
      }
      throw new Error("no emulated answer for " + r.tool);
    };
    const status = await readCostStatus(costRequestOf(CONFIG, { accountId: ACCOUNT, unitId: project.prepared.summary.unit.unitId, region: AWS_REGION }), read, new Date());
    // Observed from the emulator: the budget as configured, every alert, and its SNS subscriber.
    assert.equal(status.budget.state, "PRESENT");
    assert.deepEqual(status.budget.limit, { label: "OBSERVED", value: { amount: CONFIG.budget.amount, unit: CONFIG.budget.currency } });
    assert.equal(status.budget.notifications.label, "OBSERVED");
    const notes = status.budget.notifications.label === "OBSERVED" ? status.budget.notifications.value : [];
    assert.equal(notes.length, CONFIG.budget.actualThresholds.length + CONFIG.budget.forecastThresholds.length);
    // A new budget has no calculated spend yet, and the export has not delivered: waiting, never zero and never complete.
    assert.equal(status.budget.actualSpend.label, "UNKNOWN");
    assert.equal(status.export.state, "WAITING");
    // moto has no ListCostAllocationTags: that part is UNKNOWN, so the whole status is not complete.
    assert.equal(status.costAllocationTags.state, "UNKNOWN", JSON.stringify(status.costAllocationTags));
    assert.notEqual(status.overall, "OBSERVED_COMPLETE");
    // The tagging API read is moto's own answer for the unit's tag: the SNS topic carries every required tag. moto lists S3 bucket
    // tags written through S3 Control separately, so the export bucket may be absent here; that is the emulator, not AWS.
    assert.equal(status.tags.resources.label, "OBSERVED", JSON.stringify(status.tags));
    const tagged = status.tags.resources.label === "OBSERVED" ? status.tags.resources.value : [];
    const topic = tagged.find((t) => t.arn.includes(":sns:"));
    assert.ok(topic, "the unit-tagged SNS topic is listed: " + JSON.stringify(tagged));
    assert.deepEqual(topic.missing, []);
    assert.equal(status.actEnabled, false);

    // Every connection went to a host the emulator serves; anything else was refused (Terraform's version check is attempted and refused).
    const refused = connects().filter((line) => line.endsWith(" REFUSED")).map((line) => line.split(" ")[1]);
    assert.deepEqual([...new Set(refused)].filter((host) => host !== "checkpoint-api.hashicorp.com:443"), [], "no other host was contacted");
    assert.ok(connects().some((line) => line.startsWith("CONNECT budgets.amazonaws.com")) && connects().some((line) => line.startsWith("CONNECT bcm-data-exports.")),
      "the provider reached the stubbed Budgets and Data Exports endpoints");
  });
});
