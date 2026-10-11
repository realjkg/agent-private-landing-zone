import assert from "node:assert/strict";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPLY_IDENTITIES } from "../src/apply/types.js";
import { checkApplyIdentities, verifyIdentityTargets } from "../src/apply/identities.js";
import type { PilotContract } from "../src/apply/types.js";
import { buildChildEnvironment } from "../src/tools/child-env.js";
import {
  collapsedIdentityVariables,
  EXECUTION_IDENTITIES,
  forbiddenIdentityVariables,
  isExecutionIdentity,
} from "../src/tools/identity.js";
import { PROFILES } from "../src/tools/profiles.js";
import { AZURE } from "../src/apply/providers/azure.js";

// Explicit fixtures: none of these are real tenants, subscriptions or principals.
const TENANT = "00000000-0000-4000-8000-000000000001";
const SUBSCRIPTION = "00000000-0000-4000-8000-000000000002";
const fixture = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [index, identity] of APPLY_IDENTITIES.entries()) {
    env[`ALZ_${identity}_ARM_CLIENT_ID`] = `10000000-0000-4000-8000-00000000000${index}`;
    env[`ALZ_${identity}_ARM_TENANT_ID`] = TENANT;
    env[`ALZ_${identity}_ARM_SUBSCRIPTION_ID`] = SUBSCRIPTION;
    env[`ALZ_${identity}_ARM_USE_OIDC`] = "true";
    env[`ALZ_${identity}_ARM_OIDC_TOKEN_FILE`] = `/run/fixtures/${identity.toLowerCase()}.jwt`;
  }
  return env;
};
const childFor = (env: NodeJS.ProcessEnv, identity: string, profile = PROFILES.terraform) =>
  buildChildEnvironment({ profile, base: env, toolDirs: ["/usr/bin"], home: "/h", tmp: "/t", identity });

test("the execution identities are the four apply identities, in the contract order", () => {
  assert.deepEqual([...EXECUTION_IDENTITIES], [...APPLY_IDENTITIES]);
  assert.equal(isExecutionIdentity("STATE_WRITE"), true);
  assert.equal(isExecutionIdentity("APPLY"), true);
  for (const bad of ["DEPLOY", "OPERATOR", "STATE_", "apply", "APPLY_X"]) assert.equal(isExecutionIdentity(bad), false, bad);
});

test("APPLY is no longer a forbidden prefix, and every other forbidden prefix still is", () => {
  const env = {
    ALZ_DEPLOY_X: "x", ALZ_DEPLOYMENT_X: "x", ALZ_OPERATOR_X: "x", ALZ_ADMIN_X: "x", ALZ_DESTROY_X: "x",
    ALZ_APPLY_ARM_CLIENT_ID: "x", ALZ_STATE_WRITE_ARM_CLIENT_ID: "x",
  };
  assert.deepEqual(forbiddenIdentityVariables(env),
    ["ALZ_ADMIN_X", "ALZ_DEPLOYMENT_X", "ALZ_DEPLOY_X", "ALZ_DESTROY_X", "ALZ_OPERATOR_X"].sort());
});

test("checkApplyIdentities accepts four configured, distinct identities", () => {
  assert.deepEqual(checkApplyIdentities(fixture(), AZURE), { ok: true });
});

test("each missing identity is IDENTITY_NOT_CONFIGURED, named, with no fallback", () => {
  for (const identity of APPLY_IDENTITIES) {
    const env = fixture();
    for (const key of Object.keys(env)) if (key.startsWith(`ALZ_${identity}_`) && !(identity === "STATE" && key.startsWith("ALZ_STATE_WRITE_"))) delete env[key];
    const outcome = checkApplyIdentities(env, AZURE);
    assert.equal(outcome.ok, false, identity);
    if (outcome.ok) continue;
    assert.equal(outcome.code, "IDENTITY_NOT_CONFIGURED", identity);
    assert.match(outcome.message, new RegExp(identity), identity);
  }
  assert.equal((checkApplyIdentities({}, AZURE) as { code: string }).code, "IDENTITY_NOT_CONFIGURED");
});

