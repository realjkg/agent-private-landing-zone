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
import { GCP, GCP_DATA_SOURCES, GCP_DENIED_TYPES, GCP_DENIED_TYPES_REVIEWED_AGAINST, GCP_IDENTITY_VARIABLES, backendBucketForms, checkCredentialConfiguration, gcpParentOk, namesBackendBucket, type GcpTarget } from "../src/apply/providers/gcp.js";
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
  expressions: { project: { constant_value: DEV.projectId }, region: { references: ["var.region"] }, default_labels: { references: ["local.unit_labels"] }, ...expressions },
});
/** The canary topic's storage policy as the configuration and the plan show it (hashicorp/google 8.9.0, the EMULATED run's real shapes). */
const STORAGE_POLICY_CONFIG = { allowed_persistence_regions: { constant_value: [DEV.region] } };
const STORAGE_POLICY_PLANNED = { message_storage_policy: [{ allowed_persistence_regions: [DEV.region], enforce_in_transit: null }] };
const use = (type: string, provider: Pick<ProviderBlock, "name" | "full_name">, mode = "managed"): ProviderUse => ({ address: (mode === "data" ? "data." : "") + type + ".x", mode, type, provider });
const judge = (blocks: ProviderBlock[], uses: ProviderUse[] = []) => codeFrom(() => GCP.assertProviderConfig(blocks, target(DEV), env(), uses));

