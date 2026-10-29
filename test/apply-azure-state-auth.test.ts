import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { TERRAFORM as TERRAFORM_ENGINE } from "../src/apply/engines/terraform.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { sealPlan } from "../src/apply/seal.js";
import { pilotUnitOf } from "../src/apply/unit.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { buildChildEnvironment } from "../src/tools/child-env.js";
import { EXECUTION_IDENTITIES } from "../src/tools/identity.js";
import { createPrivateDirectory } from "../src/tools/private-workdir.js";
import { PROFILES, TERRAFORM_APPLY_PROFILE } from "../src/tools/profiles.js";
import {
  DEV_TARGET, ENGINE_VERSION, H, NOW, POLICY, REQUESTER, SOURCE_COMMIT, TENANT, behave, callsOf, identityEnv, installFakeTerraform, writeProject,
  AZURE_LOCATION_FIXTURE,
} from "./helpers/apply-fixtures.js";

/**
 * Azure Terraform state access is Entra ID only (owner decision of 2026-10-27, issue #39; docs/act-pilot-apply.md, Azure). The
 * product's backend file turns `use_azuread_auth` on for every init, init saves it, and the sealed plan embeds it. A shared key, a
 * SAS token, a resource group lookup or another endpoint is refused on every product path: in the backend file the product writes,
 * in the backend init saved (which the plan embeds and the apply uses), and in the environment a Terraform child receives.
 * Default CI, fake engine. The real engine's behavior is in the opt-in test/apply-emulated.test.ts (SYNTHETIC/EMULATED).
 */

const PINNED = { tenantId: TENANT, subscriptionId: DEV_TARGET.account, backend: DEV_TARGET.backend, workspace: "default", location: AZURE_LOCATION_FIXTURE, canary: { resources: [{ type: "azurerm_resource_group", count: 1 }] } };
/** The environment init's backend configuration was written from: STATE_WRITE is `statewrite-client-3` with `/run/fixture/statewrite-oidc-token`. */
const WRITER_ENV = identityEnv("DEV");
const [ACCOUNT, CONTAINER, ...KEY] = DEV_TARGET.backend.split("/");
/** A fake SAS token and a fake shared key: shaped like the real ones, valid nowhere. */
const SAS = "sv=2023-11-03&sp=racwdl&sr=c&sig=ZmFrZS1ub3QtYS1zaWduYXR1cmU%3D";
const SHARED_KEY = Buffer.from("fake-shared-key-not-a-real-one-0000000000000000").toString("base64");

/** What init saves from the product's own backend file (the opt-in emulated test checks this against real Terraform 1.16.4). */
const SAVED = (extra: Record<string, unknown> = {}) => ({
  type: "azurerm",
  config: {
    storage_account_name: ACCOUNT, container_name: CONTAINER, key: KEY.join("/"), use_azuread_auth: true,
    use_oidc: null, client_id: null, tenant_id: null, subscription_id: null, oidc_token_file_path: null,
    access_key: null, sas_token: null, resource_group_name: null, lookup_blob_endpoint: null, endpoint: null, metadata_host: null,
    environment: null, snapshot: null, use_msi: null, use_cli: null, msi_endpoint: null, client_secret: null,
    ...extra,
  },
});

/** Every attribute that names another way to authenticate or reach storage. None may carry a value in what init saved. */
const OTHER_PATHS: Record<string, unknown> = {
  access_key: SHARED_KEY, sas_token: SAS, resource_group_name: "rg-pilot-state", lookup_blob_endpoint: true, endpoint: "https://elsewhere.example",
  metadata_host: "metadata.example", environment: "usgovernment", client_secret: "a-secret", client_certificate_path: "/x.pfx",
  client_certificate_password: "pw", use_msi: true, msi_endpoint: "http://169.254.169.254", use_cli: true, use_aks_workload_identity: true,
  use_dns_zone_endpoint: true, snapshot: true, a_future_attribute: "x",
};

