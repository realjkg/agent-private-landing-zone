import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ChildRequest, ChildResult, Spawner } from "../../src/evidence-runner/child.js";
import type { IdentityObservation, IdentityProbe } from "../../src/evidence-runner/preflight.js";
import type { RunnerDeps, Terminal } from "../../src/evidence-runner/run.js";
import type { Provider } from "../../src/evidence-runner/types.js";

/**
 * SYNTHETIC fixtures for the evidence runner's tests. Nothing here reaches a cloud: the repository root is a temporary
 * folder with copies of the release scope and the example configuration, the source commit is injected, and identity
 * probes are in-memory fakes that record which providers were asked.
 */
export const CANDIDATE = "0123456789abcdef0123456789abcdef01234567";
export const ACCOUNT = "111122223333";
export const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const SUBSCRIPTION = "11111111-2222-4333-8444-555555555555";

/** A credential-shaped value placed in the environment of every test run; it must never appear in anything written. */
export const CANARY = "AKIAEVIDENCECANARY00";

/** The shape the evidence runner reads to say ACT is authorized: an enabled contract with a non-empty authorize (the full check is ./alz apply preflight). */
export const AUTHORIZING_CONTRACT = { schemaVersion: 1, enabled: true, authorize: { DEV: ["APPLY"] } };

export function fixtureRoot(contract?: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-evidence-")));
  mkdirSync(join(root, "config", "release"), { recursive: true });
  copyFileSync("config/release/scope.json", join(root, "config", "release", "scope.json"));
  copyFileSync("config/release/status.json", join(root, "config", "release", "status.json"));
  copyFileSync("config/evidence-runner.example.json", join(root, "config", "evidence-runner.example.json"));
  if (contract !== undefined) writeFileSync(join(root, "config", "act-pilot-contract.json"), typeof contract === "string" ? contract : JSON.stringify(contract));
  return root;
}

export function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, candidateCommit: CANDIDATE, targetHardwareId: "owner-mac-01", evidenceDir: ".runs/evidence",
    aws: { expectedAccountId: ACCOUNT, region: "eu-west-1", qualificationStack: "alz-qualification-noop" },
    azure: { expectedTenantId: TENANT, expectedSubscriptionId: SUBSCRIPTION, location: "westeurope" },
    ...overrides,
  };
}

export function writeConfig(root: string, config: Record<string, unknown>, path = "config/evidence-runner.json"): void {
  writeFileSync(join(root, path), JSON.stringify(config, null, 2));
}

export function scriptedTerminal(answers: string[], tty = true): Terminal & { asked: string[] } {
  const asked: string[] = [];
  return { stdinIsTTY: tty, stdoutIsTTY: tty, asked, ask: async (question) => { asked.push(question); return answers.shift() ?? ""; } };
}

export function fakeProbe(answers: Partial<Record<Provider, IdentityObservation>>): IdentityProbe & { calls: Provider[] } {
  const calls: Provider[] = [];
  const probe = (async (provider: Provider) => { calls.push(provider); return answers[provider] ?? { status: "PROBE_NOT_BUILT" }; }) as IdentityProbe & { calls: Provider[] };
  probe.calls = calls;
  return probe;
}

export const PROJECT = "alz-dev-pilot";
export const observedAws: IdentityObservation = { status: "OBSERVED", kind: "FEDERATED", accountId: ACCOUNT };
export const observedAzure: IdentityObservation = { status: "OBSERVED", kind: "FEDERATED", tenantId: TENANT, subscriptionId: SUBSCRIPTION };
export const observedGcp: IdentityObservation = { status: "OBSERVED", kind: "FEDERATED", projectId: PROJECT };

/**
 * A fake `./alz`: records every request (arguments, environment, how its streams are connected) and answers from a script
 * keyed by the first two arguments (`apply seal`, `qualify provider-aws`). A script entry may write the files its producer
 * would, under the repository. Unscripted commands exit 2, so no test ever starts a real child by accident.
 */
