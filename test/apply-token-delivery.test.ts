import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APPLY_IDENTITIES } from "../src/apply/types.js";
import { engineSpec } from "../src/apply/engine-spec.js";
import {
  DELIVERY_PATHS, checkDeliveredTokens, deliveryEnvironment, deliveryPathOf, identityDeliveryEvidence, type DeliveryCheck, type DeliveryPathId,
} from "../src/apply/token-delivery.js";
import { runApplyCommand, type ApplyCliDeps } from "../src/cli/apply.js";
import { GCP_CONFIG_AUDIENCE, REPO, deliverSession, deliveryClaims, fakeJwt } from "./helpers/token-delivery-fixtures.js";

// SYNTHETIC. The driver's judgment of token files the identity delivery runner writes (docs/act-pilot-identity-delivery.md),
// and the owner's verification command. Unsigned look-alike tokens with fake claims; no network, no cloud, no credential.

process.env.AGENTIC_EVIDENCE_KEY ??= randomBytes(32).toString("base64");
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NOW = new Date("2026-10-28T12:00:00.000Z");
const SECONDS = Math.floor(NOW.getTime() / 1000);
const made: string[] = [];
test.after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });
const deliver = (path: DeliveryPathId, options: Parameters<typeof deliverSession>[2] = {}) => {
  const delivered = deliverSession(path, NOW, options);
  made.push(delivered.root);
  return delivered;
};
const check = (env: NodeJS.ProcessEnv, path: DeliveryPathId = "aws-terraform", over: Partial<Parameters<typeof checkDeliveredTokens>[0]> = {}): DeliveryCheck =>
  checkDeliveredTokens({ env, path, now: NOW, repoRoot: ROOT, ...over });
const refused = (result: DeliveryCheck, code: string, fragment: RegExp): string => {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) return "";
  assert.equal(result.code, code, result.message);
  assert.match(result.message, fragment);
  return result.message;
};

test("the six release paths map to the engines' own identities and to one environment per identity and trust scope", () => {
  assert.deepEqual(DELIVERY_PATHS["aws-terraform"].identities, APPLY_IDENTITIES);
  assert.deepEqual(DELIVERY_PATHS["azure-terraform"].identities, APPLY_IDENTITIES);
  assert.deepEqual(DELIVERY_PATHS["gcp-terraform"].identities, APPLY_IDENTITIES);
  assert.deepEqual(DELIVERY_PATHS["aws-cdk"].identities, engineSpec("CDK")!.identities);
  assert.deepEqual(DELIVERY_PATHS["azure-bicep"].identities, engineSpec("BICEP")!.identities);
  assert.deepEqual(DELIVERY_PATHS["gcp-api"].identities, ["DISCOVERY", "APPLY"]);
  assert.equal(deliveryPathOf("AWS", "TERRAFORM"), "aws-terraform");
  assert.equal(deliveryPathOf("AZURE", "BICEP"), "azure-bicep");
  assert.equal(deliveryPathOf("GCP", "GCP_API"), "gcp-api");
  assert.equal(deliveryPathOf("AWS", "BICEP"), undefined);
  const environments = (Object.keys(DELIVERY_PATHS) as DeliveryPathId[]).flatMap((path) => DELIVERY_PATHS[path].identities.map((identity) => deliveryEnvironment(path, identity)));
  // Both Azure paths use the same four Entra applications (bootstrap/azure), so they share environments; nothing else does.
  assert.equal(new Set(environments).size, 4 + 3 + 4 + 4 + 2);
  for (const name of environments) assert.match(name, /^act-dev-[a-z-]+-(discovery|state|state-write|apply|changeset)$/);
  assert.equal(deliveryEnvironment("aws-terraform", "STATE_WRITE"), "act-dev-aws-terraform-state-write");
  assert.equal(deliveryEnvironment("azure-bicep", "APPLY"), deliveryEnvironment("azure-terraform", "APPLY"));
});

test("token files with no delivery metadata are not delivered and are left to the provider checks, unchanged", () => {
  assert.deepEqual(check({ ALZ_APPLY_AWS_WEB_IDENTITY_TOKEN_FILE: "/run/fixture/apply-token" }), { ok: true, delivered: false });
  assert.deepEqual(check({}), { ok: true, delivered: false });
});