test("provider config: hashicorp/google with default_labels and the contract's project passes; google-beta, another cloud and a lookalike are refused", () => {
  const googleUse = use("google_pubsub_topic", { name: "google", full_name: "registry.terraform.io/hashicorp/google" });
  assert.equal(judge([GOOGLE()], [googleUse]), "OK");
  assert.equal(judge([GOOGLE({ project: { constant_value: DEV.projectId } })], [googleUse]), "OK");
  assert.equal(judge([GOOGLE({ zone: { constant_value: "us-east1-b" } })]), "OK", "the zone is not judged");
  // Review N1 of #339: the provider's project is a plain constant, the contract's; an expression or an absent project is refused.
  assert.equal(judge([GOOGLE({ project: { references: ["var.project"] } })]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "an expression");
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

test("review N1 of #339: every google provider block and every managed google resource is bound to the contract's project, configured and planned", () => {
  const google = { name: "google", full_name: "registry.terraform.io/hashicorp/google" };
  const topic = (extra: Partial<ProviderUse> = {}): ProviderUse => ({ ...use("google_pubsub_topic", google), ...extra });
  // Every configured canary topic carries the contract region's storage policy (R2 of G1), so these cases judge the project alone.
  const configured = (project?: unknown): ProviderUse => topic({ expressions: { name: { constant_value: "t" }, message_storage_policy: [STORAGE_POLICY_CONFIG], ...(project === undefined ? {} : { project }) } });
  const withoutProject = GOOGLE(); delete withoutProject.expressions!.project;
  // The provider block: the contract's constant only, in every block and alias.
  for (const [label, block, code] of [
    ["provider project as an expression (var.p)", GOOGLE({ project: { references: ["var.p"] } }), "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["provider project omitted", withoutProject, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["provider project constant and a reference", GOOGLE({ project: { constant_value: DEV.projectId, references: ["var.p"] } }), "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["provider project not text", GOOGLE({ project: { constant_value: 42 } }), "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["provider project of another project", GOOGLE({ project: { constant_value: "other-proj-123" } }), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
  ] as const) assert.equal(judge([block], [topic()]), code, label);
  assert.equal(judge([GOOGLE(), { ...GOOGLE({ project: { constant_value: "other-proj-123" } }), name: "google.x" }], [topic()]), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT", "an alias of another project");
  assert.equal(judge([GOOGLE(), { ...withoutProject, name: "google.x" }], [topic()]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "an alias with no project");
  assert.equal(judge([], [topic()]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "a google use with no google provider block");
  // The resource's own project, configured.
  assert.equal(judge([GOOGLE()], [configured()]), "OK", "omitted: the provider block's constant");
  assert.equal(judge([GOOGLE()], [configured({ constant_value: DEV.projectId })]), "OK", "the contract's project");
  for (const [label, project, code] of [
    ["RESOURCE topic project other constant", { constant_value: "victim-proj-123" }, "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ["another spelling", { constant_value: DEV.projectId.toUpperCase() }, "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ["RESOURCE topic project var", { references: ["var.p"] }, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["a constant and a reference", { constant_value: DEV.projectId, references: ["var.p"] }, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["not text", { constant_value: 7 }, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
  ] as const) assert.equal(judge([GOOGLE()], [configured(project)]), code, label);
  assert.equal(judge([GOOGLE()], [topic({ expressions: { project_id: { constant_value: "victim-proj-123" } } })]), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT", "project_id");
  // The resource's planned project: a change's after, a planned value, and an unknown one.
  assert.equal(judge([GOOGLE()], [configured(), topic({ values: { name: "t", project: DEV.projectId, ...STORAGE_POLICY_PLANNED }, unknown: { id: true, project: false } })]), "OK", "planned as the contract's project");
  assert.equal(judge([GOOGLE()], [configured(), topic({ values: { name: "t", ...STORAGE_POLICY_PLANNED }, unknown: { id: true } })]), "OK", "no project attribute planned");
  for (const [label, planned, code] of [
    ["RESOURCE topic planned project other (VALUES)", { values: { project: "victim-proj-123" } }, "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ["planned project_id of another project", { values: { project_id: "victim-proj-123" } }, "PROVIDER_ACCOUNT_NOT_IN_CONTRACT"],
    ["planned project unknown until apply", { values: { name: "t" }, unknown: { project: true } }, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
    ["planned project not text", { values: { project: ["x"] } }, "PROVIDER_CONFIG_NOT_IN_CONTRACT"],
  ] as const) assert.equal(judge([GOOGLE()], [configured(), topic(planned as Partial<ProviderUse>)]), code, label);
  // Not google's: another allowed provider's resources carry no project.
  assert.equal(judge([GOOGLE()], [{ ...use("random_id", { name: "random", full_name: "registry.terraform.io/hashicorp/random" }), values: { project: "x" } }]), "OK", "a random resource is not judged for a project");
});

/**
 * The canary topic exactly as hashicorp/google 8.9.0 plans it under Terraform 1.16.4 (the EMULATED run of test/apply-emulated-gcp.test.ts,
 * read 2026-10-29): unset blocks are empty lists, unset attributes null, `deletion_policy` defaults to "DELETE" and the project is known.
 */
const PLANNED_TOPIC = {
  deletion_policy: "DELETE", effective_labels: { "alz-unit": "u" }, ingestion_data_source_settings: [], kms_key_name: null, labels: { purpose: "act-dev-1" },
  message_retention_duration: null, ...STORAGE_POLICY_PLANNED, message_transforms: [], name: "alz-act-dev-1-canary-01", project: DEV.projectId,
  schema_settings: [], tags: null, timeouts: null,
};
const PLANNED_UNKNOWN = { effective_labels: {}, id: true, ingestion_data_source_settings: [], labels: {}, message_storage_policy: [{ allowed_persistence_regions: [false] }], message_transforms: [], schema_settings: [] };
const CONFIGURED_TOPIC = { labels: { constant_value: { purpose: "act-dev-1" } }, message_storage_policy: [STORAGE_POLICY_CONFIG], name: { references: ["var.canary_name"] } };

test("R1 and R2 of G1: the canary topic carries no CMEK, schema, ingestion, transform, retention, tag binding or project number, keeps the default deletion policy, and stores only in the contract's region", () => {
  const google = { name: "google", full_name: "registry.terraform.io/hashicorp/google" };
  const configuredTopic = (expressions: Record<string, unknown> = {}): ProviderUse => ({ ...use("google_pubsub_topic", google), expressions: { ...CONFIGURED_TOPIC, ...expressions } });
  const plannedTopic = (values: Record<string, unknown> = {}, unknown: Record<string, unknown> = PLANNED_UNKNOWN): ProviderUse =>
    ({ ...use("google_pubsub_topic", google), values: { ...PLANNED_TOPIC, ...values }, unknown });
  const both = (expressions: Record<string, unknown> = {}, values: Record<string, unknown> = {}, unknown?: Record<string, unknown>) =>
    judge([GOOGLE()], [configuredTopic(expressions), plannedTopic(values, unknown)]);
  // The control: the real planned shape, configured with a constant region or with an expression the plan resolves.
  assert.equal(both(), "OK");
  assert.equal(both({ message_storage_policy: [{ allowed_persistence_regions: { references: ["var.region"] } }] }), "OK", "an expression, judged on the planned value");
  assert.equal(both({ message_storage_policy: [{ ...STORAGE_POLICY_CONFIG, enforce_in_transit: { constant_value: true } }] }, { message_storage_policy: [{ allowed_persistence_regions: [DEV.region], enforce_in_transit: true }] }), "OK", "enforce_in_transit only narrows");
  assert.equal(both({ deletion_policy: { constant_value: "DELETE" } }), "OK", "the default deletion policy, stated");

  // R1: each attribute refused when configured, when planned with a value, and when unknown until apply.
  const R1: readonly [string, unknown, unknown][] = [
    ["kms_key_name", { constant_value: "projects/other-proj/locations/europe-west4/keyRings/r/cryptoKeys/k" }, "projects/other-proj/locations/europe-west4/keyRings/r/cryptoKeys/k"],
    ["schema_settings", [{ schema: { constant_value: "projects/other-proj/schemas/s" } }], [{ schema: "projects/other-proj/schemas/s", encoding: "JSON", first_revision_id: null, last_revision_id: null }]],
    ["ingestion_data_source_settings", [{ cloud_storage: [{ bucket: { constant_value: "other-bucket" } }] }], [{ cloud_storage: [{ bucket: "other-bucket" }] }]],
    ["message_transforms", [{ javascript_udf: [{ code: { constant_value: "function f(m){return m}" }, function_name: { constant_value: "f" } }] }], [{ javascript_udf: [{ code: "function f(m){return m}", function_name: "f" }], disabled: false }]],
    ["message_retention_duration", { constant_value: "600s" }, "600s"],
    ["tags", { constant_value: { "tagKeys/123": "tagValues/456" } }, { "tagKeys/123": "tagValues/456" }],
    ["project_number", { constant_value: "123456789012" }, "123456789012"],
  ];
  for (const [attribute, configured, planned] of R1) {
    assert.equal(both({ [attribute]: configured }), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT", attribute + " configured");
    assert.equal(both({}, { [attribute]: planned }), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT", attribute + " planned");
    assert.equal(both({}, {}, { ...PLANNED_UNKNOWN, [attribute]: true }), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT", attribute + " unknown until apply");
    assert.equal(judge([GOOGLE()], [{ ...plannedTopic({ [attribute]: planned }), mode: "data", address: "data.google_pubsub_topic.x", expressions: { project: { constant_value: DEV.projectId } } }]), "OK", attribute + ": a data source of the type is read, not the canary");
  }
  assert.equal(both({ kms_key_name: { constant_value: null } }), "OK", "a null constant is unset");
  assert.equal(both({}, { message_transforms: [{ ai_inference: [{ endpoint: "projects/other-proj/locations/us-central1/endpoints/e" }] }] }), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT", "an AI inference transform");
  assert.equal(both({}, {}, { ...PLANNED_UNKNOWN, schema_settings: [{ schema: true }] }), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT", "an unknown nested inside a block");
  for (const [label, expressions, values, unknown] of [
    ["ABANDON configured", { deletion_policy: { constant_value: "ABANDON" } }, {}, undefined],
    ["PREVENT configured", { deletion_policy: { constant_value: "PREVENT" } }, {}, undefined],
    ["an expression", { deletion_policy: { references: ["var.policy"] } }, {}, undefined],
    ["ABANDON planned", {}, { deletion_policy: "ABANDON" }, undefined],
    ["unknown until apply", {}, {}, { ...PLANNED_UNKNOWN, deletion_policy: true }],
  ] as const) assert.equal(both(expressions, values, unknown), "CANARY_ATTRIBUTE_NOT_IN_CONTRACT", "deletion_policy: " + label);

  // R2: the storage policy, configured and planned.
  for (const [label, expressions, values, unknown] of [
    ["no storage-policy block configured", { message_storage_policy: undefined }, {}, undefined],
    ["two blocks configured", { message_storage_policy: [STORAGE_POLICY_CONFIG, STORAGE_POLICY_CONFIG] }, {}, undefined],
    ["another region configured", { message_storage_policy: [{ allowed_persistence_regions: { constant_value: ["us-central1"] } }] }, {}, undefined],
    ["a second region configured", { message_storage_policy: [{ allowed_persistence_regions: { constant_value: [DEV.region, "us-central1"] } }] }, {}, undefined],
    ["an empty region list configured", { message_storage_policy: [{ allowed_persistence_regions: { constant_value: [] } }] }, {}, undefined],
    ["a region in another case", { message_storage_policy: [{ allowed_persistence_regions: { constant_value: [DEV.region.toUpperCase()] } }] }, {}, undefined],
    ["a block with no region list", { message_storage_policy: [{ enforce_in_transit: { constant_value: true } }] }, {}, undefined],
    ["no policy planned", {}, { message_storage_policy: [] }, undefined],
    ["the policy absent from the plan", {}, { message_storage_policy: undefined }, undefined],
    ["another region planned", {}, { message_storage_policy: [{ allowed_persistence_regions: ["us-central1"] }] }, undefined],
    ["a second region planned", {}, { message_storage_policy: [{ allowed_persistence_regions: ["us-central1", DEV.region] }] }, undefined],
    ["two planned blocks", {}, { message_storage_policy: [STORAGE_POLICY_PLANNED.message_storage_policy[0], STORAGE_POLICY_PLANNED.message_storage_policy[0]] }, undefined],
    ["regions unknown until apply", {}, {}, { ...PLANNED_UNKNOWN, message_storage_policy: [{ allowed_persistence_regions: [true] }] }],
    ["the whole block unknown until apply", {}, {}, { ...PLANNED_UNKNOWN, message_storage_policy: true }],
  ] as const) {
    const configured = { ...CONFIGURED_TOPIC, ...expressions } as Record<string, unknown>;
    if (Object.hasOwn(expressions, "message_storage_policy") && expressions.message_storage_policy === undefined) delete configured.message_storage_policy;
    const plannedValues = { ...PLANNED_TOPIC, ...values } as Record<string, unknown>;
    if (Object.hasOwn(values, "message_storage_policy") && (values as Record<string, unknown>).message_storage_policy === undefined) delete plannedValues.message_storage_policy;
    const code = judge([GOOGLE()], [{ ...use("google_pubsub_topic", google), expressions: configured }, { ...use("google_pubsub_topic", google), values: plannedValues, unknown: unknown ?? PLANNED_UNKNOWN }]);
    assert.equal(code, "LOCATION_NOT_IN_CONTRACT", label);
  }
  // The contract region is the one judged: the same plan in another contract's region is refused.
  assert.equal(codeFrom(() => GCP.assertProviderConfig([GOOGLE()], target({ ...DEV, region: "us-central1" }), env(), [configuredTopic(), plannedTopic()])), "LOCATION_NOT_IN_CONTRACT");
  // A destroy plan's change has no planned values: only the configuration is judged, and the committed policy passes.
  assert.equal(judge([GOOGLE()], [configuredTopic(), { ...use("google_pubsub_topic", google) }]), "OK", "a destroy");
});

test("the #339 follow-up: a google data source is judged by its configuration address, not its type; another read of the same type that the configuration does not show is refused", () => {
  const google = { name: "google", full_name: "registry.terraform.io/hashicorp/google" };
  const configured = (address: string): ProviderUse => ({ address, mode: "data", type: "google_project", provider: google, expressions: { project_id: { constant_value: DEV.projectId } } });
  const read = (address: string, project = DEV.projectId): ProviderUse => ({ address, mode: "data", type: "google_project", provider: google, values: { project_id: project } });
  assert.equal(judge([GOOGLE()], [configured("data.google_project.this"), read("data.google_project.this")]), "OK");
  assert.equal(judge([GOOGLE()], [configured("data.google_project.this"), read("module.net.data.google_project.this")]), "OK", "the same configuration address inside a module");
  assert.equal(judge([GOOGLE()], [configured("data.google_project.this"), read('data.google_project.this["a"]'), read("data.google_project.this[0]")]), "OK", "instances of the configured data source");
  // Before: any configured google_project stood in for every read of that type. Now each read needs its own configured address.
  assert.equal(judge([GOOGLE()], [configured("data.google_project.this"), read("data.google_project.other")]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", "an unconfigured read of the same type");
  assert.equal(judge([GOOGLE()], [configured("data.google_project.this"), read("data.google_project.this_other")]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", "a lookalike address");
  assert.equal(judge([GOOGLE()], [configured("data.google_project.this"), read("data.google_project.this[unparsed")]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", "an address that does not reduce is refused");
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
  // Each reviewed data source passes when the configuration names the contract's project as a constant (review N3 of #323, below).
  const projectAttribute = { google_project: "project_id", google_pubsub_topic: "project" } as const;
  for (const type of GCP_DATA_SOURCES) {
    const configured: ProviderUse = { ...use(type, google, "data"), expressions: { [projectAttribute[type as keyof typeof projectAttribute]]: { constant_value: DEV.projectId } } };
    assert.equal(judge([GOOGLE()], [configured]), "OK", type);
  }
  assert.equal(judge([GOOGLE()], [use("terraform_remote_state", { name: "terraform" }, "data")]), "PROVIDER_BUILTIN_TYPE_NOT_IN_CONTRACT", "the built-in remote state, by its local name");
  assert.equal(judge([GOOGLE()], [use("http", { full_name: "registry.terraform.io/hashicorp/http" }, "data")]), "PROVIDER_CONFIG_NOT_IN_CONTRACT", "another provider's data source");
  // A refused data source names no value: the code is all the driver reports (TARGET_NOT_IN_CONTRACT, nothing spent).
  assert.match("PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", /_NOT_IN_CONTRACT$/);
});

test("review N3 of #323: google_project and google_pubsub_topic data sources must name the contract's project as a constant; another project, the provider's default, an expression or an unconfigured read is refused", () => {
  const google = { name: "google", full_name: "registry.terraform.io/hashicorp/google" };
  for (const [type, attribute] of [["google_project", "project_id"], ["google_pubsub_topic", "project"]] as const) {
    const configured = (expression: unknown): ProviderUse => ({ ...use(type, google, "data"), expressions: expression === undefined ? {} : { [attribute]: expression } });
    const read = (value: unknown): ProviderUse => ({ ...use(type, google, "data"), values: { [attribute]: value } });
    const own = configured({ constant_value: DEV.projectId });
    assert.equal(judge([GOOGLE()], [own]), "OK", type + ": the contract's project");
    assert.equal(judge([GOOGLE()], [own, read(DEV.projectId)]), "OK", type + ": and the value it read is the contract's project");
    assert.equal(judge([GOOGLE()], [configured({ constant_value: QA.projectId })]), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT", type + ": another project");
    assert.equal(judge([GOOGLE()], [configured({ constant_value: DEV.projectId.toUpperCase() })]), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT", type + ": another spelling");
    assert.equal(judge([GOOGLE()], [own, read(QA.projectId)]), "PROVIDER_ACCOUNT_NOT_IN_CONTRACT", type + ": a read value of another project");
    assert.equal(judge([GOOGLE()], [configured(undefined)]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + ": unstated (the provider's default project)");
    assert.equal(judge([GOOGLE()], [configured({ references: ["var.project"] })]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + ": an expression");
    assert.equal(judge([GOOGLE()], [configured({ constant_value: DEV.projectId, references: ["var.x"] })]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + ": not a plain constant");
    assert.equal(judge([GOOGLE()], [configured({ constant_value: 42 })]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + ": not text");
    assert.equal(judge([GOOGLE()], [use(type, google, "data")]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + ": a read the configuration does not show");
    assert.equal(judge([GOOGLE()], [read(DEV.projectId)]), "PROVIDER_DATA_SOURCE_NOT_IN_CONTRACT", type + ": a read value alone");
  }
});

test("GCP_DENIED_TYPES: types that run code or deploy a template at apply are refused as managed uses, each in the pinned hashicorp/google 8.9.0 schema", () => {
  const google = { name: "google", full_name: "registry.terraform.io/hashicorp/google" };
  for (const type of [
    "google_deployment_manager_deployment", "google_config_deployment", "google_cloudfunctions_function", "google_cloudfunctions2_function",
    "google_cloud_run_v2_job", "google_cloudbuild_trigger", "google_composer_environment", "google_dataflow_job", "google_dataflow_flex_template_job",
    "google_dataproc_job", "google_bigquery_job", "google_os_config_patch_deployment", "google_gke_hub_feature",
    // Review N2 of #339.
    "google_dataproc_cluster", "google_compute_instance", "google_compute_instance_template", "google_workbench_instance",
    "google_cloud_scheduler_job", "google_clouddeploy_automation", "google_dataplex_datascan",
  ]) {
    assert.ok(GCP_DENIED_TYPES.has(type), type);
    assert.equal(judge([GOOGLE()], [use(type, google)]), "PROVIDER_TYPE_NOT_ALLOWED", type);
    assert.equal(judge([GOOGLE()], [{ address: "module.app." + type + ".x", mode: "managed", type, provider: google }]), "PROVIDER_TYPE_NOT_ALLOWED", type + " in a module");
  }
  assert.equal(GCP_DENIED_TYPES_REVIEWED_AGAINST, "hashicorp/google 8.9.0", "re-review the denied types against the new schema when the reviewed version changes");
  for (const type of GCP_DENIED_TYPES) assert.match(type, /^google_[a-z0-9_]+$/, type);
  assert.equal(GCP_DENIED_TYPES.size, 42, "the reviewed list: 35, and 7 from review N2 of #339; a change is a reviewed change");
  // The canary's own type and ordinary resources are not denied.
  for (const type of ["google_pubsub_topic", "google_storage_bucket", "google_cloud_run_v2_service"]) assert.equal(judge([GOOGLE()], [use(type, google)]), "OK", type);
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