export type FakeChild = (request: ChildRequest) => ChildResult | Promise<ChildResult>;
export function fakeSpawner(script: Record<string, FakeChild | number> = {}): Spawner & { calls: ChildRequest[] } {
  const calls: ChildRequest[] = [];
  const spawner = (async (request: ChildRequest) => {
    calls.push(request);
    const entry = script[request.args.slice(0, 2).join(" ")];
    if (entry === undefined) return { exitCode: 2, signal: null };
    return typeof entry === "number" ? { exitCode: entry, signal: null } : entry(request);
  }) as Spawner & { calls: ChildRequest[] };
  spawner.calls = calls;
  return spawner;
}

export function fixtureDeps(root: string, overrides: Partial<RunnerDeps> = {}): RunnerDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    root,
    env: { AWS_SECRET_ACCESS_KEY: CANARY, AZURE_CLIENT_SECRET: CANARY, PATH: "/usr/bin" },
    terminal: scriptedTerminal([], false),
    host: "fixture-host",
    now: () => new Date("2026-10-27T00:00:00.000Z"),
    probe: fakeProbe({ aws: observedAws, azure: observedAzure }),
    source: () => ({ ok: true, commit: CANDIDATE, origin: "GIT_CHECKOUT" }),
    out: (line) => { lines.push(line); },
    pidAlive: () => true,
    spawn: fakeSpawner(),
    realHome: "/nonexistent-home",
    lines,
    ...overrides,
  };
}

/**
 * The governed-environment oracle for the runner's children, extending the tool runner's (test/runner-hardening.test.ts): the
 * operator's own session and anything that would change what a child runs. Every value is the canary; no child may see a name
 * or a value of these. HOME is set to the operator's home, which a child must never receive either.
 */
export const OPERATOR_SESSION: Readonly<Record<string, string>> = Object.fromEntries([
  "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE", "AWS_SSO_SESSION", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_ENDPOINT_URL",
  "AZURE_CONFIG_DIR", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_TENANT_ID", "AZURE_CLIENT_CERTIFICATE_PATH", "AZURE_PASSWORD", "AZURE_USERNAME",
  "ARM_CLIENT_ID", "ARM_CLIENT_SECRET", "ARM_ACCESS_KEY", "ARM_SAS_TOKEN", "ARM_SUBSCRIPTION_ID", "ARM_TENANT_ID", "ARM_OIDC_TOKEN", "ARM_USE_MSI",
  "MSI_ENDPOINT", "IDENTITY_ENDPOINT", "CLOUDSDK_CONFIG", "CLOUDSDK_CORE_PROJECT", "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE", "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_CREDENTIALS", "GCE_METADATA_HOST", "GITHUB_TOKEN", "GH_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "NPM_TOKEN",
  "ANTHROPIC_API_KEY", "PULUMI_ACCESS_TOKEN", "TF_TOKEN_app_terraform_io", "TF_VAR_db_password", "TF_CLI_CONFIG_FILE", "KUBECONFIG", "SSH_AUTH_SOCK",
  "AGENTIC_EVIDENCE_KEY", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "GIT_ASKPASS",
].map((name) => [name, CANARY]));

// The guided stages' fakes (SYNTHETIC): an AWS Terraform contract shape, the act targets and a scripted `./alz apply`.
/** Its kill switch file (relative to the repository root, as the product reads it) does not exist: the switch is off. */
export const AWS_CONTRACT = { schemaVersion: 1, enabled: true, provider: "AWS", engine: "TERRAFORM", authorize: { DEV: ["APPLY", "CLEANUP"] }, killSwitchPath: ".runs/apply/KILL" };
export const ACT = { repository: "owner/repo", paths: { "aws-terraform": { project: "/srv/canary/aws", requesterId: "owner" } } };
export const ARTIFACT = "a".repeat(64);
export const MUTATION_ENV = {
  ALZ_DISCOVERY_AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/d", ALZ_STATE_AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/s",
  ALZ_STATE_WRITE_AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/w", ALZ_APPLY_AWS_ROLE_ARN: "arn:aws:iam::111122223333:role/a",
};

export const write = (root: string, path: string, text = "{}") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };

/**
 * The commit that carries a path's contract. In the owner's run it differs from the candidate in the contract file only, so
 * the fakes use a different commit: a live record names it, never the candidate (review B2 on #349).
 */
export const CONTRACT_COMMIT = "1".repeat(40);