describe("Azure state auth is Entra ID only: the product's backend file", () => {
  const files = () => [AZURE.backendLocation(PINNED), AZURE.backendConfig(identityEnv("DEV"), PINNED)];

  it("turns use_azuread_auth on for every init: the seal's location file and the STATE_WRITE configuration both carry it once", () => {
    for (const text of files()) assert.equal(text.split("\n").filter((line) => line === "use_azuread_auth = true").length, 1, text);
  });

  it("names no shared key, SAS token, resource group, lookup, endpoint or other credential path", () => {
    for (const text of files()) {
      const keys = text.split("\n").filter(Boolean).map((line) => line.split("=")[0].trim());
      assert.deepEqual(keys.filter((key) => key in OTHER_PATHS), [], text);
      for (const key of keys) {
        assert.ok(["storage_account_name", "container_name", "key", "use_azuread_auth", "use_oidc", "client_id", "tenant_id", "subscription_id", "oidc_token_file_path"].includes(key), key);
      }
    }
  });

  it("never copies an identity's shared key, SAS token or auth switch into the file, whatever the variables say", () => {
    const env = {
      ...identityEnv("DEV"), ALZ_STATE_WRITE_ARM_ACCESS_KEY: SHARED_KEY, ALZ_STATE_WRITE_ARM_SAS_TOKEN: SAS, ALZ_STATE_WRITE_ARM_USE_AZUREAD: "false",
      ALZ_STATE_WRITE_ARM_STORAGE_USE_AZUREAD: "false", ARM_ACCESS_KEY: SHARED_KEY, ARM_SAS_TOKEN: SAS,
    };
    const text = AZURE.backendConfig(env, PINNED);
    for (const marker of [SHARED_KEY, "sig=", "false"]) assert.ok(!text.includes(marker), marker.slice(0, 8));
  });
});