test("STATE_WRITE variables do not count as STATE configuration, and empty values do not count at all", () => {
  const env = fixture();
  for (const key of Object.keys(env)) if (key.startsWith("ALZ_STATE_") && !key.startsWith("ALZ_STATE_WRITE_")) delete env[key];
  const outcome = checkApplyIdentities(env, AZURE);
  assert.equal(outcome.ok, false);
  assert.match((outcome as { message: string }).message, /\bSTATE\b/);
  const blank = fixture();
  for (const key of Object.keys(blank)) if (key.startsWith("ALZ_APPLY_")) blank[key] = "";
  assert.equal((checkApplyIdentities(blank, AZURE) as { code: string }).code, "IDENTITY_NOT_CONFIGURED");
});

test("any pair sharing a principal or secret is IDENTITY_COLLAPSED, for all six pairs", () => {
  const pairs = APPLY_IDENTITIES.flatMap((a, i) => APPLY_IDENTITIES.slice(i + 1).map((b) => [a, b] as const));
  assert.equal(pairs.length, 6);
  for (const [a, b] of pairs) {
    for (const name of ["ARM_CLIENT_ID", "ARM_OIDC_TOKEN_FILE", "ARM_CLIENT_SECRET"]) {
      const env = fixture();
      const secret = "shared-secret-value-0001";
      env[`ALZ_${a}_${name}`] = secret;
      env[`ALZ_${b}_${name}`] = secret;
      const outcome = checkApplyIdentities(env, AZURE);
      assert.equal(outcome.ok, false, `${a}/${b}/${name}`);
      if (outcome.ok) continue;
      assert.equal(outcome.code, "IDENTITY_COLLAPSED", `${a}/${b}/${name}`);
      assert.match(outcome.message, new RegExp(name), name);
      assert.equal(outcome.message.includes(secret), false, "no value in the message");
    }
  }
});