/** The artifact a path's fake seal produces: distinct per path, so several paths' runs in one repository never collide. */
export const artifactOf = (path = "aws-terraform"): string => path === "aws-terraform" ? ARTIFACT : createHash("sha256").update(path).digest("hex");

/** What each `./alz apply` producer writes (src/cli/apply.ts defaults), so the runner finds one new document per step. */
export function applyScript(overrides: Record<string, FakeChild | number> = {}, options: { path?: string; live?: Record<string, unknown> } = {}): Record<string, FakeChild | number> {
  const path = options.path ?? "aws-terraform";
  const artifact = artifactOf(path);
  const a12 = artifact.slice(0, 12);
  const p12 = createHash("sha256").update("proposal " + path).digest("hex").slice(0, 12);
  const [cloud, engine] = path === "aws-cdk" ? ["AWS", "CDK"] : path === "azure-bicep" ? ["AZURE", "BICEP"] : path === "gcp-api" ? ["GCP", "GCP_API"] : [path.split("-")[0].toUpperCase(), "TERRAFORM"];
  return {
    "apply contract-check": 0,
    "apply identity-check": (request) => { write(request.cwd, ".runs/apply/identity-delivery/delivered-" + path + "-2026-10-29T00-00-00-000Z-" + randomBytes(4).toString("hex") + ".json"); return { exitCode: 0, signal: null }; },
    "apply prepare": (request) => {
      write(request.cwd, ".runs/pilot/DEV/request-" + artifact.slice(0, 16) + ".json");
      write(request.cwd, ".runs/pilot/DEV/manifest-" + artifact.slice(0, 16) + ".json");
      write(request.cwd, ".runs/pilot/DEV/preparation-" + artifact.slice(0, 16) + ".json");
      return { exitCode: 0, signal: null };
    },
    "apply qualify": 0,
    "apply preflight": 0,
    "apply seal": (request) => { write(request.cwd, ".runs/apply/evidence/" + artifact + ".sealed", "sealed " + path); write(request.cwd, ".runs/apply/evidence/" + artifact + ".sealed.review.json", "{\"path\":\"" + path + "\"}"); return { exitCode: 0, signal: null }; },
    "apply apply": 0,
    // A VERIFIED observation's plain summary: what the runner reads to pass act:<path> (#360 review N1).
    "apply observe": (request) => { write(request.cwd, ".runs/apply/reports/" + a12 + "-observation.json", JSON.stringify({ schemaVersion: 1, kind: "OBSERVATION_SUMMARY", verdict: "VERIFIED", inventory: "COMPLETE", sweepNotListing: [] })); return { exitCode: 0, signal: null }; },
    "apply propose-cleanup": (request) => { write(request.cwd, ".runs/apply/cleanup/" + p12 + ".cleanup-proposal.json"); return { exitCode: 0, signal: null }; },
    "apply cleanup": 0,
    "apply verify-cleanup": 0,
    // A lifecycle report whose leftovers stage passed: what the runner reads for a GCP path's cleanup (#359 review N1).
    "apply report": (request) => { write(request.cwd, ".runs/apply/reports/" + a12 + "-lifecycle-" + p12 + ".json", JSON.stringify({ reportKind: "ACT_LIFECYCLE", stages: { leftovers: { status: "PASS" } } })); return { exitCode: 0, signal: null }; },
    "apply record-live": (request) => {
      write(request.cwd, "config/acceptance/evidence/" + cloud.toLowerCase() + "-" + engine.toLowerCase() + "-execute-dev-" + a12 + ".json",
        JSON.stringify(options.live ?? { schemaVersion: 1, label: "LIVE", step: "execute", cloud, engine, sourceCommit: CONTRACT_COMMIT, contractSha256: "c".repeat(64) }));
      return { exitCode: 0, signal: null };
    },
    ...overrides,
  };
}

/** A repository with the AWS contract committed, a key file, and an approval the approver saved under .runs/. */
export function actRoot(contract: unknown = AWS_CONTRACT): string {
  const root = fixtureRoot(contract);
  writeConfig(root, validConfig({ aws: undefined, azure: undefined, act: ACT }));
  write(root, ".runs/keys/requester.pem", "");
  write(root, ".runs/approvals/apply-1.json", "{\"approval\":true}");
  write(root, ".runs/approvals/cleanup-1.json", "{\"approval\":true}");
  return root;
}