describe("Azure state auth is Entra ID only: the backend init saved (the plan embeds it and the apply uses it)", () => {
  it("accepts exactly what init saves from the product's file, with or without the STATE_WRITE settings", () => {
    assert.equal(AZURE.savedBackendMatches(SAVED(), PINNED, WRITER_ENV), true);
    assert.equal(AZURE.savedBackendMatches(SAVED({ use_oidc: true, client_id: "statewrite-client-3", tenant_id: TENANT, subscription_id: DEV_TARGET.account, oidc_token_file_path: "/run/fixture/statewrite-oidc-token" }), PINNED, WRITER_ENV), true);
    const sparse = { type: "azurerm", config: { storage_account_name: ACCOUNT, container_name: CONTAINER, key: KEY.join("/"), use_azuread_auth: true } };
    assert.equal(AZURE.savedBackendMatches(sparse, PINNED, WRITER_ENV), true, "an attribute init did not save at all is the same as null");
  });

  it("refuses a backend without Entra ID authorization on: missing, null, false, or a string", () => {
    for (const value of [undefined, null, false, "true", 1]) {
      const saved = SAVED({ use_azuread_auth: value });
      if (value === undefined) delete (saved.config as Record<string, unknown>).use_azuread_auth;
      assert.equal(AZURE.savedBackendMatches(saved, PINNED, WRITER_ENV), false, String(value));
    }
    assert.equal(AZURE.savedBackendMatches(SAVED({ use_oidc: false }), PINNED, WRITER_ENV), false, "use_oidc may only be on");
  });

  it("refuses a shared key, a SAS token, a resource group, a lookup, another endpoint or cloud, another credential, or an unknown attribute", () => {
    for (const [name, value] of Object.entries(OTHER_PATHS)) {
      assert.equal(AZURE.savedBackendMatches(SAVED({ [name]: value }), PINNED, WRITER_ENV), false, name);
      // Even a falsy value that is not null is a setting someone made.
      assert.equal(AZURE.savedBackendMatches(SAVED({ [name]: typeof value === "boolean" ? false : "" }), PINNED, WRITER_ENV), false, name + " (falsy)");
    }
  });

  it("binds the contract's storage account, container and key one by one, with Entra ID on (so only the location differs)", () => {
    for (const [label, change] of [
      ["storage account", { storage_account_name: "attackerstore" }], ["container", { container_name: "other" }], ["key", { key: "prod.tfstate" }],
      ["key prefix", { key: KEY.join("/") + "x" }], ["deeper key", { key: "a/" + KEY.join("/") }], ["account case", { storage_account_name: ACCOUNT.toUpperCase() }],
    ] as const) {
      assert.equal(AZURE.savedBackendMatches(SAVED(change), PINNED, WRITER_ENV), false, label);
    }
  });

  it("binds the saved STATE_WRITE tenant and subscription to the contract's, and the client id and token path to their strict shapes", () => {
    const writer = { use_oidc: true, client_id: "statewrite-client-3", tenant_id: TENANT, subscription_id: DEV_TARGET.account, oidc_token_file_path: "/run/fixture/statewrite-oidc-token" };
    assert.equal(AZURE.savedBackendMatches(SAVED(writer), PINNED, WRITER_ENV), true, "control");
    assert.equal(AZURE.savedBackendMatches(SAVED({ ...writer, tenant_id: TENANT.toUpperCase(), subscription_id: DEV_TARGET.account.toUpperCase() }), PINNED, WRITER_ENV), true, "GUIDs compare case-insensitively");
    const other = "99999999-9999-4999-8999-999999999999";
    for (const [label, change] of [
      ["another tenant", { tenant_id: other }], ["another subscription", { subscription_id: other }], ["a tenant name", { tenant_id: "contoso.onmicrosoft.com" }],
      ["a numeric subscription", { subscription_id: 7 }], ["a quoted client id", { client_id: 'x" y' }], ["an empty client id", { client_id: "" }],
      ["a relative token path", { oidc_token_file_path: "token" }], ["a token path with a newline", { oidc_token_file_path: "/run/t\nx" }],
    ] as const) {
      assert.equal(AZURE.savedBackendMatches(SAVED({ ...writer, ...change }), PINNED, WRITER_ENV), false, label);
    }
  });

  it("binds the saved client id and token path to the STATE_WRITE identity's own values, not merely their shapes (review N3 of #318)", () => {
    const writer = { use_oidc: true, client_id: "statewrite-client-3", tenant_id: TENANT, subscription_id: DEV_TARGET.account, oidc_token_file_path: "/run/fixture/statewrite-oidc-token" };
    assert.equal(AZURE.savedBackendMatches(SAVED(writer), PINNED, WRITER_ENV), true, "control");
    for (const [label, change] of [
      ["the APPLY client id", { client_id: "apply-client-4" }], ["the STATE client id", { client_id: "state-client-2" }], ["a client id of no identity", { client_id: "someone-else-9" }],
      ["a client id in another case", { client_id: "STATEWRITE-CLIENT-3" }], ["another token path", { oidc_token_file_path: "/run/fixture/apply-oidc-token" }],
      ["a token path prefix", { oidc_token_file_path: "/run/fixture/statewrite-oidc-token/x" }],
    ] as const) {
      assert.equal(AZURE.savedBackendMatches(SAVED({ ...writer, ...change }), PINNED, WRITER_ENV), false, label);
    }
    // A saved value with no STATE_WRITE value to match: refused, whatever its shape.
    const noWriter = { ...WRITER_ENV };
    delete noWriter.ALZ_STATE_WRITE_ARM_CLIENT_ID;
    delete noWriter.ALZ_STATE_WRITE_ARM_OIDC_TOKEN_FILE;
    assert.equal(AZURE.savedBackendMatches(SAVED({ client_id: "statewrite-client-3" }), PINNED, noWriter), false, "client id, no STATE_WRITE client id");
    assert.equal(AZURE.savedBackendMatches(SAVED({ oidc_token_file_path: "/run/fixture/statewrite-oidc-token" }), PINNED, noWriter), false, "token path, no STATE_WRITE token path");
    assert.equal(AZURE.savedBackendMatches(SAVED(), PINNED, noWriter), true, "nothing saved, nothing to bind (the seal's location-only init)");
    // The operator's own variables are not the STATE_WRITE identity's.
    assert.equal(AZURE.savedBackendMatches(SAVED({ client_id: "operator-client" }), PINNED, { ...noWriter, ARM_CLIENT_ID: "operator-client" }), false, "the operator's client id");
  });

  it("compares the storage account, container and key each on its own, never joined (review N5 of #320)", () => {
    const deep = { ...PINNED, backend: ACCOUNT + "/" + CONTAINER + "/env/dev.tfstate" };
    const at = (account: string, container: string, key: string) => AZURE.savedBackendMatches(SAVED({ storage_account_name: account, container_name: container, key }), deep, WRITER_ENV);
    assert.equal(at(ACCOUNT, CONTAINER, "env/dev.tfstate"), true, "control");
    assert.equal(at(ACCOUNT, CONTAINER + "/env", "dev.tfstate"), false, "the slash moved into the container");
    assert.equal(at(ACCOUNT + "/" + CONTAINER, "env", "dev.tfstate"), false, "the slash moved into the account");
  });

  it("still binds the contract's location and the azurerm type", () => {
    assert.equal(AZURE.savedBackendMatches(SAVED({ storage_account_name: "attackerstore" }), PINNED, WRITER_ENV), false);
    assert.equal(AZURE.savedBackendMatches({ ...SAVED(), type: "s3" }, PINNED, WRITER_ENV), false);
    assert.equal(AZURE.savedBackendMatches({ type: "azurerm" }, PINNED, WRITER_ENV), false);
  });
});