test("every path's delivered identities are accepted: private, distinct, fresh and minted for their own environment and audience", () => {
  for (const path of Object.keys(DELIVERY_PATHS) as DeliveryPathId[]) {
    const d = deliver(path);
    const result = check(d.env, path);
    assert.ok(result.ok && result.delivered, path + ": " + JSON.stringify(result));
    assert.deepEqual(result.identities.map((i) => i.identity), DELIVERY_PATHS[path].identities);
    assert.equal(new Set(result.identities.map((i) => i.subject)).size, result.identities.length);
    assert.equal(new Set(result.identities.map((i) => i.tokenFingerprint)).size, result.identities.length);
    for (const identity of result.identities) {
      assert.equal(identity.fileMode, "0600");
      assert.equal(identity.directoryMode, "0700");
      assert.equal(identity.subject, "repo:" + REPO + ":environment:" + identity.environment);
      assert.equal(identity.secondsRemaining, 300);
    }
    const audience = result.identities[0].audience;
    assert.equal(audience, { AWS: "sts.amazonaws.com", AZURE: "api://AzureADTokenExchange", GCP: "https:" + GCP_CONFIG_AUDIENCE }[DELIVERY_PATHS[path].provider]);
    // No token reaches the record.
    const tokens = DELIVERY_PATHS[path].identities.map((identity) => readFileSync(d.tokenFile(identity), "utf8"));
    for (const token of tokens) assert.equal(JSON.stringify(result).includes(token), false);
  }
});