test("AWS credentials on any identity are refused under an Azure contract", () => {
  for (const identity of APPLY_IDENTITIES) {
    for (const name of ["AWS_ACCESS_KEY_ID", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_PROFILE"]) {
      const outcome = checkApplyIdentities({ ...fixture(), [`ALZ_${identity}_${name}`]: "fake-0001" }, AZURE);
      assert.equal(outcome.ok, false, `${identity}/${name}`);
      if (!outcome.ok) assert.equal(outcome.code, "IDENTITY_NOT_CONFIGURED");
    }
  }
});

test("sharing the tenant, subscription and OIDC flag is expected and is not a collapse", () => {
  assert.deepEqual(checkApplyIdentities(fixture(), AZURE), { ok: true });
});

test("a non-secret principal id shared by STATE and DISCOVERY is now reported by the existing check", () => {
  const env = { ALZ_STATE_ARM_CLIENT_ID: "same-client", ALZ_DISCOVERY_ARM_CLIENT_ID: "same-client" };
  assert.deepEqual(collapsedIdentityVariables(env), ["ARM_CLIENT_ID"]);
});

test("STATE_WRITE is not mistaken for STATE by the STATE-versus-DISCOVERY check", () => {
  const env = { ALZ_STATE_WRITE_ARM_CLIENT_SECRET: "same-secret-0001", ALZ_DISCOVERY_WRITE_ARM_CLIENT_SECRET: "same-secret-0001" };
  assert.deepEqual(collapsedIdentityVariables(env), []);
});

test("principals are compared after normalizing: GUID case, padding, path spelling, and symlinks or hard links to one file", () => {
  const collapsedWith = (over: Record<string, string>): string => {
    const env = { ...fixture(), ...over };
    const outcome = checkApplyIdentities(env, AZURE);
    return outcome.ok ? "ok" : outcome.code;
  };
  const GUID_A = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
  assert.equal(collapsedWith({ ALZ_APPLY_ARM_CLIENT_ID: GUID_A, ALZ_STATE_WRITE_ARM_CLIENT_ID: GUID_A.toLowerCase() }), "IDENTITY_COLLAPSED", "upper vs lower GUID");
  assert.equal(collapsedWith({ ALZ_APPLY_ARM_CLIENT_ID: GUID_A, ALZ_STATE_WRITE_ARM_CLIENT_ID: " " + GUID_A.toLowerCase() + "\n" }), "IDENTITY_COLLAPSED", "trimmed");
  assert.equal(collapsedWith({ ALZ_APPLY_ARM_CLIENT_ID: GUID_A, ALZ_STATE_WRITE_ARM_CLIENT_ID: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb" }), "ok", "different GUIDs stay separate");
  assert.equal(collapsedWith({ ALZ_APPLY_ARM_OIDC_TOKEN_FILE: "/run/t", ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: "/run//t" }), "IDENTITY_COLLAPSED", "/run/t vs /run//t");
  assert.equal(collapsedWith({ ALZ_APPLY_ARM_OIDC_TOKEN_FILE: "/run/t", ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: "/run/x/../t " }), "IDENTITY_COLLAPSED", "dot-dot and padding");
  assert.equal(collapsedWith({ ALZ_APPLY_ARM_OIDC_TOKEN_FILE: "/run/t", ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: "/run/u" }), "ok", "different paths stay separate");

  const dir = mkdtempSync(join(tmpdir(), "alz-ident-"));
  try {
    const real = join(dir, "token"), other = join(dir, "other");
    writeFileSync(real, "jwt-a"); writeFileSync(other, "jwt-a");
    symlinkSync(real, join(dir, "symlink"));
    linkSync(real, join(dir, "hardlink"));
    symlinkSync(dir, join(dir, "dirlink"));
    const pair = (a: string, b: string) => collapsedWith({ ALZ_APPLY_ARM_OIDC_TOKEN_FILE: a, ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE: b });
    assert.equal(pair(real, join(dir, "symlink")), "IDENTITY_COLLAPSED", "symlink to the same file");
    assert.equal(pair(real, join(dir, "hardlink")), "IDENTITY_COLLAPSED", "hard link to the same inode");
    assert.equal(pair(join(dir, "dirlink", "token"), real), "IDENTITY_COLLAPSED", "through a symlinked directory");
    assert.equal(pair(real, other), "ok", "a different file with the same content is a different file");
    // A configuration directory is a path too, and the operator's own AZURE_CONFIG_DIR is compared the same way.
    assert.equal(collapsedWith({ ALZ_APPLY_AZURE_CONFIG_DIR: dir, ALZ_STATE_WRITE_AZURE_CONFIG_DIR: join(dir, "dirlink") }), "IDENTITY_COLLAPSED" /* fallback variables are refused too */);
    const ambient = checkApplyIdentities({ ...fixture(), AZURE_CLIENT_ID: GUID_A, ALZ_APPLY_ARM_CLIENT_ID: GUID_A.toLowerCase() }, AZURE);
    assert.equal(ambient.ok === false && ambient.code, "IDENTITY_COLLAPSED", "operator AZURE_CLIENT_ID in another case");
    const ambientFile = checkApplyIdentities({ ...fixture(), ARM_OIDC_TOKEN_FILE: join(dir, "symlink"), ALZ_APPLY_ARM_OIDC_TOKEN_FILE: real }, AZURE);
    assert.equal(ambientFile.ok === false && ambientFile.code, "IDENTITY_COLLAPSED", "operator token file through a symlink");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("messages never contain a value", () => {
  const env = fixture();
  env.ALZ_APPLY_ARM_CLIENT_SECRET = env.ALZ_STATE_WRITE_ARM_CLIENT_SECRET = "very-secret-value-xyz";
  const text = JSON.stringify(checkApplyIdentities(env, AZURE));
  for (const value of [TENANT, SUBSCRIPTION, "very-secret-value-xyz", "/run/fixtures"]) assert.equal(text.includes(value), false, value);
});

test("Azure variables map through ALZ_<IDENTITY>_ for each of the four identities, and only for that identity", () => {
  const env = fixture();
  for (const [index, identity] of APPLY_IDENTITIES.entries()) {
    const child = childFor(env, identity);
    assert.equal(child.env.ARM_CLIENT_ID, `10000000-0000-4000-8000-00000000000${index}`, identity);
    assert.equal(child.env.ARM_TENANT_ID, TENANT);
    assert.equal(child.env.ARM_SUBSCRIPTION_ID, SUBSCRIPTION);
    assert.equal(child.env.ARM_USE_OIDC, "true");
    assert.equal(child.env.ARM_OIDC_TOKEN_FILE, `/run/fixtures/${identity.toLowerCase()}.jwt`, identity);
    assert.deepEqual(child.refused, [], identity + " receives nothing refused, nothing from a sibling identity");
    assert.equal(Object.keys(child.env).filter((k) => k.startsWith("ALZ_")).length, 0);
  }
});

test("STATE does not receive STATE_WRITE variables, in either direction", () => {
  const env = { ALZ_STATE_WRITE_ARM_CLIENT_ID: "writer", ALZ_STATE_ARM_CLIENT_ID: "reader" };
  const state = childFor(env, "STATE");
  assert.equal(state.env.ARM_CLIENT_ID, "reader");
  assert.deepEqual(state.refused, [], "the writer's variables are not even candidates");
  assert.equal(childFor({ ALZ_STATE_ARM_CLIENT_ID: "reader" }, "STATE_WRITE").env.ARM_CLIENT_ID, undefined);
  assert.equal(childFor(env, "STATE_WRITE").env.ARM_CLIENT_ID, "writer");
});

test("discovery, state-read and destroy-preview children never see STATE_WRITE or APPLY variables", () => {
  const env = fixture();
  env.ALZ_STATE_WRITE_ARM_CLIENT_SECRET = "writer-secret-0001";
  env.ALZ_APPLY_ARM_CLIENT_SECRET = "apply-secret-00001";
  env.ALZ_APPLY_TF_VAR_x = "apply-only";
  for (const identity of ["DISCOVERY", "STATE"] as const) {
    for (const profile of [PROFILES.terraform, PROFILES.tofu, PROFILES.az]) {
      const child = childFor(env, identity, profile);
      const values = Object.values(child.env).join("\n");
      assert.equal(values.includes("writer-secret-0001"), false);
      assert.equal(values.includes("apply-secret-00001"), false);
      assert.equal(values.includes("apply-only"), false);
      assert.equal(values.includes(env.ALZ_APPLY_ARM_CLIENT_ID as string), false, identity);
      assert.equal(values.includes(env.ALZ_STATE_WRITE_ARM_CLIENT_ID as string), false, identity);
      assert.equal(child.secretValues.includes("writer-secret-0001"), false);
    }
  }
  // The default identity is DISCOVERY, so a run that names none sees none of them either.
  const unnamed = buildChildEnvironment({ profile: PROFILES.terraform, base: env, toolDirs: [], home: "/h", tmp: "/t" });
  assert.equal(Object.values(unnamed.env).includes(env.ALZ_APPLY_ARM_CLIENT_ID as string), false);
});

test("no identity inherits the operator's own credentials, and APPLY never falls back to STATE or the reverse", () => {
  const env: NodeJS.ProcessEnv = {
    ARM_CLIENT_ID: "operator-client", AZURE_CLIENT_SECRET: "operator-secret-0001", ARM_OIDC_TOKEN_FILE: "/home/op/token",
    ALZ_STATE_ARM_CLIENT_ID: "state-only",
  };
  for (const identity of ["APPLY", "STATE_WRITE"]) {
    const child = childFor(env, identity);
    assert.equal(child.env.ARM_CLIENT_ID, undefined, identity);
    assert.equal(child.env.AZURE_CLIENT_SECRET, undefined, identity);
    assert.equal(child.env.ARM_OIDC_TOKEN_FILE, undefined, identity);
  }
});

// --- identities must point at the contract's tenant and subscription ---------------------------------------------

const OTHER = "00000000-0000-4000-8000-0000000000ff";
const contract = {
  targets: {
    DEV: { tenantId: TENANT, subscriptionId: SUBSCRIPTION, backend: "x/y/z", workspace: "default" },
    QA: { tenantId: "00000000-0000-4000-8000-000000000005", subscriptionId: "00000000-0000-4000-8000-000000000006", backend: "x/y/q", workspace: "default" },
    PROD: { tenantId: "00000000-0000-4000-8000-000000000003", subscriptionId: "00000000-0000-4000-8000-000000000004", backend: "x/y/p", workspace: "default" },
  },
} as unknown as PilotContract;

test("identity targets: matching tenant and subscription pass", () => {
  assert.deepEqual(verifyIdentityTargets(contract, "DEV", fixture(), AZURE), { ok: true });
  const prod = fixture();
  for (const identity of APPLY_IDENTITIES) {
    prod[`ALZ_${identity}_ARM_TENANT_ID`] = contract.targets.PROD.tenantId.toUpperCase();
    prod[`ALZ_${identity}_ARM_SUBSCRIPTION_ID`] = contract.targets.PROD.subscriptionId;
  }
  assert.deepEqual(verifyIdentityTargets(contract, "PROD", prod, AZURE), { ok: true }, "case does not matter");
  const qa = fixture();
  for (const identity of APPLY_IDENTITIES) {
    qa[`ALZ_${identity}_ARM_TENANT_ID`] = contract.targets.QA.tenantId;
    qa[`ALZ_${identity}_ARM_SUBSCRIPTION_ID`] = contract.targets.QA.subscriptionId.toUpperCase();
  }
  assert.deepEqual(verifyIdentityTargets(contract, "QA", qa, AZURE), { ok: true });
  // Each environment's credentials apply only there.
  for (const [good, other] of [["QA", "DEV"], ["QA", "PROD"], ["DEV", "QA"], ["PROD", "QA"]] as const) {
    const env = good === "QA" ? qa : good === "PROD" ? prod : fixture();
    assert.equal(verifyIdentityTargets(contract, other, env, AZURE).ok, false, good + " credentials for " + other);
  }
});

test("identity targets: any identity pointing elsewhere is IDENTITY_TARGET_MISMATCH, naming variables and never values", () => {
  for (const identity of APPLY_IDENTITIES) {
    for (const variable of ["TENANT_ID", "SUBSCRIPTION_ID"]) {
      const env = fixture();
      env[`ALZ_${identity}_ARM_${variable}`] = OTHER;
      const outcome = verifyIdentityTargets(contract, "DEV", env, AZURE);
      assert.equal(outcome.ok, false, identity + variable);
      if (outcome.ok) continue;
      assert.equal(outcome.code, "IDENTITY_TARGET_MISMATCH");
      assert.ok(outcome.message.includes(`ALZ_${identity}_ARM_${variable}`), outcome.message);
      assert.equal(outcome.message.includes(OTHER) || outcome.message.includes(TENANT) || outcome.message.includes(SUBSCRIPTION), false, "no values");
    }
  }
  // DEV credentials presented for PROD (the same fixture) are a mismatch.
  assert.equal(verifyIdentityTargets(contract, "PROD", fixture(), AZURE).ok, false);
});

test("identity targets: APPLY and STATE_WRITE must set both; the read identities may leave them unset", () => {
  for (const identity of ["APPLY", "STATE_WRITE"] as const) {
    for (const variable of ["TENANT_ID", "SUBSCRIPTION_ID"]) {
      for (const blank of [undefined, ""]) {
        const env = fixture();
        if (blank === undefined) delete env[`ALZ_${identity}_ARM_${variable}`]; else env[`ALZ_${identity}_ARM_${variable}`] = blank;
        const outcome = verifyIdentityTargets(contract, "DEV", env, AZURE);
        assert.equal(outcome.ok, false, identity + variable);
        if (!outcome.ok) assert.ok(outcome.code === "IDENTITY_TARGET_MISMATCH" && outcome.message.includes(`ALZ_${identity}_ARM_${variable}`));
      }
    }
  }
  for (const identity of ["DISCOVERY", "STATE"] as const) {
    const env = fixture();
    delete env[`ALZ_${identity}_ARM_TENANT_ID`];
    delete env[`ALZ_${identity}_ARM_SUBSCRIPTION_ID`];
    assert.deepEqual(verifyIdentityTargets(contract, "DEV", env, AZURE), { ok: true }, identity);
  }
  assert.equal(verifyIdentityTargets(contract, "QA" as never, fixture(), AZURE).ok, false, "an environment the contract lacks");
});

// --- separation and inheritance: no shared principal, no fallback, never the operator's own ------------------

const refusedWith = (env: NodeJS.ProcessEnv, code: string, ...mentions: string[]): string => {
  const outcome = checkApplyIdentities(env, AZURE);
  assert.equal(outcome.ok, false, mentions.join());
  if (outcome.ok) return "";
  assert.equal(outcome.code, code, mentions.join());
  for (const name of mentions) assert.match(outcome.message, new RegExp(name), name);
  return outcome.message;
};

test("a principal value shared under different variable names is a collapse, naming variables only", () => {
  const env = fixture();
  env.ALZ_STATE_WRITE_ARM_CLIENT_ID = "shared-principal-0001";
  env.ALZ_APPLY_ARM_OIDC_AUDIENCE_CLIENT_ID = "shared-principal-0001";
  const message = refusedWith(env, "IDENTITY_COLLAPSED", "ARM_CLIENT_ID", "ARM_OIDC_AUDIENCE_CLIENT_ID");
  assert.equal(message.includes("shared-principal-0001"), false);
  const azure = fixture();
  azure.ALZ_APPLY_AZURE_CLIENT_ID = azure.ALZ_STATE_ARM_CLIENT_ID;
  refusedWith(azure, "IDENTITY_COLLAPSED", "AZURE_CLIENT_ID", "ARM_CLIENT_ID");
});

test("all four identities pointing at one Azure CLI configuration directory is refused, whatever the directory", () => {
  const env = fixture();
  for (const identity of APPLY_IDENTITIES) env[`ALZ_${identity}_AZURE_CONFIG_DIR`] = "/home/operator/.azure";
  const message = refusedWith(env, "IDENTITY_COLLAPSED", "AZURE_CONFIG_DIR");
  assert.equal(message.includes("/home/operator"), false);
});

test("any variable that lets a child fall back to the az CLI, managed identity or ambient credentials is refused, per identity", () => {
  for (const identity of APPLY_IDENTITIES) {
    for (const [name, value] of [
      ["AZURE_CONFIG_DIR", "/elsewhere/.azure"], ["ARM_USE_CLI", "true"], ["ARM_USE_MSI", "true"], ["ARM_USE_AKS_WORKLOAD_IDENTITY", "true"],
      ["ARM_MSI_ENDPOINT", "http://169.254.169.254"], ["AZURE_CLIENT_ID", "other-0001"], ["ARM_CLIENT_CERTIFICATE_PATH", "/x.pfx"],
    ] as const) {
      const env = fixture();
      env[`ALZ_${identity}_${name}`] = value;
      const message = refusedWith(env, "IDENTITY_NOT_CONFIGURED", `ALZ_${identity}_${name}`);
      assert.equal(message.includes(value), false, name);
    }
  }
  // ARM_USE_OIDC and the token file are the allowed way in.
  assert.deepEqual(checkApplyIdentities(fixture(), AZURE), { ok: true });
});

test("an identity value equal to the operator's ambient AZURE_* or ARM_* variable is refused, never echoed", () => {
  for (const ambient of ["ARM_CLIENT_ID", "AZURE_CLIENT_ID", "ARM_CLIENT_SECRET", "AZURE_CLIENT_SECRET", "ARM_OIDC_TOKEN_FILE"]) {
    for (const identity of APPLY_IDENTITIES) {
      const env = fixture();
      env[ambient] = env[`ALZ_${identity}_ARM_CLIENT_ID`];
      const message = refusedWith(env, "IDENTITY_COLLAPSED", `ALZ_${identity}_ARM_CLIENT_ID`, ambient);
      assert.equal(message.includes(env[ambient] as string), false, ambient);
    }
  }
  // The tenant and subscription are shared with the operator on purpose; an ambient value that differs is not a clash.
  const shared = fixture();
  shared.ARM_TENANT_ID = TENANT;
  shared.ARM_SUBSCRIPTION_ID = SUBSCRIPTION;
  shared.ARM_CLIENT_ID = "operator-own-client";
  assert.deepEqual(checkApplyIdentities(shared, AZURE), { ok: true });
});