describe("Azure state auth is Entra ID only: the environment a Terraform child receives", () => {
  const NAMES = ["ARM_ACCESS_KEY", "ARM_SAS_TOKEN", "ARM_USE_AZUREAD", "ARM_STORAGE_USE_AZUREAD"];

  it("no Terraform profile lets a child receive a shared key, a SAS token or an auth switch", () => {
    for (const profile of [PROFILES.terraform, PROFILES.tofu, TERRAFORM_APPLY_PROFILE]) {
      for (const name of NAMES) {
        assert.equal(profile.injectable.includes(name), false, name);
        assert.equal(profile.injectablePrefixes.some((prefix) => name.startsWith(prefix)), false, name);
      }
    }
  });

  it("an identity's or the operator's own shared key, SAS token or switch never reaches a child, and each identity variable is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "alz-azure-auth-env-"));
    try {
      const base: NodeJS.ProcessEnv = { ...identityEnv("DEV"), ARM_ACCESS_KEY: SHARED_KEY, ARM_SAS_TOKEN: SAS, ARM_USE_AZUREAD: "false" };
      for (const identity of EXECUTION_IDENTITIES) for (const name of NAMES) base["ALZ_" + identity + "_" + name] = name === "ARM_ACCESS_KEY" ? SHARED_KEY : name === "ARM_SAS_TOKEN" ? SAS : "false";
      for (const identity of EXECUTION_IDENTITIES) {
        const child = buildChildEnvironment({ profile: TERRAFORM_APPLY_PROFILE, base, toolDirs: [root], home: root, tmp: root, identity });
        for (const name of NAMES) {
          assert.equal(child.env[name], undefined, identity + " " + name);
          assert.ok(child.refused.includes("ALZ_" + identity + "_" + name), identity + " refuses ALZ_" + identity + "_" + name);
        }
        const text = JSON.stringify(child.env);
        for (const marker of [SHARED_KEY, "sig="]) assert.ok(!text.includes(marker), identity);
      }
    } finally { removeTree(root); }
  });

  it("the backend's own environment switch (ARM_USE_AZUREAD) on any identity is refused as a fallback before any child runs", () => {
    for (const identity of EXECUTION_IDENTITIES) {
      for (const value of ["true", "false"]) {
        const refusal = AZURE.ambientRefusal({ ...identityEnv("DEV"), ["ALZ_" + identity + "_ARM_USE_AZUREAD"]: value });
        assert.equal(refusal?.code, "IDENTITY_NOT_CONFIGURED", identity + " " + value);
        assert.match(refusal?.message ?? "", new RegExp("ALZ_" + identity + "_ARM_USE_AZUREAD"));
      }
    }
  });
});

