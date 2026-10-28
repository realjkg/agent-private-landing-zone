import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { signApproval } from "../src/apply/approval.js";
import { buildCleanupProposal, signCleanupProposal, type CleanupProposal } from "../src/apply/cleanup-proposal.js";
import { loadPilotContract } from "../src/apply/contract.js";
import { runApply, runCleanup, sealPreview, type ApplyDeps, type ApplyRequest } from "../src/apply/driver.js";
import { CDK } from "../src/apply/engines/cdk.js";
import { openNonceStore } from "../src/apply/nonces.js";
import { loadRunRecords, observeRun, verifyProposalLeftovers, type ObserveDeps } from "../src/apply/observe.js";
import { readBlueprintRecord } from "../src/apply/run-records.js";
import { loadSealedPlan, reviewBundleOf, verifyReviewBundle } from "../src/apply/seal.js";
import type { ApplyEvidence, ApplyResult, PilotContract, SignedApproval } from "../src/apply/types.js";
import { readEncryptedEvidence } from "../src/evidence/vault.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { canonicalJson } from "../src/teardown/manifest.js";
import { sha256 } from "../src/util/sha256.js";
import { AWS_REGION, NOW, POLICY, REQUESTER, SOURCE_COMMIT, approvalFor, human, keys, writeReviewedContract } from "./helpers/apply-fixtures.js";
import { CDK_CANARIES, STACK, cdkContractJson, cdkIdentityEnv, cdkTargetOf, forgeCdkQualification, writeAssembly } from "./helpers/cdk-fixtures.js";

/**
 * OPT-IN SIMULATION, SYNTHETIC / EMULATED (docs/act-pilot-simulation-cdk.md). Path 2 of docs/act-dev-paths.md: the CDK engine
 * (src/apply/engines/cdk.ts) run by the REAL pinned AWS CLI v2 (config/tool-pins.json `awsCli`) against a LOCAL moto server's
 * CloudFormation, STS, tagging and logs. Skipped unless BOTH ALZ_SIM_AWS_CLI (the `aws` program of a pinned AWS CLI v2 install) and
 * ALZ_SIM_MOTO (the `moto_server` executable of a moto[server] install; the venv's own `python` next to it runs the launcher) are
 * set, so default CI is unaffected. This is not G2: no real AWS account, role, token or service is involved, and nothing is paid.
 *
 * It drives the real src/apply driver (seal, approve, apply, evidence, ledger, observe, cleanup proposal, cleanup, leftover check)
 * through the product's own identity variables (`ALZ_<IDENTITY>_AWS_ROLE_ARN` and a web identity token file per identity, fake
 * roles in the fixture's fake DEV account) and a loopback CONNECT proxy that sends only the emulated AWS hostnames to moto.
 *
 * HARNESS SHIMS (the launcher below; each is a moto gap, so the fact it touches is NOT verified here and stays for the live G2):
 *   1. GetTemplate by ChangeSetName: moto 5.2 reads StackName only. The shim returns the change set's own template.
 *   2. DescribeChangeSet Tags: moto keeps a change set's tags but serializes none. The shim gives them back as Key/Value pairs.
 *   3. UpdateTerminationProtection: moto has no handler. It is the person's step after the first create, never the product's.
 *   4. Cloud Control GetResource, for AWS::Logs::LogGroup only, answered from moto's own logs backend: moto has no Cloud Control.
 *   5. An optional hook that writes the kill switch when moto receives ExecuteChangeSet (the "kill during" scenario).
 * Trust: the bundled CLI ignores SSL_CERT_FILE (and the apply profile refuses AWS_CA_BUNDLE), so the emulator's throwaway CA is
 * trusted by a per-run shadow of the CLI install whose `botocore/cacert.pem` has the CA appended. The `aws` program itself is a
 * byte copy: its hash is the real binary's.
 *
 * DEV MODE ONLY setup (never an operator step; operators use ./alz):
 *   curl -O https://awscli.amazonaws.com/awscli-exe-linux-x86_64-2.38.6.zip (and .sig; verify with the AWS CLI team's PGP key)
 *   unzip, then ./aws/install -i <scratch>/aws-cli -b <scratch>/bin
 *   python3 -m venv <scratch>/moto && <scratch>/moto/bin/pip install "moto[server,cloudformation]"
 *   ALZ_SIM_AWS_CLI=<scratch>/bin/aws ALZ_SIM_MOTO=<scratch>/moto/bin/moto_server npx tsx --test test/apply-emulated-cdk.test.ts
 */
