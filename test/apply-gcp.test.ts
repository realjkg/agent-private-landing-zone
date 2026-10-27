import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { codeOf } from "../src/apply/engine.js";
import { checkApplyIdentities, verifyIdentityTargets } from "../src/apply/identities.js";
import { PROVIDER_IDS, providerSpec, type ProviderBlock, type ProviderSpec, type ProviderUse } from "../src/apply/provider.js";
import { GCP, GCP_DATA_SOURCES, GCP_IDENTITY_VARIABLES, backendBucketForms, checkCredentialConfiguration, gcpParentOk, namesBackendBucket, type GcpTarget } from "../src/apply/providers/gcp.js";
import { APPLY_IDENTITIES, type PilotContract, type PilotTarget } from "../src/apply/types.js";
import { TOKEN_FILE } from "../src/apply/constants.js";
import { CREDENTIAL_FILE, readTokenFile } from "../src/tools/gcp-credentials.js";
import { TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";

// docs/act-pilot-gcp-terraform-g0.md, slice S1 of the GCP release-path PLAN (owner approval 6433121154 on issue #39).
// SYNTHETIC: the spec's functions are driven with fake engine output (the `show -json` provider_config and the saved
// `.terraform/terraform.tfstate` shapes the S0 spike recorded) and fake credential configurations. No Terraform, no Google
// endpoint and no real credential is used. Every project, bucket and service account below is fake.

const SPEC = GCP as unknown as ProviderSpec;
const root = mkdtempSync(join(tmpdir(), "alz-gcp-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const DEV: GcpTarget = { projectId: "alz-pilot-dev", region: "europe-west4", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default" };
const QA: GcpTarget = { projectId: "alz-pilot-qa", region: "europe-west4", backend: "alz-pilot-qa-state/pilot/qa", workspace: "default" };
const target = (t: GcpTarget): PilotTarget => t as unknown as PilotTarget;
const email = (identity: string, project = DEV.projectId) => "alz-" + identity.toLowerCase().replace("_", "-") + "@" + project + ".iam.gserviceaccount.com";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot/providers/alz-oidc";

let counter = 0;
/** Writes a credential configuration (a fake one by default: a WIF file source) and returns its absolute path. */
function configuration(overrides: Record<string, unknown> = {}, tokenFile = join(root, "token-" + ++counter)): string {
  const path = join(root, "config-" + ++counter + ".json");
  writeFileSync(path, JSON.stringify({
    type: "external_account", audience: AUDIENCE, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: tokenFile }, ...overrides,
  }));
  return path;
}

/** Four complete, distinct identities for DEV. */
function env(extra: NodeJS.ProcessEnv = {}, project = DEV.projectId): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  for (const identity of APPLY_IDENTITIES) {
    e["ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS"] = configuration();
    e["ALZ_" + identity + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"] = email(identity, project);
    e["ALZ_" + identity + "_GOOGLE_PROJECT"] = project;
    e["ALZ_" + identity + "_GOOGLE_REGION"] = DEV.region;
  }
  return { ...e, ...extra };
}

const refusal = (e: NodeJS.ProcessEnv, code: string, ...mentions: string[]): string => {
  const outcome = checkApplyIdentities(e, SPEC, APPLY_IDENTITIES);
  assert.equal(outcome.ok, false, mentions.join());
  if (outcome.ok) return "";
  assert.equal(outcome.code, code, outcome.message);
  for (const name of mentions) assert.ok(outcome.message.includes(name), name + " in " + outcome.message);
  return outcome.message;
};

const codeFrom = (run: () => unknown): string => {
  try { run(); } catch (error) { return codeOf(error); }
  return "OK";
};

// --- admission and the target shape ---------------------------------------------------------------

test("GCP is a registered provider id whose spec is this one (admission rules: test/apply-gcp-admission.test.ts)", () => {
  assert.equal(PROVIDER_IDS.includes("GCP"), true);
  assert.equal(providerSpec("GCP"), GCP);
  assert.equal(GCP.id, "GCP");
});

test("the GCP target fields, backend and parent accept the documented shapes and refuse the rest", () => {
  const ok = (check: (v: string) => boolean, good: string[], bad: string[]) => {
    for (const v of good) assert.equal(check(v), true, v);
    for (const v of bad) assert.equal(check(v), false, v);
  };
  ok(GCP.accountFields.projectId, ["alz-pilot-dev", "abcdef", "a23456789012345678901234567890"],
    ["abcde", "1abcdef", "alz-pilot-", "ALZ-PILOT-DEV", "alz_pilot_dev", "a234567890123456789012345678901", "alz pilot"]);
  ok(GCP.accountFields.region, ["europe-west4", "us-central1", "northamerica-northeast1"], ["europe-west", "EU-WEST4", "europe-west4-a", "global", ""]);
  ok(GCP.backendOk, ["alz-pilot-dev-state/pilot", "alz_state/a/b.c"],
    ["alz-pilot-dev-state", "alz-pilot-dev-state/", "my.bucket/pilot", "goog-state/p", "my-google-state/p", "-bad/p", "ab/p", "alz-state/../x", "alz-state/a b", "Alz-State/p"]);
  ok(gcpParentOk, ["organizations/123456789012", "folders/42"], ["organizations/0", "projects/alz-pilot-dev", "folders/", "folders/12/x"]);
  assert.equal(GCP.account(target(DEV)), "alz-pilot-dev");
  assert.equal(GCP.accountNoun, "project");
  assert.equal(GCP.principalPerEnvironment, true, "a service account email names its project");
  assert.deepEqual(GCP_IDENTITY_VARIABLES, ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_PROJECT", "GOOGLE_REGION"]);
});

// --- identities -----------------------------------------------------------------------------------

test("four distinct WIF identities are accepted; each missing identity, credential configuration or service account is IDENTITY_NOT_CONFIGURED", () => {
  assert.deepEqual(checkApplyIdentities(env(), SPEC, APPLY_IDENTITIES), { ok: true });
  for (const identity of APPLY_IDENTITIES) {
    const e = env();
    for (const key of Object.keys(e)) if (key.startsWith("ALZ_" + identity + "_") && !(identity === "STATE" && key.startsWith("ALZ_STATE_WRITE_"))) delete e[key];
    refusal(e, "IDENTITY_NOT_CONFIGURED", identity);
    for (const name of ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"]) {
      const partial = env(); delete partial["ALZ_" + identity + "_" + name];
      refusal(partial, "IDENTITY_NOT_CONFIGURED", "ALZ_" + identity + "_" + name, "Application Default Credentials");
    }
    refusal(env({ ["ALZ_" + identity + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"]: "alz-apply@developer.gserviceaccount.com" }), "IDENTITY_NOT_CONFIGURED", "not a service account email");
  }
});

test("any two identities sharing a service account (any case or padding), a credential configuration (path, symlink, hard link) or a token file are IDENTITY_COLLAPSED", () => {
  const pairs = APPLY_IDENTITIES.flatMap((a, i) => APPLY_IDENTITIES.slice(i + 1).map((b) => [a, b] as const));
  const dir = mkdtempSync(join(root, "collapse-"));
  const real = configuration();
  symlinkSync(real, join(dir, "symlink"));
  linkSync(real, join(dir, "hardlink"));
  const sharedToken = join(dir, "token");
  for (const [a, b] of pairs) {
    const account = email("APPLY");
    for (const value of [account, account.toUpperCase(), "  " + account + "\n"]) {
      const message = refusal(env({ ["ALZ_" + a + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"]: account, ["ALZ_" + b + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT"]: value }), "IDENTITY_COLLAPSED", "GOOGLE_IMPERSONATE_SERVICE_ACCOUNT");
      assert.equal(message.includes(account), false, "no value in the message");
    }
    for (const other of [real, join(dir, "symlink"), join(dir, "hardlink")]) {
      refusal(env({ ["ALZ_" + a + "_GOOGLE_APPLICATION_CREDENTIALS"]: real, ["ALZ_" + b + "_GOOGLE_APPLICATION_CREDENTIALS"]: other }), "IDENTITY_COLLAPSED", "GOOGLE_APPLICATION_CREDENTIALS");
    }
    const message = refusal(env({
      ["ALZ_" + a + "_GOOGLE_APPLICATION_CREDENTIALS"]: configuration({}, sharedToken),
      ["ALZ_" + b + "_GOOGLE_APPLICATION_CREDENTIALS"]: configuration({}, sharedToken + "/../token"),
    }), "IDENTITY_COLLAPSED", a + " and " + b, "same token file");
    assert.equal(message.includes(sharedToken), false, "no path in the message");
  }
});

test("every key-file, token, gcloud, metadata, emulator and other-cloud fallback on any identity is refused by name, never by value", () => {
  for (const identity of APPLY_IDENTITIES) {
    for (const [name, value] of [
      ["GOOGLE_CREDENTIALS", "{\"type\":\"service_account\",\"private_key\":\"FAKE-KEY-0001\"}"], ["GOOGLE_CLOUD_KEYFILE_JSON", "/home/operator/key.json"],
      ["GCLOUD_KEYFILE_JSON", "/home/operator/key.json"], ["GOOGLE_OAUTH_ACCESS_TOKEN", "fake-token-0001"], ["GOOGLE_BACKEND_CREDENTIALS", "/home/operator/key.json"],
      ["GOOGLE_ENCRYPTION_KEY", "fake-key-0001"], ["GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT", "other@alz-pilot-dev.iam.gserviceaccount.com"],
      ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT_DELEGATES", "other@alz-pilot-dev.iam.gserviceaccount.com"], ["GOOGLE_API_USE_CLIENT_CERTIFICATE", "true"],
      ["GOOGLE_STORAGE_CUSTOM_ENDPOINT", "http://127.0.0.1:4443/"], ["GOOGLE_CLOUD_PROJECT", "alz-pilot-dev"], ["CLOUDSDK_CONFIG", "/home/operator/.config/gcloud"],
      ["CLOUDSDK_AUTH_ACCESS_TOKEN_FILE", "/home/operator/token"], ["GCE_METADATA_HOST", "169.254.169.254"], ["GCE_METADATA_IP", "169.254.169.254"],
      ["STORAGE_EMULATOR_HOST", "http://127.0.0.1:4443"], ["AWS_ACCESS_KEY_ID", "AKIAFAKEFAKEFAKE0000"], ["ARM_CLIENT_SECRET", "fake-secret-0001"], ["AZURE_CLIENT_ID", "fake"],
    ] as const) {
      const message = refusal(env({ ["ALZ_" + identity + "_" + name]: value }), "IDENTITY_NOT_CONFIGURED", "ALZ_" + identity + "_" + name);
      assert.equal(message.includes(value), false, name);
    }
  }
});

test("P2: STORAGE_EMULATOR_HOST in the runner's own environment is refused by name, and no apply child can be handed it", () => {
  const message = refusal(env({ STORAGE_EMULATOR_HOST: "http://127.0.0.1:4443" }), "IDENTITY_NOT_CONFIGURED", "STORAGE_EMULATOR_HOST");
  assert.equal(message.includes("127.0.0.1"), false);
  refusal(env({ STORAGE_EMULATOR_HOST: "" }), "IDENTITY_NOT_CONFIGURED", "STORAGE_EMULATOR_HOST");
  assert.equal(TERRAFORM_APPLY_PROFILE.injectable.includes("STORAGE_EMULATOR_HOST"), false, "the apply profile never injects it");
  assert.equal(TERRAFORM_APPLY_PROFILE.injectablePrefixes.some((prefix) => "STORAGE_EMULATOR_HOST".startsWith(prefix)), false);
});

test("an identity value equal to the operator's own GOOGLE_* variable is refused, whatever its case or path spelling; a shared project or region is not a clash", () => {
  const dir = mkdtempSync(join(root, "ambient-"));
  for (const identity of APPLY_IDENTITIES) {
    const e = env();
    const path = e["ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS"] as string;
    const link = join(dir, identity + ".json");
    symlinkSync(path, link);
    refusal({ ...e, GOOGLE_APPLICATION_CREDENTIALS: link }, "IDENTITY_COLLAPSED", "ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS");
    refusal({ ...e, GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: email(identity).toUpperCase() }, "IDENTITY_COLLAPSED", "ALZ_" + identity + "_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT");
  }
  assert.deepEqual(checkApplyIdentities(env({ GOOGLE_PROJECT: DEV.projectId, GOOGLE_REGION: DEV.region }), SPEC, APPLY_IDENTITIES), { ok: true });
});

test("identity targets: each service account's project, the project and the region must be the environment's; APPLY and STATE_WRITE must set all three", () => {
  const contract = { targets: { DEV: DEV, QA: QA } } as unknown as PilotContract;
  assert.deepEqual(verifyIdentityTargets(contract, "DEV", env(), SPEC, APPLY_IDENTITIES), { ok: true });
  assert.deepEqual(verifyIdentityTargets(contract, "QA", env({}, QA.projectId), SPEC, APPLY_IDENTITIES), { ok: true });
  assert.equal(verifyIdentityTargets(contract, "QA", env(), SPEC, APPLY_IDENTITIES).ok, false, "DEV service accounts do not apply in QA");
  for (const identity of APPLY_IDENTITIES) {
    for (const [name, bad] of [
      ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", email(identity, QA.projectId)], ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "not-an-email"],
      ["GOOGLE_PROJECT", QA.projectId], ["GOOGLE_PROJECT", "ALZ-PILOT-DEV"], ["GOOGLE_REGION", "us-central1"],
    ] as const) {
      const outcome = verifyIdentityTargets(contract, "DEV", env({ ["ALZ_" + identity + "_" + name]: bad }), SPEC, APPLY_IDENTITIES);
      assert.equal(outcome.ok, false, identity + name + bad);
      if (outcome.ok) continue;
      assert.equal(outcome.code, "IDENTITY_TARGET_MISMATCH");
      assert.ok(outcome.message.includes("ALZ_" + identity + "_" + name) && !outcome.message.includes(bad), "names the variable, never the value");
    }
  }
  for (const identity of ["APPLY", "STATE_WRITE"] as const) {
    for (const name of ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", "GOOGLE_PROJECT", "GOOGLE_REGION"]) {
      const e = env(); delete e["ALZ_" + identity + "_" + name];
      assert.equal(verifyIdentityTargets(contract, "DEV", e, SPEC, APPLY_IDENTITIES).ok, false, identity + name);
    }
  }
  assert.equal(GCP.clientIdOk(email("APPLY")), true);
  assert.equal(GCP.clientIdOk(email("APPLY").toUpperCase()), false, "the attested principal is lowercase");
});

// --- the credential configuration (P1) -------------------------------------------------------------

test("a WIF file-source credential configuration is accepted; a key file, an authorized-user file, P1's own impersonation and every other source are refused without quoting the file", () => {
  assert.deepEqual(checkCredentialConfiguration(configuration({}, "/run/alz/dev/apply.jwt")), { ok: true, tokenFile: "/run/alz/dev/apply.jwt", audience: AUDIENCE, subjectTokenType: "urn:ietf:params:oauth:token-type:jwt" });
  assert.equal(checkCredentialConfiguration(configuration({ token_url: undefined, credential_source: { file: "/run/t", format: { type: "text" } } })).ok, true);
  const SECRET = "FAKE-SECRET-VALUE-0001";
  const refused: [string, Record<string, unknown> | string][] = [
    ["P1 own impersonation", { service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/other@x-project.iam.gserviceaccount.com:generateAccessToken" }],
    ["key file", { type: "service_account", private_key: SECRET, private_key_id: SECRET, client_email: email("APPLY") }],
    ["key in a WIF file", { private_key: SECRET }],
    ["authorized user", { type: "authorized_user", client_secret: SECRET, refresh_token: SECRET }],
    ["refresh token", { refresh_token: SECRET }],
    ["access token", { token: SECRET }],
    ["workforce pool", { workforce_pool_user_project: "alz-pilot-dev" }],
    ["token info url", { token_info_url: "https://example.invalid/introspect" }],
    ["foreign token url", { token_url: "https://example.invalid/token" }],
    ["plaintext token url", { token_url: "http://sts.googleapis.com/v1/token" }],
    ["other universe", { universe_domain: "example.invalid" }],
    ["executable source", { credential_source: { executable: { command: "/bin/sh -c id" } } }],
    ["url source", { credential_source: { url: "http://169.254.169.254/token" } }],
    ["environment source", { credential_source: { environment_id: "aws1", region_url: "http://169.254.169.254" } }],
    ["file plus url", { credential_source: { file: "/run/t", url: "http://169.254.169.254" } }],
    ["relative token file", { credential_source: { file: "token.jwt" } }],
    ["json token format", { credential_source: { file: "/run/t", format: { type: "json", subject_token_field_name: "x" } } }],
    ["no audience", { audience: undefined }],
    ["foreign audience", { audience: "https://example.invalid/aud" }],
    ["saml token", { subject_token_type: "urn:ietf:params:oauth:token-type:saml2" }],
  ];
  for (const [label, overrides] of refused) {
    const result = checkCredentialConfiguration(configuration(overrides as Record<string, unknown>));
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.reason.includes(SECRET) || result.reason.includes("example.invalid"), false, label + ": no contents in the reason");
  }
  assert.equal(CREDENTIAL_FILE.source, TOKEN_FILE.source, "the credential module's path pattern is the apply path's TOKEN_FILE");
  const p1 = checkCredentialConfiguration(configuration({ service_account_impersonation_url: "https://x" }));
  assert.ok(!p1.ok && p1.reason.includes("impersonation"), "P1 is named");
  // Not a file of the right kind.
  const dir = mkdtempSync(join(root, "files-"));
  const big = join(dir, "big.json");
  writeFileSync(big, JSON.stringify({ type: "external_account", pad: "x".repeat(70 * 1024) }));
  const notJson = join(dir, "not.json");
  writeFileSync(notJson, SECRET);
  const badUtf8 = join(dir, "bad.json");
  writeFileSync(badUtf8, Buffer.from([0x7b, 0xff, 0x7d]));
  mkdirSync(join(dir, "directory"));
  for (const path of [big, notJson, badUtf8, join(dir, "directory"), join(dir, "missing.json"), "relative.json", join(dir, "with space.json")]) {
    const result = checkCredentialConfiguration(path);
    assert.equal(result.ok, false, path);
    if (!result.ok) assert.equal(result.reason.includes(SECRET), false);
  }
  // Through the identity check: the variable is named, the reason given, the contents never.
  for (const identity of APPLY_IDENTITIES) {
    const message = refusal(env({ ["ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS"]: configuration({ type: "service_account", private_key: SECRET }) }), "IDENTITY_NOT_CONFIGURED", "ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS");
    assert.equal(message.includes(SECRET), false);
  }
});

test("review N1: a FIFO, a device or a directory in place of a credential configuration or a token file is refused at once, never waited on", () => {
  const dir = mkdtempSync(join(root, "fifo-"));
  const fifo = join(dir, "config.json");
  execFileSync("mkfifo", [fifo]);
  // In a child with a deadline: a read that blocks on the FIFO (no writer ever comes) would hang this process, not fail it.
  const module = (name: string) => JSON.stringify(pathToFileURL(join(process.cwd(), "src", name)).href);
  const script = join(dir, "probe.ts");
  writeFileSync(script, [
    "import { checkCredentialConfiguration, readTokenFile } from " + module("tools/gcp-credentials.ts") + ";",
    "const paths = process.argv.slice(2);",
    "console.log(JSON.stringify(paths.map((p) => [checkCredentialConfiguration(p).ok, readTokenFile(p) === undefined])));",
  ].join("\n"));
  const probe = spawnSync(process.execPath, ["--import", "tsx", script, fifo, "/dev/zero", dir], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  assert.equal(probe.signal, null, "the probe was killed at its deadline: a read blocked");
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [[false, true], [false, true], [false, true]]);
  // The control: a regular token file is read.
  const token = join(dir, "token");
  writeFileSync(token, "header.payload.signature\n");
  assert.equal(readTokenFile(token), "header.payload.signature");
  writeFileSync(token, "two words\n");
  assert.equal(readTokenFile(token), undefined);
  assert.equal(readTokenFile(join(dir, "missing")), undefined);
});

// --- the backend ----------------------------------------------------------------------------------

test("the spec pins the gcs backend type, and the driver-built backend configuration carries only bucket, prefix, a credential path and a service account email", () => {
  // The override file names this type once BackendType (src/apply/backend-pin.ts, #297) admits "gcs"; until then the spec is unregistered.
  assert.equal(GCP.backendType, "gcs");
  assert.equal(GCP.backendLocation(target(DEV)), 'bucket = "alz-pilot-dev-state"\nprefix = "pilot/dev"\n');
  const e = env();
  const config = GCP.backendConfig(e, target(DEV));
  assert.equal(config, [
    'bucket = "alz-pilot-dev-state"', 'prefix = "pilot/dev"',
    `credentials = "${e.ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS}"`, `impersonate_service_account = "${email("STATE_WRITE")}"`, "",
  ].join("\n"));
  assert.doesNotMatch(config, /access_token|endpoint|encryption_key|delegates/);
  assert.deepEqual(GCP.filledAtApply, ["credentials", "impersonate_service_account"]);
  for (const [name, value] of [
    ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", email("STATE_WRITE", QA.projectId)], ["GOOGLE_IMPERSONATE_SERVICE_ACCOUNT", 'x"\nstorage_custom_endpoint = "http://127.0.0.1'],
    ["GOOGLE_APPLICATION_CREDENTIALS", "relative.json"], ["GOOGLE_APPLICATION_CREDENTIALS", '/run/x"\naccess_token = "t'],
  ] as const) {
    assert.equal(codeFrom(() => GCP.backendConfig(env({ ["ALZ_STATE_WRITE_" + name]: value }), target(DEV))), "STATE_WRITE_BACKEND_CONFIG_INVALID", name);
  }
  const missing = env(); delete missing.ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS;
  assert.equal(codeFrom(() => GCP.backendConfig(missing, target(DEV))), "STATE_WRITE_BACKEND_CONFIG_INVALID");
  assert.equal(codeFrom(() => GCP.backendLocation(target({ ...DEV, backend: 'x"/y' }))), "BACKEND_NOT_IN_CONTRACT");
});

test("the saved backend must be the contract's gcs bucket and prefix with no token, endpoint, encryption key or delegates (the spike's saved shape, finding B)", () => {
  const writer = env();
  // `.terraform/terraform.tfstate` as Terraform 1.16.4 saved it in the S0 spike: every credential attribute null.
  const saved = (config: Record<string, unknown> = {}, type = "gcs") => ({
    type, config: {
      bucket: "alz-pilot-dev-state", prefix: "pilot/dev", access_token: null, credentials: null, encryption_key: null, impersonate_service_account: null,
      impersonate_service_account_delegates: null, kms_encryption_key: null, storage_custom_endpoint: null, ...config,
    },
  });
  assert.equal(GCP.savedBackendMatches(saved(), target(DEV), writer), true);
  assert.equal(GCP.savedBackendMatches(saved({ credentials: writer.ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS, impersonate_service_account: email("STATE_WRITE") }), target(DEV), writer), true, "the seal-time STATE_WRITE settings");
  for (const [label, backend] of [
    ["another type", saved({}, "s3")], ["another bucket", saved({ bucket: "alz-pilot-qa-state" })], ["another prefix", saved({ prefix: "pilot/qa" })],
    ["no prefix", saved({ prefix: null })], ["QA target", saved()],
    ["access token (finding G1)", saved({ access_token: "SIM-NOT-A-TOKEN" })], ["custom endpoint (finding H)", saved({ storage_custom_endpoint: "http://127.0.0.1:4443/storage/v1/" })],
    ["encryption key", saved({ encryption_key: "fake" })], ["KMS key", saved({ kms_encryption_key: "projects/x/locations/y/keyRings/z/cryptoKeys/k" })],
    ["delegates", saved({ impersonate_service_account_delegates: [email("APPLY")] })], ["no config", { type: "gcs" }],
  ] as const) {
    assert.equal(GCP.savedBackendMatches(backend as Record<string, unknown>, target(label === "QA target" ? QA : DEV), writer), false, label);
  }
});

test("review N2 and the STATE_WRITE binding: the saved gcs backend is an allowlist, and its credential path and service account are STATE_WRITE's own values", () => {
  const writer = env();
  const own = { credentials: writer.ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS, impersonate_service_account: email("STATE_WRITE") };
  const saved = (config: Record<string, unknown> = {}) => ({ type: "gcs", config: { bucket: "alz-pilot-dev-state", prefix: "pilot/dev", ...config } });
  assert.equal(GCP.savedBackendMatches(saved(own), target(DEV), writer), true, "control");
  // Any setting outside the four the product writes, with any value but null: a later backend version's attribute is refused too.
  for (const name of ["a_future_attribute", "universe_domain", "client_certificate", "request_reason", "storage_custom_endpoint"]) {
    assert.equal(GCP.savedBackendMatches(saved({ ...own, [name]: "x" }), target(DEV), writer), false, name);
    assert.equal(GCP.savedBackendMatches(saved({ ...own, [name]: false }), target(DEV), writer), false, name + " (falsy)");
    assert.equal(GCP.savedBackendMatches(saved({ ...own, [name]: null }), target(DEV), writer), true, name + " null is unset");
  }
  // Another identity's values, a lookalike, or a value with no STATE_WRITE value to match.
  for (const [label, change] of [
    ["APPLY's credential configuration", { credentials: writer.ALZ_APPLY_GOOGLE_APPLICATION_CREDENTIALS }],
    ["APPLY's service account", { impersonate_service_account: email("APPLY") }],
    ["the service account in another case", { impersonate_service_account: email("STATE_WRITE").toUpperCase() }],
    ["a relative credential path", { credentials: "sw.json" }], ["a credential path of no identity", { credentials: "/run/alz/sw.json" }],
    ["a non-string service account", { impersonate_service_account: 7 }],
  ] as const) {
    assert.equal(GCP.savedBackendMatches(saved({ ...own, ...change }), target(DEV), writer), false, label);
  }
  // Review N5 of #320: bucket and prefix are compared on their own, never joined.
  assert.equal(GCP.savedBackendMatches(saved({ ...own, bucket: "alz-pilot-dev-state/pilot", prefix: "dev" }), target(DEV), writer), false, "the slash moved into the bucket");
  assert.equal(GCP.savedBackendMatches(saved({ ...own, prefix: ["pilot", "dev"] }), target(DEV), writer), false, "a prefix that is not a string");
  const noWriter = { ...writer };
  delete noWriter.ALZ_STATE_WRITE_GOOGLE_APPLICATION_CREDENTIALS;
  delete noWriter.ALZ_STATE_WRITE_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
  assert.equal(GCP.savedBackendMatches(saved(own), target(DEV), noWriter), false, "saved settings with no STATE_WRITE values");
  assert.equal(GCP.savedBackendMatches(saved(), target(DEV), noWriter), true, "the seal's location-only init binds no identity");
});

// --- the provider configuration -------------------------------------------------------------------

const GOOGLE = (expressions: Record<string, unknown> = {}): ProviderBlock => ({
  name: "google", full_name: "registry.terraform.io/hashicorp/google",
  expressions: { region: { references: ["var.region"] }, default_labels: { references: ["local.unit_labels"] }, ...expressions },
});
const use = (type: string, provider: Pick<ProviderBlock, "name" | "full_name">, mode = "managed"): ProviderUse => ({ address: (mode === "data" ? "data." : "") + type + ".x", mode, type, provider });
const judge = (blocks: ProviderBlock[], uses: ProviderUse[] = []) => codeFrom(() => GCP.assertProviderConfig(blocks, target(DEV), env(), uses));

test("provider config: hashicorp/google with default_labels and the contract's project passes; google-beta, another cloud and a lookalike are refused", () => {
  const googleUse = use("google_pubsub_topic", { name: "google", full_name: "registry.terraform.io/hashicorp/google" });
  assert.equal(judge([GOOGLE()], [googleUse]), "OK");
  assert.equal(judge([GOOGLE({ project: { constant_value: DEV.projectId } })], [googleUse]), "OK");
  assert.equal(judge([GOOGLE({ project: { references: ["var.project"] }, zone: { constant_value: "us-east1-b" } })]), "OK", "an expression, and the zone, are not judged");
  assert.equal(judge([GOOGLE(), { name: "random", full_name: "registry.terraform.io/hashicorp/random" }]), "OK");
  assert.equal(judge([GOOGLE({ project: { constant_value: QA.projectId } })]), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT");
  for (const [label, block] of [
    ["google-beta", { name: "google-beta", full_name: "registry.terraform.io/hashicorp/google-beta" }],
    ["google-beta by name", { name: "google-beta" }],
    ["lookalike namespace", { name: "google", full_name: "registry.terraform.io/attacker/google" }],
    ["aws", { name: "aws", full_name: "registry.terraform.io/hashicorp/aws" }],
    ["azurerm", { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm" }],
    ["unnamed", {}],
  ] as const) {
    assert.equal(judge([GOOGLE(), block as ProviderBlock]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", label);
  }
  assert.equal(judge([GOOGLE()], [use("google_pubsub_topic", { name: "google-beta", full_name: "registry.terraform.io/hashicorp/google-beta" })]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "a google-beta use with no block of its own");
  assert.equal(judge([GOOGLE()], [use("terraform_data", { name: "terraform", full_name: "terraform.io/builtin/terraform" })]), "OK");
  assert.equal(judge([GOOGLE()], [use("terraform_remote_state", { name: "terraform", full_name: "terraform.io/builtin/terraform" }, "data")]), "PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT");
});

test("review N4: a use whose provider the plan does not name is refused, wherever it appears", () => {
  for (const provider of [{}, { name: undefined, full_name: undefined }] as Pick<ProviderBlock, "name" | "full_name">[]) {
    assert.equal(judge([GOOGLE()], [use("google_pubsub_topic", provider)]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "managed");
    assert.equal(judge([GOOGLE()], [use("google_storage_bucket", provider, "data")]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "data");
  }
  assert.equal(judge([GOOGLE()], [use("google_pubsub_topic", { name: "google" })]), "OK", "named by its local name only (a configuration key with no block)");
});

test("review N3 of #305, an allowlist since review N1 of #320: only the reviewed data sources are read; token and secret readers and every other data source are refused in any module and whatever the mode says; managed resources are not data sources", () => {
  const google = { name: "google", full_name: "registry.terraform.io/hashicorp/google" };
  for (const type of [
    "google_client_config", "google_service_account_access_token", "google_service_account_id_token", "google_service_account_jwt",
    "google_secret_manager_secret_version", "google_secret_manager_secret_version_access", "google_secret_manager_regional_secret_version",
    "google_secret_manager_regional_secret_version_access", "google_kms_secret", "google_kms_secret_asymmetric",
    "google_storage_object_signed_url", "google_storage_bucket_object_content", "google_container_cluster", "google_service_account", "google_storage_bucket",
  ]) {
    assert.equal(judge([GOOGLE()], [use(type, google, "data")]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type);
    assert.equal(judge([GOOGLE()], [{ address: "module.app.data." + type + ".x", mode: "managed", type, provider: google }]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + " under a data address");
    assert.equal(judge([GOOGLE()], [{ address: type + ".x", mode: "", type, provider: google }]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + " with no mode");
  }
  // A resource holds only what the project configures; a data source of an ordinary type is not judged by this rule.
  assert.equal(judge([GOOGLE()], [use("google_secret_manager_secret_version", google)]), "OK");
  for (const type of GCP_DATA_SOURCES) assert.equal(judge([GOOGLE()], [use(type, google, "data")]), "OK", type);
  assert.equal(judge([GOOGLE()], [use("terraform_remote_state", { name: "terraform" }, "data")]), "PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT", "the built-in remote state, by its local name");
  assert.equal(judge([GOOGLE()], [use("http", { full_name: "registry.terraform.io/hashicorp/http" }, "data")]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "another provider's data source");
  // A refused data source names no value: the code is all the driver reports (TARGET_NOT_IN_CONTRACT, nothing spent).
  assert.match("PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", /_NOT_IN_CONTRACT$/);
});

test("provider config: credentials, tokens, impersonation, scopes, endpoints, universe and billing overrides are refused as constants and as expressions; default_labels must be set", () => {
  for (const name of [
    "credentials", "access_token", "impersonate_service_account", "impersonate_service_account_delegates", "scopes", "storage_custom_endpoint",
    "compute_custom_endpoint", "universe_domain", "request_reason", "billing_project", "user_project_override", "external_credentials",
  ]) {
    assert.equal(judge([GOOGLE({ [name]: { constant_value: "x" } })]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", name + " constant");
    assert.equal(judge([GOOGLE({ [name]: { references: ["var.x"] } })]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", name + " expression");
    assert.equal(judge([GOOGLE({ [name]: { constant_value: null } })]), "OK", name + " explicitly null is unset");
  }
  const noLabels = GOOGLE(); delete noLabels.expressions!.default_labels;
  assert.equal(judge([noLabels]), "PROVIDER_CONFIG_NOT_IN_CONTRACT");
  assert.equal(judge([GOOGLE({ default_labels: { constant_value: null } })]), "PROVIDER_CONFIG_NOT_IN_CONTRACT");
  assert.deepEqual(GCP.tagAttributes, ["effective_labels", "labels"]);
});

// --- P4: the protected bucket forms ---------------------------------------------------------------

test("P4: the state bucket is recognized under every identifier form, as a part of an IAM id and as a path prefix, and a neighbor bucket is not", () => {
  const bucket = "alz-pilot-dev-state";
  assert.deepEqual(backendBucketForms(bucket), [
    bucket, "b/" + bucket, "projects/_/buckets/" + bucket, "gs://" + bucket, "//storage.googleapis.com/projects/_/buckets/" + bucket,
    "https://storage.googleapis.com/storage/v1/b/" + bucket, "https://www.googleapis.com/storage/v1/b/" + bucket,
  ]);
  const buckets = [bucket, "alz-pilot-qa-state"];
  for (const value of [
    ...backendBucketForms(bucket), "gs://alz-pilot-qa-state", "GS://ALZ-PILOT-DEV-STATE", "gs://" + bucket + "/pilot/dev/default.tfstate",
    "b/" + bucket + " roles/storage.objectViewer serviceAccount:x@alz-pilot-dev.iam.gserviceaccount.com", "projects/_/buckets/" + bucket + "/objects/pilot",
    "//storage.googleapis.com/projects/_/buckets/" + bucket + "/objects/x", bucket + "/pilot/dev/default.tflock",
  ]) assert.equal(namesBackendBucket(value, buckets), true, value);
  for (const value of ["alz-pilot-dev-state-2", "gs://alz-pilot-dev-statex", "b/alz-pilot-dev-state2", "projects/alz-pilot-dev/topics/alz-pilot-dev-state-events", "", "alz-pilot-dev"]) {
    assert.equal(namesBackendBucket(value, buckets), false, value);
  }
});