describe("Azure state auth is Entra ID only: a seal through the fake engine", () => {
  const root = mkdtempSync(join(tmpdir(), "alz-azure-auth-seal-"));
  const previousCwd = process.cwd();
  const previousKey = process.env.AGENTIC_EVIDENCE_KEY;
  const KILL = join(root, "KILL");
  const toolDir = join(root, "fake-tools");
  let counter = 0;
  const fresh = (label: string): string => { const dir = join(root, label + "-" + ++counter); mkdirSync(dir, { recursive: true }); return dir; };
  const target = { ...DEV_TARGET };

  before(() => {
    process.env.AGENTIC_EVIDENCE_KEY = randomBytes(32).toString("base64");
    process.chdir(root); // the vault writes sealed plans under ./.runs
    mkdirSync(toolDir, { recursive: true });
    installFakeTerraform(toolDir);
  });
  after(() => {
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.AGENTIC_EVIDENCE_KEY; else process.env.AGENTIC_EVIDENCE_KEY = previousKey;
    removeTree(root);
  });

  async function seal(options: { savedBackend?: unknown; env?: NodeJS.ProcessEnv } = {}) {
    behave(toolDir, KILL, options.savedBackend === undefined ? {} : { savedBackend: options.savedBackend });
    const { projectRoot, manifest } = writeProject(fresh("project"), target);
    const parent = fresh("scratch");
    const snapshot = createImmutableSnapshot(projectRoot, manifest, parent);
    const scratch = createPrivateDirectory("alz-azure-auth-", parent);
    try {
      return await sealPlan({
        engine: TERRAFORM_ENGINE, environment: "DEV", target, manifest, snapshotPath: snapshot.path, scratchDir: scratch.path,
        env: options.env ?? identityEnv("DEV"), policyVersion: POLICY, engineVersion: ENGINE_VERSION, toolDirs: [toolDir],
        pinned: PINNED, spec: AZURE, contractSha256: H("9"), sourceCommit: SOURCE_COMMIT,
        provenance: { engineBinarySha256: H("e"), qualification: { state: "UNQUALIFIED", reason: "Fixture: no qualification evidence." } },
        requester: REQUESTER, now: () => NOW, unit: pilotUnitOf({ provider: "AZURE", contractSha256: H("9"), environment: "DEV", target }),
        // Every Terraform contract binds STATE_WRITE (owner decision 6486426552).
        embedStateWrite: true,
      });
    } finally { snapshot.remove(); scratch.remove(); }
  }

  it("control: init reads the product's Entra-only file, saves the switch, and the seal plans", async () => {
    const result = await seal();
    assert.ok(result.ok, JSON.stringify(result));
    const init = callsOf(toolDir).find((c) => c.args[0] === "init");
    assert.match(init?.backendConfig ?? "", /^use_azuread_auth = true$/m);
    assert.ok(callsOf(toolDir).some((c) => c.args[0] === "plan"));
  });

  it("refuses, before any plan, a saved backend that holds a SAS token, a shared key, a resource group or no Entra ID switch", async () => {
    for (const [label, savedBackend] of [
      ["sas_token", SAVED({ sas_token: SAS })], ["access_key", SAVED({ access_key: SHARED_KEY })],
      ["resource_group_name", SAVED({ resource_group_name: "rg-pilot-state" })], ["use_azuread_auth null", SAVED({ use_azuread_auth: null })],
    ] as const) {
      const result = await seal({ savedBackend });
      assert.equal(result.ok, false, label);
      assert.match(JSON.stringify(result), /BACKEND_NOT_IN_CONTRACT/, label);
      assert.equal(callsOf(toolDir).some((c) => c.args[0] === "plan"), false, label + ": nothing was planned");
      for (const marker of [SHARED_KEY, "sig="]) assert.ok(!JSON.stringify(result).includes(marker), label);
    }
  });

  it("refuses a seal whose identities carry a shared key, a SAS token or the auth switch, before the engine uses them", async () => {
    for (const [name, value] of [["ARM_ACCESS_KEY", SHARED_KEY], ["ARM_SAS_TOKEN", SAS], ["ARM_USE_AZUREAD", "false"]] as const) {
      const result = await seal({ env: { ...identityEnv("DEV"), ["ALZ_STATE_" + name]: value } });
      assert.equal(result.ok, false, name);
      assert.match(JSON.stringify(result), /ENVIRONMENT_REFUSED|IDENTITY_NOT_CONFIGURED/, name);
      for (const call of callsOf(toolDir)) assert.equal(call.env[name], undefined, call.args[0] + " " + name);
    }
  });
});