const AWS_CLI = process.env.ALZ_SIM_AWS_CLI;
const MOTO = process.env.ALZ_SIM_MOTO;
const SKIP = !AWS_CLI || !MOTO ? "set ALZ_SIM_AWS_CLI and ALZ_SIM_MOTO to run the CDK emulated simulation (docs/act-pilot-simulation-cdk.md)" : false;

const DEV_ACCOUNT = cdkTargetOf("DEV").account;
/** The hosts the pinned CLI reaches for this region: regional STS for the web identity, CloudFormation, the tagging API and Cloud Control. */
const HOSTS = ["sts", "cloudformation", "tagging", "cloudcontrolapi"].map((service) => service + "." + AWS_REGION + ".amazonaws.com");
const EMULATED = HOSTS.map((host) => host + ":443");
/** The dummy web identity token: not a real token, and never allowed to appear in any result. */
const TOKEN_CANARY = "emulated-not-a-real-token-CANARY_WEB_IDENTITY_CDK";
/** The minimal workload: the path 1 canary log group (a reviewed leaf type), and a resource of a type nobody reviewed as a leaf, which a cleanup holds. */
const CANARY = "CanaryLogGroup";
const HELD = "HeldRule";
const WORKLOAD = {
  [CANARY]: { Type: "AWS::Logs::LogGroup", Properties: { RetentionInDays: 1 } },
  [HELD]: { Type: "AWS::Events::Rule", Properties: { ScheduleExpression: "rate(1 day)", State: "DISABLED" } },
};
const SECOND = "SecondLogGroup";

const LAUNCHER = `
import io, json, os, sys
from werkzeug.serving import run_simple
from werkzeug.wrappers import Request, Response
from moto.moto_server.werkzeug_app import DomainDispatcherApplication, create_backend_app
from moto.cloudformation import models as cfn_models
from moto.cloudformation.responses import CloudFormationResponse
from moto.core.responses import ActionResult
from moto.logs.models import logs_backends

host, port, cert, key, arm, kill = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6]

# SHIM 1: GetTemplate by ChangeSetName.
_get_template = CloudFormationResponse.get_template
def get_template(self):
    name = self._get_param("ChangeSetName")
    if name and not self._get_param("StackName"):
        change_set = self.cloudformation_backend.describe_change_set(change_set_name=name)
        return ActionResult({"TemplateBody": change_set.template, "StagesAvailable": ["Original", "Processed"]})
    return _get_template(self)
CloudFormationResponse.get_template = get_template

# SHIM 2: DescribeChangeSet echoes the change set's tags.
_create_change_set = cfn_models.CloudFormationBackend.create_change_set
def create_change_set(self, *args, **kwargs):
    change_set_id, stack_id = _create_change_set(self, *args, **kwargs)
    self.change_sets[change_set_id].tags = [{"Key": k, "Value": v} for k, v in (kwargs.get("tags") or {}).items()]
    return change_set_id, stack_id
cfn_models.CloudFormationBackend.create_change_set = create_change_set

# SHIM 3: UpdateTerminationProtection, the person's step.
def update_termination_protection(self):
    stack = self.cloudformation_backend.get_stack(self._get_param("StackName"))
    stack.enable_termination_protection = str(self._get_param("EnableTerminationProtection")).lower() == "true"
    return ActionResult({"StackId": stack.stack_id})
CloudFormationResponse.update_termination_protection = update_termination_protection

app = DomainDispatcherApplication(create_backend_app)

def state():
    # The harness's own read of moto's backends (never an AWS API): live stacks, change sets and log groups.
    stacks, change_sets, groups = [], [], []
    for account in list(cfn_models.cloudformation_backends.keys()):
        for _region, backend in cfn_models.cloudformation_backends[account].items():
            stacks += [{"name": s.name, "id": s.stack_id, "status": s.status, "protection": s.enable_termination_protection} for s in backend.stacks.values()]
            change_sets += [{"id": c.change_set_id, "execution": c.execution_status} for c in backend.change_sets.values()]
    for account in list(logs_backends.keys()):
        for _region, backend in logs_backends[account].items():
            groups += list(backend.groups.keys())
    return {"stacks": stacks, "changeSets": change_sets, "groups": sorted(groups)}

def emulator(environ, start_response):
    request = Request(environ)
    if request.path == "/alz-sim/state":
        return Response(json.dumps(state()), content_type="application/json")(environ, start_response)
    target = request.headers.get("X-Amz-Target", "")
    # SHIM 5: the kill switch appears as CloudFormation receives the execution, when the harness armed it.
    if not target and os.path.exists(arm):
        data = request.get_data()
        environ["wsgi.input"], environ["CONTENT_LENGTH"] = io.BytesIO(data), str(len(data))
        if b"Action=ExecuteChangeSet" in data:
            open(kill, "w").write("stop")
        request = Request(environ)
    if not target.startswith("CloudApiService."):
        return app(environ, start_response)
    # SHIM 4: Cloud Control GetResource for AWS::Logs::LogGroup, from moto's own logs backend.
    def reply(status, body):
        return Response(json.dumps(body), status=status, content_type="application/x-amz-json-1.0")(environ, start_response)
    body = json.loads(request.get_data() or b"{}")
    if target != "CloudApiService.GetResource" or body.get("TypeName") != "AWS::Logs::LogGroup":
        return reply(400, {"__type": "UnsupportedActionException", "message": "not emulated"})
    identifier = body.get("Identifier")
    for account in list(logs_backends.keys()):
        for _region, backend in logs_backends[account].items():
            if identifier in backend.groups:
                return reply(200, {"TypeName": body["TypeName"], "ResourceDescription": {"Identifier": identifier, "Properties": json.dumps({"LogGroupName": identifier})}})
    return reply(400, {"__type": "ResourceNotFoundException", "message": "Resource not found"})

run_simple(host, port, emulator, threaded=True, ssl_context=(cert, key))
`;