test("a token for another identity's environment, another audience or another issuer is refused", () => {
  const swapped = deliver("aws-terraform");
  const discovery = readFileSync(swapped.tokenFile("DISCOVERY"), "utf8");
  writeFileSync(swapped.tokenFile("DISCOVERY"), readFileSync(swapped.tokenFile("APPLY"), "utf8"), { mode: 0o600 });
  writeFileSync(swapped.tokenFile("APPLY"), discovery, { mode: 0o600 });
  refused(check(swapped.env), "IDENTITY_NOT_CONFIGURED", /DISCOVERY token is not bound to the environment act-dev-aws-terraform-discovery \(sub\)/);
  for (const [claims, fragment] of [
    [{ sub: "repo:" + REPO + ":ref:refs/heads/main" }, /not bound to the environment/],
    [{ sub: "repo:" + REPO + ":environment:act-dev-aws-terraform-*" }, /not bound to the environment/],
    [{ sub: "repo:*:environment:act-dev-aws-terraform-apply" }, /not bound to the environment/],
    [{ aud: "api://AzureADTokenExchange" }, /audience sts\.amazonaws\.com \(aud\)/],
    [{ aud: ["sts.amazonaws.com", "api://AzureADTokenExchange"] }, /\(aud\)/],
    [{ iss: "https://issuer.example.test" }, /not issued by GitHub Actions/],
    [{ environment: "act-dev-aws-terraform-discovery" }, /another environment/],
    [{ repository: "someone/else" }, /another repository/],
    [{ event_name: "pull_request" }, /workflow_dispatch/],
    [{ ref: "refs/heads/feature" }, /from main/],
    [{ workflow_ref: REPO + "/.github/workflows/pr-validation.yml@refs/heads/main" }, /identity delivery workflow/],
    [{ runner_environment: "github-hosted" }, /self-hosted/],
    [{ run_id: "9999" }, /another delivery run/],
  ] as const) {
    const d = deliver("aws-terraform", { claims: { APPLY: claims } });
    refused(check(d.env), "IDENTITY_NOT_CONFIGURED", fragment as RegExp);
  }
  const azure = deliver("azure-terraform", { claims: { STATE: { aud: "sts.amazonaws.com" } } });
  refused(check(azure.env, "azure-terraform"), "IDENTITY_NOT_CONFIGURED", /STATE token does not carry exactly the audience api:\/\/AzureADTokenExchange/);
  const gcp = deliver("gcp-api", { claims: { APPLY: { aud: GCP_CONFIG_AUDIENCE } } });
  refused(check(gcp.env, "gcp-api"), "IDENTITY_NOT_CONFIGURED", /APPLY token does not carry exactly the audience https:\/\/iam\.googleapis\.com\//);
});

test("an expired token, one about to expire, one issued in the future and one not yet valid are refused; nothing is extended", () => {
  for (const [claims, fragment] of [
    [{ exp: SECONDS - 1 }, /expired or expires within 60 seconds/],
    [{ exp: SECONDS + 59 }, /expired or expires within 60 seconds/],
    [{ exp: undefined }, /no expiry/],
    [{ iat: SECONDS + 120 }, /issued in the future/],
    [{ nbf: SECONDS + 120 }, /not valid yet/],
  ] as const) {
    const d = deliver("aws-terraform", { claims: { STATE_WRITE: claims } });
    refused(check(d.env), "IDENTITY_NOT_CONFIGURED", fragment as RegExp);
  }
  const d = deliver("aws-terraform");
  // The same files, checked later: once the token expires it is refused, however recently its job refreshed the metadata.
  const later = new Date(NOW.getTime() + 260 * 1000);
  for (const identity of APPLY_IDENTITIES) {
    const meta = JSON.parse(readFileSync(d.metaFile(identity), "utf8"));
    writeFileSync(d.metaFile(identity), JSON.stringify({ ...meta, refreshedAt: later.toISOString() }), { mode: 0o600 });
  }
  refused(check(d.env, "aws-terraform", { now: later }), "IDENTITY_NOT_CONFIGURED", /expired or expires within 60 seconds/);
});

test("a delivery whose job stopped refreshing, whose window ended, or whose metadata is wrong is refused", () => {
  for (const [meta, fragment] of [
    [{ refreshedAt: new Date(NOW.getTime() - 181 * 1000).toISOString() }, /is stale: its delivery job stopped refreshing it/],
    [{ refreshedAt: new Date(NOW.getTime() + 120 * 1000).toISOString() }, /is stale/],
    [{ holdUntil: NOW.toISOString() }, /delivery window has ended/],
    [{ environment: "act-dev-aws-terraform-discovery" }, /metadata is for another path, identity, environment or audience/],
    [{ audience: "api://AzureADTokenExchange" }, /metadata is for another path/],
    [{ path: "aws-cdk" }, /metadata is for another path/],
    [{ subject: "repo:" + REPO + ":environment:act-dev-aws-terraform-discovery" }, /subject differs from its metadata/],
    [{ refreshSeconds: 600 }, /not a valid delivery metadata record/],
    [{ extra: true } as never, /exactly the delivery metadata fields/],
  ] as const) {
    const d = deliver("aws-terraform", { meta: { APPLY: meta } });
    refused(check(d.env), "IDENTITY_NOT_CONFIGURED", fragment as RegExp);
  }
  const d = deliver("aws-terraform");
  writeFileSync(d.metaFile("STATE"), "{", { mode: 0o600 });
  refused(check(d.env), "IDENTITY_NOT_CONFIGURED", /STATE's delivery metadata cannot be read/);
  const notJwt = deliver("aws-terraform");
  writeFileSync(notJwt.tokenFile("STATE"), "not-a-token", { mode: 0o600 });
  refused(check(notJwt.env), "IDENTITY_NOT_CONFIGURED", /STATE token is not a JWT/);
});

test("a token reused across identities is refused: one file for two identities, a hard link, or the same token id", () => {
  const shared = deliver("aws-terraform");
  refused(check({ ...shared.env, ALZ_APPLY_AWS_WEB_IDENTITY_TOKEN_FILE: shared.tokenFile("DISCOVERY") }), "IDENTITY_NOT_CONFIGURED", /not delivered files .*APPLY/);
  const hard = deliver("aws-terraform");
  unlinkSync(hard.tokenFile("APPLY"));
  linkSync(hard.tokenFile("DISCOVERY"), hard.tokenFile("APPLY"));
  refused(check(hard.env), "IDENTITY_NOT_CONFIGURED", /has another hard link/);
  const jti = deliver("aws-terraform", { claims: { DISCOVERY: { jti: "same" }, APPLY: { jti: "same" } } });
  refused(check(jti.env), "IDENTITY_COLLAPSED", /same token, subject or token id/);
  const runs = deliver("aws-terraform", { claims: { APPLY: { run_id: "5151" } }, meta: { APPLY: { runId: "5151" } } });
  refused(check(runs.env), "IDENTITY_NOT_CONFIGURED", /more than one delivery run/);
});

test("a group- or world-readable token, a symbolic link, a file outside the session directory or a delivery inside the checkout is refused", () => {
  for (const mode of [0o640, 0o604, 0o620, 0o660]) {
    const d = deliver("aws-terraform");
    chmodSync(d.tokenFile("STATE"), mode);
    refused(check(d.env), "IDENTITY_NOT_CONFIGURED", /readable or writable by group or others/);
  }
  const meta = deliver("aws-terraform");
  chmodSync(meta.metaFile("APPLY"), 0o644);
  refused(check(meta.env), "IDENTITY_NOT_CONFIGURED", /APPLY token or its metadata is readable or writable by group or others/);
  for (const mode of [0o750, 0o705, 0o755]) {
    const d = deliver("aws-terraform");
    chmodSync(d.sessionDir, mode);
    refused(check(d.env), "IDENTITY_NOT_CONFIGURED", /is open to group or others/);
  }
  const rootOpen = deliver("aws-terraform");
  chmodSync(rootOpen.root, 0o755);
  refused(check(rootOpen.env), "IDENTITY_NOT_CONFIGURED", /is open to group or others/);

  const link = deliver("aws-terraform");
  const elsewhere = mkdtempSync(join(realpathSync(tmpdir()), "alz-elsewhere-"));
  made.push(elsewhere);
  renameSync(link.tokenFile("APPLY"), join(elsewhere, "APPLY.jwt"));
  symlinkSync(join(elsewhere, "APPLY.jwt"), link.tokenFile("APPLY"));
  refused(check(link.env), "IDENTITY_NOT_CONFIGURED", /APPLY token or its metadata is a symbolic link/);

  const linkedSession = deliver("aws-terraform");
  const realSession = join(linkedSession.root, "real");
  renameSync(linkedSession.sessionDir, realSession);
  symlinkSync(realSession, linkedSession.sessionDir);
  refused(check(linkedSession.env), "IDENTITY_NOT_CONFIGURED", /is a symbolic link/);

  const outside = deliver("aws-terraform");
  const other = join(outside.root, "other", "aws-terraform");
  mkdirSync(other, { recursive: true, mode: 0o700 });
  for (const file of [outside.tokenFile("APPLY"), outside.metaFile("APPLY")]) renameSync(file, join(other, file.slice(outside.sessionDir.length + 1)));
  refused(check({ ...outside.env, ALZ_APPLY_AWS_WEB_IDENTITY_TOKEN_FILE: join(other, "APPLY.jwt") }), "IDENTITY_NOT_CONFIGURED", /not all in one session directory/);

  const misnamed = deliver("aws-terraform");
  const wrongName = join(misnamed.root, "aws-cdk");
  renameSync(misnamed.sessionDir, wrongName);
  const env = Object.fromEntries(Object.entries(misnamed.env).map(([k, v]) => [k, v.replace(misnamed.sessionDir, wrongName)]));
  refused(check(env), "IDENTITY_NOT_CONFIGURED", /is not named for the path aws-terraform/);

  const inside = deliver("aws-terraform");
  refused(check(inside.env, "aws-terraform", { repoRoot: dirname(inside.root) }), "IDENTITY_NOT_CONFIGURED", /inside the product checkout/);

  const foreign = deliver("aws-terraform");
  refused(check(foreign.env, "aws-terraform", { uid: (process.getuid?.() ?? 0) + 1 }), "IDENTITY_NOT_CONFIGURED", /not owned by the user running this command/);
});

test("a partial delivery is refused: every identity of the path comes from one run, or none does", () => {
  const d = deliver("aws-terraform");
  unlinkSync(d.metaFile("STATE_WRITE"));
  refused(check(d.env), "IDENTITY_NOT_CONFIGURED", /STATE_WRITE token or its metadata is missing/);
  const legacy = deliver("aws-terraform");
  refused(check({ ...legacy.env, ALZ_STATE_AWS_WEB_IDENTITY_TOKEN_FILE: "/run/fixture/state-token" }), "IDENTITY_NOT_CONFIGURED",
    /not delivered files .*STATE\b.*Every identity of a path is delivered by one run, or none is/);
  // Released: the variables still name the delivered layout, and the files are gone. Refused, never passed on as plain paths.
  const released = deliver("aws-terraform");
  rmSync(released.sessionDir, { recursive: true });
  refused(check(released.env), "IDENTITY_NOT_CONFIGURED", /delivery directory .* is missing/);
  const missing = deliver("aws-terraform");
  unlinkSync(missing.tokenFile("STATE"));
  unlinkSync(missing.metaFile("STATE"));
  refused(check(missing.env), "IDENTITY_NOT_CONFIGURED", /STATE/);
  const unset = deliver("aws-terraform");
  const env = { ...unset.env };
  delete env.ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE;
  refused(check(env), "IDENTITY_NOT_CONFIGURED", /DISCOVERY/);
});

// --- the owner's verification command --------------------------------------------------------------------------

test("the delivered record passes only with the named repository and says what it does not prove; the token never appears", () => {
  const d = deliver("gcp-terraform");
  const record = identityDeliveryEvidence({ env: d.env, path: "gcp-terraform", repository: REPO, phase: "delivered", now: NOW, repoRoot: ROOT, driverIdentityConfiguration: { ready: false, detail: "fixture" } });
  assert.equal(record.result, "PASS", record.failures.join("; "));
  assert.equal(record.label, "HOST_LOCAL");
  assert.equal(record.identities.length, 4);
  assert.ok(record.proves.length >= 4);
  assert.ok(record.doesNotProve.some((line) => /cloud trusts these tokens/.test(line) && /signature is not verified/.test(line)));
  assert.ok(record.doesNotProve.some((line) => /job-started hook/.test(line)));
  const text = JSON.stringify(record);
  for (const identity of APPLY_IDENTITIES) assert.equal(text.includes(readFileSync(d.tokenFile(identity), "utf8")), false);

  assert.equal(identityDeliveryEvidence({ env: d.env, path: "gcp-terraform", repository: "someone/else", phase: "delivered", now: NOW, repoRoot: ROOT, driverIdentityConfiguration: { ready: true } }).result, "FAIL");
  assert.equal(identityDeliveryEvidence({ env: d.env, path: "gcp-terraform", repository: "not a repo", phase: "delivered", now: NOW, repoRoot: ROOT, driverIdentityConfiguration: { ready: true } }).result, "FAIL");
  // Nothing delivered is a failure here, not a pass.
  const none = identityDeliveryEvidence({ env: { ALZ_APPLY_AWS_WEB_IDENTITY_TOKEN_FILE: "/run/fixture/apply" }, path: "aws-terraform", repository: REPO, phase: "delivered", now: NOW, repoRoot: ROOT, driverIdentityConfiguration: { ready: true } });
  assert.equal(none.result, "FAIL");
  assert.deepEqual(none.proves, []);
});

test("the cleaned record passes only when every token and metadata file is gone and the session directory is gone or empty", () => {
  const d = deliver("azure-bicep");
  const cleaned = () => identityDeliveryEvidence({ env: d.env, path: "azure-bicep", repository: REPO, phase: "cleaned", now: NOW, repoRoot: ROOT, driverIdentityConfiguration: { ready: true } });
  assert.equal(cleaned().result, "FAIL");
  unlinkSync(d.tokenFile("DISCOVERY"));
  unlinkSync(d.metaFile("DISCOVERY"));
  unlinkSync(d.tokenFile("APPLY"));
  const leftover = cleaned();
  assert.equal(leftover.result, "FAIL");
  assert.deepEqual(leftover.leftovers, ["APPLY.json"]);
  unlinkSync(d.metaFile("APPLY"));
  writeFileSync(join(d.sessionDir, "RELEASE"), "", { mode: 0o600 });
  assert.deepEqual(cleaned().leftovers, ["RELEASE"]);
  unlinkSync(join(d.sessionDir, "RELEASE"));
  assert.equal(cleaned().result, "PASS");
  rmSync(d.sessionDir, { recursive: true });
  const gone = cleaned();
  assert.equal(gone.result, "PASS");
  assert.deepEqual(gone.removed.map((r) => [r.identity, r.tokenGone, r.metadataGone]), [["DISCOVERY", true, true], ["APPLY", true, true]]);
  // A token file the variables do not name cannot be shown to be gone.
  assert.equal(identityDeliveryEvidence({ env: {}, path: "azure-bicep", repository: REPO, phase: "cleaned", now: NOW, repoRoot: ROOT, driverIdentityConfiguration: { ready: true } }).result, "FAIL");
});

type Terminal = NonNullable<ApplyCliDeps["terminal"]> & { out: string[] };
async function identityCheck(args: string[], env: NodeJS.ProcessEnv, dir: string, tty = true) {
  const out: string[] = [];
  const terminal: Terminal = { stdinIsTTY: tty, stdoutIsTTY: tty, out, write: (text: string) => { out.push(text); }, ask: async () => "" };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const reports: { code: string }[] = [];
  const code = await runApplyCommand(["identity-check", ...args], {
    terminal, env, now: () => NOW, identityEvidenceDir: dir, stdout: (t) => { stdout.push(t); }, stderr: (t) => { stderr.push(t); }, report: (e) => { reports.push(e); },
  });
  return { code, stdout: stdout.join(""), stderr: stderr.join(""), term: out.join(""), reports: reports.map((r) => r.code) };
}

test("./alz apply identity-check: a person at a terminal, exit 0 PASS and 2 FAIL, one private HOST_LOCAL record per run, no token printed", async () => {
  const d = deliver("aws-cdk");
  const dir = join(d.root, "evidence");
  const ok = await identityCheck(["--path", "aws-cdk", "--repository", REPO, "--phase", "delivered"], d.env, dir);
  assert.equal(ok.code, 0, ok.stderr + ok.term);
  assert.deepEqual(ok.reports, ["IDENTITY_DELIVERY_VERIFIED"]);
  assert.match(ok.term, /IDENTITY DELIVERY CHECK \(HOST_LOCAL, not provider evidence\): aws-cdk, phase delivered: PASS/);
  assert.match(ok.term, /CHANGESET: act-dev-aws-cdk-changeset, sub repo:fixture-owner\/fixture-repo:environment:act-dev-aws-cdk-changeset, aud sts\.amazonaws\.com/);
  // The provider's own identity check is reported beside the verdict, never part of it; the contract's targets are not judged here.
  assert.match(ok.term, /Provider identity variables \(without the contract's targets\): ready/);
  const written = readdirSync(dir);
  assert.equal(written.length, 1);
  assert.match(written[0], /^delivered-aws-cdk-2026-10-28T12-00-00-000Z-[0-9a-f]{8}\.json$/);
  assert.equal((await import("node:fs")).statSync(join(dir, written[0])).mode & 0o777, 0o600);
  for (const identity of DELIVERY_PATHS["aws-cdk"].identities) {
    const token = readFileSync(d.tokenFile(identity), "utf8");
    for (const text of [ok.stdout, ok.term, readFileSync(join(dir, written[0]), "utf8")]) assert.equal(text.includes(token), false);
  }

  chmodSync(d.tokenFile("APPLY"), 0o644);
  const bad = await identityCheck(["--path", "aws-cdk", "--repository", REPO, "--phase", "delivered"], d.env, dir);
  assert.equal(bad.code, 2);
  assert.deepEqual(bad.reports, ["IDENTITY_DELIVERY_REFUSED"]);
  assert.match(bad.term, /FAIL .*group or others/);

  for (const identity of DELIVERY_PATHS["aws-cdk"].identities) { unlinkSync(d.tokenFile(identity)); unlinkSync(d.metaFile(identity)); }
  const clean = await identityCheck(["--path", "aws-cdk", "--repository", REPO, "--phase", "cleaned"], d.env, dir);
  assert.equal(clean.code, 0, clean.term);

  assert.equal((await identityCheck(["--path", "aws-everything", "--repository", REPO, "--phase", "delivered"], d.env, dir)).code, 1);
  assert.equal((await identityCheck(["--path", "aws-cdk", "--repository", REPO, "--phase", "later"], d.env, dir)).code, 1);
  assert.equal((await identityCheck(["--path", "aws-cdk", "--repository", REPO], d.env, dir)).code, 1);
  const piped = await identityCheck(["--path", "aws-cdk", "--repository", REPO, "--phase", "cleaned"], d.env, dir, false);
  assert.equal(piped.code, 1);
  assert.match(piped.stderr, /HUMAN_TERMINAL_REQUIRED/);
});

test("the fixture tokens are look-alikes, not credentials: unsigned and minted for the fixture repository only", () => {
  const token = fakeJwt(deliveryClaims("aws-terraform", "APPLY", SECONDS));
  assert.equal(token.split(".").length, 3);
  assert.equal(Buffer.from(token.split(".")[2], "base64url").toString(), "fake-signature");
});