const HELPER = `
const http = require("node:http"), net = require("node:net"), fs = require("node:fs");
const [motoPort, log, ...hosts] = process.argv.slice(2);
const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
proxy.on("connect", (req, client, head) => {
  client.on("error", () => client.destroy());
  fs.appendFileSync(log, req.url + "\\n");
  if (!hosts.includes(req.url)) { client.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n"); return; }
  const upstream = net.connect(Number(motoPort), "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\\r\\n\\r\\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
});
proxy.on("clientError", (_error, socket) => socket.destroy());
proxy.listen(0, "127.0.0.1", () => process.stdout.write(String(proxy.address().port) + "\\n"));
`;

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
  server.on("error", reject);
});
async function waitForPort(port: number, limitMs = 60_000): Promise<void> {
  const end = Date.now() + limitMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    if (Date.now() > end) throw new Error("the emulator did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A shadow of the CLI install: every file linked, the `aws` program copied byte for byte, and botocore's CA bundle with the emulator's CA appended. */
function shadowCli(aws: string, caFile: string, into: string): string {
  const dist = dirname(aws);
  const bundle = join(dist, "awscli", "botocore", "cacert.pem");
  assert.ok(existsSync(bundle), "ALZ_SIM_AWS_CLI must resolve to the `aws` program inside a pinned AWS CLI v2 install (dist/aws)");
  const link = (from: string, to: string, skip: string) => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) if (name !== skip) symlinkSync(join(from, name), join(to, name));
  };
  link(dist, into, "awscli");
  rmSync(join(into, "aws"));
  copyFileSync(aws, join(into, "aws"));
  link(join(dist, "awscli"), join(into, "awscli"), "botocore");
  link(join(dist, "awscli", "botocore"), join(into, "awscli", "botocore"), "cacert.pem");
  writeFileSync(join(into, "awscli", "botocore", "cacert.pem"), Buffer.concat([readFileSync(bundle), readFileSync(caFile)]));
  return into;
}

type Emulator = { proxyUrl: string; motoPort: number; connects(): string[]; resetConnects(): void; moto(method: string, path: string): Promise<{ status: number; body: string }>; stop(): void };

async function startEmulator(dir: string, arm: string, kill: string): Promise<Emulator & { caFile: string }> {
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", key, "-out", cert, "-subj", "/CN=alz-sim-cdk",
    "-addext", "subjectAltName=" + [...HOSTS, "localhost"].map((h) => "DNS:" + h).join(",")], { stdio: "ignore" });
  const motoPort = await freePort();
  const launcher = join(dir, "launcher.py");
  writeFileSync(launcher, LAUNCHER);
  const python = join(dirname(MOTO as string), "python");
  const moto: ChildProcess = spawn(python, ["-I", launcher, "127.0.0.1", String(motoPort), cert, key, arm, kill],
    { stdio: "ignore", env: { PATH: process.env.PATH ?? "", HOME: dir } });
  await waitForPort(motoPort);
  const helperPath = join(dir, "helper.cjs"), connectsLog = join(dir, "connects.log");
  writeFileSync(helperPath, HELPER);
  const helper: ChildProcess = spawn(process.execPath, [helperPath, String(motoPort), connectsLog, ...EMULATED], { stdio: ["ignore", "pipe", "inherit"] });
  const proxyPort = await new Promise<number>((resolve, reject) => {
    helper.once("error", reject);
    helper.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    helper.once("exit", () => reject(new Error("the proxy helper exited")));
  });
  const ca = readFileSync(cert);
  // Direct requests to moto's own management API (reset, data dump), never through the proxy and never an AWS API.
  const motoCall: Emulator["moto"] = (method, path) => new Promise((resolve, reject) => {
    const request = https.request({ host: "127.0.0.1", port: motoPort, servername: "localhost", ca, method, path, headers: { host: "localhost" } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
  return {
    proxyUrl: "http://127.0.0.1:" + proxyPort, motoPort, caFile: cert, moto: motoCall,
    connects: () => (existsSync(connectsLog) ? readFileSync(connectsLog, "utf8").split("\n").filter(Boolean) : []),
    resetConnects: () => rmSync(connectsLog, { force: true }),
    stop() { moto.kill("SIGKILL"); helper.kill("SIGKILL"); },
  };
}

describe("CDK emulated simulation: the real pinned AWS CLI against moto CloudFormation (SYNTHETIC / emulated, not G2)", { skip: SKIP }, () => {
  const root = mkdtempSync(join(tmpdir(), "alz-sim-cdk-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  const KILL = join(root, "KILL");
  const ARM = join(root, "ARM_KILL_ON_EXECUTE");
  let emulator: Emulator;
  let toolDir = "";
  let engineVersion = "";
  let counter = 0;
  const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
  let env: NodeJS.ProcessEnv;
  let vault = "";
  let tokens = "";

  before(async () => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs
    const aws = AWS_CLI as string;
    assert.ok(existsSync(aws), "ALZ_SIM_AWS_CLI does not exist");
    const pins = JSON.parse(readFileSync(fileURLToPath(new URL("../config/tool-pins.json", import.meta.url)), "utf8")) as { awsCli: { version: string } };
    const started = await startEmulator(fresh("emulator"), ARM, KILL);
    emulator = started;
    toolDir = shadowCli(realAws(aws), started.caFile, join(fresh("tools"), "aws-cli"));
    engineVersion = /^aws-cli\/([0-9.]+) /.exec(execFileSync(join(toolDir, "aws"), ["--version"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" }))?.[1] ?? "";
    assert.equal(engineVersion, pins.awsCli.version, "the harness runs the pinned AWS CLI version (config/tool-pins.json awsCli)");
    const binarySha = createHash("sha256").update(readFileSync(join(toolDir, "aws"))).digest("hex");
    assert.equal(binarySha, createHash("sha256").update(readFileSync(realAws(aws))).digest("hex"), "the shadow's aws program is the real binary");

    // TEST FIXTURE: forged qualification records the REAL binary hash and version. No person can attest an emulator run; this is not identity-separation evidence.
    vault = fresh("qualification");
    await forgeCdkQualification(vault, undefined, { terraformSha256: binarySha, engineVersion });

    // The product's own identity variables: one fake role per identity in the fake DEV account, each with its own (dummy) web identity token file.
    env = { ...cdkIdentityEnv("DEV") };
    tokens = fresh("tokens");
    for (const identity of ["DISCOVERY", "CHANGESET", "APPLY"]) {
      const file = join(tokens, identity.toLowerCase() + "-token");
      writeFileSync(file, TOKEN_CANARY + "\n", { mode: 0o600 });
      env["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"] = file;
    }
    // Network settings reach the child only as ALZ_NETWORK_*: the proxy sends the emulated hostnames to loopback and refuses every other host.
    env.ALZ_NETWORK_HTTPS_PROXY = emulator.proxyUrl;
  });

  after(() => {
    emulator?.stop();
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    removeTree(root);
  });

  /** Every scenario starts from an empty emulator, no kill switch and an empty connection log. */
  beforeEach(async () => {
    assert.equal((await emulator.moto("POST", "/moto-api/reset")).status, 200);
    rmSync(KILL, { force: true });
    rmSync(ARM, { force: true });
    emulator.resetConnects();
  });

  type World = { deps: ApplyDeps; contractPath: string; evidence: string; scratch: string };
  /** Owner decision E1: the contract names, as every target's canary allowlist, exactly the resources the workload creates (`WORKLOAD_CANARY` by default). */
  const withAllowlist = (resources: unknown[]) => {
    const contract = cdkContractJson(KILL) as { targets: Record<string, Record<string, unknown>> };
    for (const t of Object.values(contract.targets)) t.canary = { resources };
    return contract;
  };
  const WORKLOAD_CANARY = [{ type: "AWS::Logs::LogGroup", count: 1 }, { type: "AWS::Events::Rule", count: 1 }];
  function world(): World {
    const contractPath = join(fresh("contract"), "act-pilot-contract.json");
    writeReviewedContract(contractPath, withAllowlist(WORKLOAD_CANARY));
    const evidence = fresh("evidence"), scratch = fresh("scratch");
    return {
      contractPath, evidence, scratch,
      deps: {
        sourceCommit: SOURCE_COMMIT, contractPath, qualificationDir: vault, evidenceDir: evidence,
        nonces: openNonceStore(fresh("nonces")), env, now: () => NOW, scratchParent: scratch, toolDirs: [toolDir], killPollMs: 100, killGraceMs: 5_000,
      },
    };
  }
  const target = cdkTargetOf("DEV");
  const assembly = (resources: Record<string, unknown> = WORKLOAD) => writeAssembly(fresh("assembly"), target, {
    engineVersion, mutate: (files) => { files[STACK + ".template.json"].Resources = resources; },
  });
  async function seal(w: World, resources?: Record<string, unknown>) {
    const p = assembly(resources);
    const result = await sealPreview({
      invocation: human(target), environment: "DEV", target, manifest: p.manifest, projectRoot: p.projectRoot, policyVersion: POLICY, resolved: p.resolved, requester: REQUESTER,
    }, w.deps);
    return { result, project: p };
  }
  async function sealed(w: World, resources?: Record<string, unknown>) {
    const { result, project } = await seal(w, resources);
    assert.ok(result.ok, JSON.stringify(result));
    const loaded = await loadSealedPlan(result.path);
    assert.ok(loaded.ok);
    return { sealed: result.sealed, project, loaded: { sealed: loaded.sealed, planBytes: loaded.planBytes } };
  }
  type Sealed = Awaited<ReturnType<typeof sealed>>;
  const requestFor = (s: Sealed, approvals: SignedApproval[]): ApplyRequest => ({
    invocation: human(target), environment: "DEV", target: { ...target }, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals,
  });
  const run = (w: World, s: Sealed, who: "alice" | "bob" = "alice"): Promise<ApplyResult> => runApply(requestFor(s, [approvalFor(s.sealed, who)]), w.deps);
  const stored = (w: World, s: Sealed) => readEncryptedEvidence<ApplyEvidence>(join(w.evidence, s.sealed.artifactSha256 + ".apply.evidence"));
  const recordOf = (s: Sealed) => JSON.parse(s.loaded.planBytes.toString("utf8")) as Record<string, string>;
  const noSecrets = (value: unknown): void => {
    const text = JSON.stringify(value);
    for (const secret of [TOKEN_CANARY, "operator-ambient-aws-secret", "AKIAFAKEOPERATORKEY00", ...CDK_CANARIES]) assert.ok(!text.includes(secret), "output carries " + secret.slice(0, 12));
  };
  /** Only the emulated hosts were ever asked for, and the ones a step needs were. */
  const onlyEmulated = (needed: string[]): void => {
    const contacted = [...new Set(emulator.connects())].sort();
    assert.deepEqual(contacted.filter((c) => !EMULATED.includes(c)), [], "no host other than the emulator was asked for: " + contacted.join(" "));
    for (const host of needed) assert.ok(contacted.includes(host + ":443"), host + " was contacted: " + contacted.join(" "));
  };

  /** moto's own view of the account: live stacks, change sets and log groups (the launcher's read of its backends, never an AWS call). */
  async function cloud() {
    const state = JSON.parse((await emulator.moto("GET", "/alz-sim/state")).body) as {
      stacks: { name: string; id: string; status: string; protection: boolean }[]; changeSets: { id: string; execution: string }[]; groups: string[];
    };
    return { ...state, stacks: state.stacks.filter((stack) => stack.status !== "DELETE_COMPLETE") };
  }
  /** The person's own call with the real CLI, as a person role in the fake DEV account (through the same proxy): never the product's. */
  function person(args: string[]): string {
    const tokenFile = join(tokens, "person-token");
    writeFileSync(tokenFile, TOKEN_CANARY + "\n", { mode: 0o600 });
    return execFileSync(join(toolDir, "aws"), [...args, "--region", AWS_REGION, "--output", "json", "--no-cli-pager"], {
      encoding: "utf8", env: {
        // A private HOME per call: the CLI caches assumed-role credentials under ~/.aws/cli/cache, which would outlive an emulator reset.
        PATH: "/usr/bin:/bin", HOME: fresh("person-home"), HTTPS_PROXY: emulator.proxyUrl, AWS_EC2_METADATA_DISABLED: "true", AWS_REGION, AWS_WEB_IDENTITY_TOKEN_FILE: tokenFile,
        AWS_ROLE_ARN: "arn:aws:iam::" + DEV_ACCOUNT + ":role/alz-sim-person",
      },
    });
  }
  const protect = (): string => person(["cloudformation", "update-termination-protection", "--stack-name", STACK, "--enable-termination-protection"]);

  // --- the path, against the real CLI ----------------------------------------------------------------------

  it("seals: the real CLI creates one CREATE change set as CHANGESET in the contract's account, describes it, proves its template, and nothing is executed", async () => {
    const w = world();
    const s = await sealed(w);
    assert.deepEqual(s.sealed.changes, [{ address: CANARY, type: "AWS::Logs::LogGroup", action: "CREATE" }, { address: HELD, type: "AWS::Events::Rule", action: "CREATE" }]);
    const record = recordOf(s);
    assert.equal(record.changeSetType, "CREATE");
    assert.match(record.changeSetId, new RegExp("^arn:aws:cloudformation:" + AWS_REGION + ":" + DEV_ACCOUNT + ":changeSet/alz-[0-9a-f]{12}/[0-9a-f-]{36}$"), "the change set is in the web identity role's account");
    assert.match(record.stackId, new RegExp("^arn:aws:cloudformation:" + AWS_REGION + ":" + DEV_ACCOUNT + ":stack/" + STACK + "/[0-9a-f-]{36}$"));
    assert.deepEqual(record.capabilities, [], "a template without an IAM resource is given no capability, and the CLI's null Capabilities reads as none");
    assert.ok(verifyReviewBundle(JSON.parse(JSON.stringify(reviewBundleOf(s.sealed)))).ok);
    noSecrets(s.sealed);
    const now = await cloud();
    assert.deepEqual(now.stacks.map((stack) => [stack.name, stack.status]), [[STACK, "REVIEW_IN_PROGRESS"]], "a CREATE change set leaves the stack in REVIEW_IN_PROGRESS");
    assert.deepEqual(now.changeSets.map((c) => c.execution), ["AVAILABLE"], "sealing executes nothing");
    assert.deepEqual(now.groups, [], "no resource exists before the apply");
    onlyEmulated([HOSTS[0], HOSTS[1]]);
  });

  it("applies the sealed change set end to end: the stack completes, the log group exists, evidence and blueprint are written, nothing leaks, and a second apply is refused", async () => {
    const w = world();
    const s = await sealed(w);
    const result = await run(w, s);
    assert.ok(result.ok, JSON.stringify(result));
    noSecrets(result);
    const evidence = await stored(w, s);
    assert.equal(evidence.outcome, "SUCCEEDED");
    assert.equal(evidence.toolVersions.engine, engineVersion);
    assert.equal(evidence.authority.mutation, "CLOUDFORMATION_EXECUTE_OF_SEALED_CHANGE_SET");
    noSecrets(evidence);
    const now = await cloud();
    assert.deepEqual(now.stacks.map((stack) => [stack.name, stack.status]), [[STACK, "CREATE_COMPLETE"]]);
    assert.deepEqual(now.changeSets.map((c) => c.execution), ["EXECUTE_COMPLETE"]);
    assert.equal(now.groups.length, 1);
    assert.match(now.groups[0], new RegExp("^" + STACK + "-" + CANARY + "-"));
    // The blueprint: describe-stack-resources as DISCOVERY, logical id to physical id, the log group's ARN derived, the stack as the container.
    const blueprint = await readBlueprintRecord(s.sealed.artifactSha256, sha256(canonicalJson(result.evidence as never)), w.evidence);
    assert.ok(blueprint);
    assert.equal(blueprint.source, "CLOUDFORMATION_STACK_RESOURCES");
    assert.deepEqual(blueprint.blueprint.entries.map((e) => [e.address, e.type, e.id, e.origin]), [[CANARY, "AWS::Logs::LogGroup", now.groups[0], "IN_PLAN"], [HELD, "AWS::Events::Rule", blueprint.blueprint.entries[1].id, "IN_PLAN"]]);
    assert.equal(blueprint.blueprint.entries[0].arn, "arn:aws:logs:" + AWS_REGION + ":" + DEV_ACCOUNT + ":log-group:" + now.groups[0]);
    assert.equal(blueprint.blueprint.container?.identifier, now.stacks[0].id);
    onlyEmulated([HOSTS[0], HOSTS[1]]);

    const again = await run(w, s, "bob");
    assert.equal(again.ok, false);
    assert.equal((again as { code: string }).code, "ARTIFACT_ALREADY_APPLIED");
    assert.deepEqual((await cloud()).changeSets.map((c) => c.execution), ["EXECUTE_COMPLETE"]);
  });

  it("refuses stale plans: a change set someone else executed; an update of the stack is never sealed under the canary allowlist (owner decision E1); an unchanged assembly is NO_CHANGES_TO_APPLY", async () => {
    const w = world();
    // (a) The sealed change set was executed out of band: CloudFormation reports it EXECUTE_COMPLETE, so it is no longer the approved, executable one.
    const used = await sealed(w);
    person(["cloudformation", "execute-change-set", "--change-set-name", recordOf(used).changeSetId]);
    const usedResult = await run(w, used);
    assert.equal(usedResult.ok, false);
    assert.equal((usedResult as { code: string }).code, "PLAN_STALE", JSON.stringify(usedResult));
    // (b) Owner decision E1: an update of the stack is never sealed. Under the run's allowlist, a template that adds a log group is refused before any change set exists.
    const withSecond = { ...WORKLOAD, [SECOND]: { Type: "AWS::Logs::LogGroup", Properties: { RetentionInDays: 1 } } };
    const { result: wider } = await seal(w, withSecond);
    assert.equal(wider.ok, false);
    assert.equal((wider as { code: string }).code, "RESOURCE_NOT_IN_CANARY", JSON.stringify(wider));
    assert.match((wider as { message: string }).message, /AWS::Logs::LogGroup: the template creates 2, the canary allowlist names exactly 1/);
    assert.equal((await cloud()).changeSets.length, 1, "the refused update created no change set");
    // Even an allowlist that names all three: CreateChangeSet cannot turn termination protection on, so the update is refused until a person does;
    // then CloudFormation's change set adds one log group where the allowlist names two, and the seal is refused with nothing executed.
    writeReviewedContract(w.contractPath, withAllowlist([{ type: "AWS::Logs::LogGroup", count: 2 }, { type: "AWS::Events::Rule", count: 1 }]));
    const { result: unprotected } = await seal(w, withSecond);
    assert.equal(unprotected.ok, false);
    assert.match((unprotected as { message: string }).message, /TERMINATION_PROTECTION_OFF/);
    assert.equal((await cloud()).changeSets.length, 1, "the refused update created no change set");
    protect();
    assert.deepEqual((await cloud()).stacks.map((stack) => stack.protection), [true]);
    const before = await cloud();
    const { result: update } = await seal(w, withSecond);
    assert.equal(update.ok, false);
    assert.equal((update as { code: string }).code, "RESOURCE_NOT_IN_CANARY", JSON.stringify(update));
    assert.match((update as { message: string }).message, /AWS::Logs::LogGroup: the change set creates 1, the canary allowlist names exactly 2/);
    const after = await cloud();
    assert.deepEqual(after.stacks, before.stacks, "nothing was executed");
    assert.deepEqual(after.groups, before.groups);
    noSecrets(update);
    // (c) The same assembly again, under the run's allowlist: the waiter exits non-zero on a FAILED change set, and the reason says there is nothing to change.
    writeReviewedContract(w.contractPath, withAllowlist(WORKLOAD_CANARY));
    const { result: same } = await seal(w);
    assert.equal(same.ok, false);
    assert.match((same as { message: string }).message, /NO_CHANGES_TO_APPLY/);
    onlyEmulated([HOSTS[0], HOSTS[1]]);
  });

  it("the kill switch: present before the apply, nothing runs; appearing as CloudFormation receives the execution, the engine judges what CloudFormation reports", async () => {
    const w = world();
    const s = await sealed(w);
    writeFileSync(KILL, "stop");
    const blocked = await run(w, s);
    assert.equal(blocked.ok, false);
    assert.equal((blocked as { code: string }).code, "KILL_SWITCH_ACTIVE");
    assert.equal(existsSync(join(w.evidence, s.sealed.artifactSha256 + ".apply.evidence")), false, "a blocked run reserves nothing");
    assert.deepEqual((await cloud()).changeSets.map((c) => c.execution), ["AVAILABLE"]);
    rmSync(KILL);
    // moto executes a change set synchronously: by the first look the stack is complete. The engine never reports a settled success as KILLED,
    // and sends no cancel-update-stack, which moto does not emulate (the live G2 covers a stop while CloudFormation is still working).
    writeFileSync(ARM, "arm");
    const during = await run(w, s);
    assert.ok(existsSync(KILL), "the kill switch appeared during the execution");
    assert.ok(during.ok, JSON.stringify(during));
    assert.equal((await stored(w, s)).outcome, "SUCCEEDED");
    noSecrets(during);
  });

  it("observes and cleans up only what the run created: the log group is removed by one UPDATE change set, the held resource and the stack stay, and the leftover check confirms it", async () => {
    const w = world();
    const s = await sealed(w);
    const applied = await run(w, s);
    assert.ok(applied.ok, JSON.stringify(applied));
    const observeDeps: ObserveDeps = { contractPath: w.contractPath, evidenceDir: w.evidence, env, toolDirs: [toolDir], scratchParent: w.scratch, now: () => new Date(NOW.getTime() + 60_000) };
    const observed = await observeRun(s.sealed.artifactSha256, observeDeps);
    assert.ok(observed.ok, JSON.stringify(observed));
    assert.deepEqual(observed.record.resources.map((r) => [r.address, r.result]), [[CANARY, "VERIFIED"], [HELD, "UNVERIFIABLE"]]);
    assert.equal(observed.record.inventory, "COMPLETE", "the tagging API answered");
    assert.deepEqual(observed.record.unexpected, [], "the stack itself, which carries the unit's tags, is the container and not a stray");
    noSecrets(observed.record);

    const records = await loadRunRecords(s.sealed.artifactSha256, w.evidence);
    assert.ok(records.ok, JSON.stringify(records));
    const contract = loadPilotContract(w.contractPath) as PilotContract;
    const built = buildCleanupProposal({ requesterId: REQUESTER.requesterId, ...records, changes: s.sealed.changes, channel: "CLI", contract, engineVersion, env, now: new Date(NOW.getTime() + 120_000) });
    assert.ok(built.ok, JSON.stringify(built));
    assert.deepEqual(built.proposal.deletes.map((d) => d.address), [CANARY], "only the run-created leaf is proposed");
    assert.deepEqual(built.proposal.excluded.map((x) => [x.address, x.ownership]), [[HELD, "TYPE_UNREVIEWED"]], "the held resource is named and kept");
    const proposal: CleanupProposal = signCleanupProposal(built.proposal, REQUESTER.privateKeyPem);

    // A cleanup is an update: the person protects the stack first, as after any first create.
    protect();
    const groupsBefore = (await cloud()).groups;
    const approval = signApproval({
      schemaVersion: 1, artifactSha256: proposal.proposalSha256, environment: "DEV", target: proposal.target, approverId: "alice",
      issuedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(), expiresAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(), nonce: randomBytes(16).toString("hex"),
    }, keys.alice.priv, "CLEANUP");
    const done = await runCleanup({
      invocation: human(target), environment: "DEV", target: { ...target }, proposal, sealedPlan: s.loaded, manifest: s.project.manifest, projectRoot: s.project.projectRoot, approvals: [approval],
    }, w.deps);
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.evidence.outcome, "SUCCEEDED");
    assert.deepEqual(done.evidence.deletes, [CANARY]);
    assert.equal(done.evidence.authority.mutation, CDK.cleanupMutation);
    noSecrets(done.evidence);
    const after = await cloud();
    assert.deepEqual(after.stacks.map((stack) => [stack.name, stack.status]), [[STACK, "UPDATE_COMPLETE"]], "the stack is never deleted");
    assert.deepEqual(after.groups, groupsBefore.filter((group) => !group.includes(CANARY)), "the run-created log group is gone");

    const leftovers = await verifyProposalLeftovers(proposal, observeDeps);
    assert.ok(leftovers.ok, JSON.stringify(leftovers));
    assert.deepEqual(leftovers.record.resources.map((r) => [r.address, r.disposition]), [[CANARY, "CONFIRMED_DELETED"], [HELD, "INTENTIONALLY_RETAINED"]]);
    assert.equal(leftovers.record.disposition, "INCOMPLETE", "a held resource of an unreviewed type keeps the leftover check open until a person decides");
    noSecrets(leftovers.record);
    onlyEmulated(HOSTS);
  });
});

/** The `aws` program inside the install that ALZ_SIM_AWS_CLI names (the installer's bin/aws is a link to dist/aws). */
function realAws(path: string): string {
  const resolved = execFileSync("readlink", ["-f", path], { encoding: "utf8" }).trim();
  assert.equal(basename(resolved), "aws");
  return resolved;
}
