import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pilotTargetSha256 } from "../src/apply/contract.js";
import { codeOf } from "../src/apply/engine.js";
import { openReader } from "../src/apply/observe.js";
import type { ProviderUse } from "../src/apply/provider.js";
import { AZURE, AZURE_LOCATED_TYPES } from "../src/apply/providers/azure.js";
import { planJudgeRefusal } from "../src/apply/terraform-constructs.js";
import type { PilotContract, PilotTarget } from "../src/apply/types.js";
import { AZURE_LOCATION, normalizeAzureLocation } from "../src/observe/arm-id.js";
import { ARM_LOCATED_TYPES, createDiscoveryArmReader } from "../src/observe/azure-rest.js";
import { observeBlueprint } from "../src/observe/verify.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { ARM_FEDERATED_TOKEN_CANARY, AZURE_LOCATION_FIXTURE, approvers, contractJson, fakeArmHttp } from "./helpers/apply-fixtures.js";
import { TARGET as BICEP_TARGET, VNET_ID as BICEP_VNET } from "./helpers/bicep-fixtures.js";

// The Azure location binding (owner decision of 2026-10-28, "Azure Terraform location"). SYNTHETIC: the judge, the target hash and
// the reader are exercised in process with fixture values and a scripted ARM client. Nothing here reaches Azure.

const root = mkdtempSync(join(tmpdir(), "alz-azure-location-"));
test.after(() => removeTree(root));

const TENANT = "11111111-1111-4111-8111-111111111111";
const SUB = "22222222-2222-4222-8222-222222222222";
const AZURERM = { name: "azurerm", full_name: "registry.terraform.io/hashicorp/azurerm" };
const pinned = (over: Record<string, unknown> = {}): PilotTarget =>
  ({ tenantId: TENANT, subscriptionId: SUB, backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default", location: "eastus2", ...over }) as never;
/** A change's planned use, as the Terraform walker reads `resource_changes[].change` (`after`, `after_unknown`). */
const change = (type: string, values: Record<string, unknown>, unknown: Record<string, unknown> = {}): ProviderUse =>
  ({ address: type + ".pilot", mode: "managed", type, provider: { full_name: AZURERM.full_name }, values, unknown });
/** A use from `planned_values` (values only). */
const planned = (type: string, values: Record<string, unknown>): ProviderUse => ({ address: type + ".pilot", mode: "managed", type, provider: { full_name: AZURERM.full_name }, values });
const judge = (uses: ProviderUse[], target: PilotTarget = pinned()): string => {
  try { AZURE.assertPlannedLocations!(uses, target); return "OK"; } catch (error) { return codeOf(error); }
};

test("Azure locations normalize one way: a display name, any letter case or spacing is ARM's programmatic name; anything else is no location", () => {
  for (const [written, name] of [["eastus2", "eastus2"], ["East US 2", "eastus2"], ["EASTUS2", "eastus2"], ["  west\tEurope ", "westeurope"], ["eastUS", "eastus"]] as const) {
    assert.equal(normalizeAzureLocation(written), name, written);
  }
  for (const bad of ["", "   ", "east-us", "eastus_2", "2eastus", "e", null, undefined, 42, {}, ["eastus"]]) assert.equal(normalizeAzureLocation(bad), undefined, String(bad));
  // The contract writes the programmatic name only, so one target has one hash.
  assert.ok(AZURE_LOCATION.test("westeurope") && !AZURE_LOCATION.test("West Europe") && !AZURE_LOCATION.test("eastUS2"));
  assert.equal(AZURE.optionalTargetFields?.location?.("eastus2"), true);
  assert.equal(AZURE.optionalTargetFields?.location?.("East US 2"), false);
});

test("the Azure Terraform judge accepts a virtual network planned at the contract's location, however ARM spells it, in the changes and the planned values", () => {
  for (const location of ["eastus2", "East US 2", "EastUS2"]) {
    assert.equal(judge([change("azurerm_virtual_network", { location }), planned("azurerm_virtual_network", { location })]), "OK", location);
  }
  // A resource of another reviewed type that names no location is not judged; one that names the contract's is accepted.
  assert.equal(judge([change("terraform_data", {}), change("azurerm_resource_group", { location: "eastus2" })]), "OK");
  assert.deepEqual([...AZURE_LOCATED_TYPES], ["azurerm_virtual_network"]);
});

test("the Azure Terraform judge refuses a wrong, unknown, empty, missing or malformed planned location, and a target that names none (LOCATION_NOT_IN_CONTRACT)", () => {
  const vnet = (values: Record<string, unknown>, unknown: Record<string, unknown> = {}) => [change("azurerm_virtual_network", values, unknown)];
  for (const [label, uses] of [
    ["another region", vnet({ location: "westeurope" })],
    ["another region, display name", vnet({ location: "West Europe" })],
    ["unknown until apply", vnet({}, { location: true })],
    ["unknown until apply, beside a value", vnet({ location: "eastus2" }, { location: true })],
    ["empty", vnet({ location: "" })],
    ["blank", vnet({ location: "   " })],
    ["missing", vnet({ name: "vnet" })],
    ["null", vnet({ location: null })],
    ["not text", vnet({ location: 2 })],
    ["malformed", vnet({ location: "east-us-2" })],
    ["planned values in another region", [change("azurerm_virtual_network", { location: "eastus2" }), planned("azurerm_virtual_network", { location: "westus" })]],
    ["planned values without a location", [planned("azurerm_virtual_network", {})]],
    ["another type in another region", [change("azurerm_virtual_network", { location: "eastus2" }), change("azurerm_resource_group", { location: "westus" })]],
    ["another type, unknown", [change("azurerm_network_security_group", {}, { location: true })]],
    ["inside a module", [{ ...change("azurerm_virtual_network", { location: "westus" }), address: "module.net.azurerm_virtual_network.pilot" }]],
  ] as const) {
    assert.equal(judge([...uses]), "LOCATION_NOT_IN_CONTRACT", label);
  }
  const good = [change("azurerm_virtual_network", { location: "eastus2" })];
  for (const [label, target] of [
    ["no location in the target", pinned({ location: undefined })],
    ["an empty location in the target", pinned({ location: "" })],
    ["a display name in the target", pinned({ location: "East US 2" })],
  ] as const) {
    assert.equal(judge(good, target), "LOCATION_NOT_IN_CONTRACT", label);
  }
  // At apply the refusal is the contract's target, before any approval is consumed, and it says what to fix.
  const refusal = planJudgeRefusal("LOCATION_NOT_IN_CONTRACT");
  assert.equal(refusal?.refusal, "TARGET_NOT_IN_CONTRACT");
  assert.match(refusal!.message, /names no location, or the plan places a resource in another location/);
  assert.match(refusal!.message, /targets\.<ENV>\.location/);
});

test("nothing is inferred from a resource group: a data source's read location and a configured expression are never consulted, and a cleanup plan's prior state is not judged", () => {
  const groupData: ProviderUse = { address: "data.azurerm_resource_group.pilot", mode: "data", type: "azurerm_resource_group", provider: { full_name: AZURERM.full_name }, values: { location: "eastus2" } };
  // The group's metadata says the contract's region, but the network's own planned location is unknown: refused.
  assert.equal(judge([groupData, change("azurerm_virtual_network", {}, { location: true })]), "LOCATION_NOT_IN_CONTRACT");
  // The group is elsewhere, the network is where the contract says: accepted, because only the network's own value counts.
  assert.equal(judge([{ ...groupData, values: { location: "westus" } }, change("azurerm_virtual_network", { location: "eastus2" })]), "OK");
  // A configured use carries expressions only, and a managed use from the prior state carries no values: neither is a placement.
  const configured: ProviderUse = { address: "azurerm_virtual_network.pilot", mode: "managed", type: "azurerm_virtual_network", provider: AZURERM, expressions: { location: { references: ["data.azurerm_resource_group.pilot.location"] } } };
  const prior: ProviderUse = { address: "azurerm_virtual_network.pilot", mode: "managed", type: "azurerm_virtual_network", provider: { full_name: AZURERM.full_name } };
  assert.equal(judge([configured, prior, change("azurerm_virtual_network", { location: "eastus2" })]), "OK");
  // A use of a provider that reaches no cloud is not an Azure placement.
  assert.equal(judge([{ address: "random_id.x", mode: "managed", type: "random_id", provider: { full_name: "registry.terraform.io/hashicorp/random" }, values: { location: "nowhere" } }]), "OK");
});

// --- the target hash ----------------------------------------------------------------------------------------------------

/** Hashes computed on main at de73a60, before this change, for the same fixture targets: unchanged unless the location is stated. */
const BEFORE = {
  azureNoLocation: "9968536c736f99e8a2b6fb039a25918faf5452553dc38372345ca1b8cb465bab",
  bicep: "0c8f170cbce3f86df41ad073f2eaa21c0b63f82b21528eb0898ed5e445cad28f",
  gcp: "e12df69590deb92e0082211831b0c1b9e076c12019163a82ceff803d6e49e558",
};
const azureTf = (location?: string): PilotContract => ({
  provider: "AZURE", engine: "TERRAFORM",
  targets: { DEV: { tenantId: TENANT, subscriptionId: SUB, backend: "fixturedevstore/tfstate/dev.tfstate", workspace: "default", ...(location ? { location } : {}), canary: { resources: [{ type: "azurerm_virtual_network", count: 1 }] } } },
}) as never;

test("the authorized location joins the Azure Terraform target hash; an Azure target without one, Bicep and GCP hash exactly as before", () => {
  assert.equal(pilotTargetSha256(azureTf(), "DEV"), BEFORE.azureNoLocation, "a target that names no location hashes as it always did");
  const east = pilotTargetSha256(azureTf("eastus2"), "DEV");
  const west = pilotTargetSha256(azureTf("westeurope"), "DEV");
  assert.notEqual(east, BEFORE.azureNoLocation, "stating the location binds it");
  assert.notEqual(east, west, "another location is another target");
  assert.equal(east, "91b7a4238530549cc4ba343b680bbac395757e252ac12998ac4e1b9a43a9949a");
  // Bicep already bound `location` as an engine location field: the provider's optional field is the same key and value, so its hash is unchanged.
  const bicep = { provider: "AZURE", engine: "BICEP", targets: { DEV: { tenantId: TENANT, subscriptionId: SUB, backend: "alz-pilot-stack", workspace: "default", resourceGroup: "alz-pilot-dev", location: "eastus2", canary: { resources: [{ type: "Microsoft.Network/virtualNetworks", count: 1 }] } } } };
  assert.equal(pilotTargetSha256(bicep as never, "DEV"), BEFORE.bicep);
  const gcp = { provider: "GCP", engine: "TERRAFORM", targets: { DEV: { projectId: "alz-pilot-dev", region: "us-central1", backend: "alz-pilot-dev-state/pilot/dev", workspace: "default", parent: "folders/123456789012" } } };
  assert.equal(pilotTargetSha256(gcp as never, "DEV"), BEFORE.gcp);
});

// --- the independent observation -------------------------------------------------------------------------------------------

const VNET = "/subscriptions/" + SUB + "/resourceGroups/alz-pilot-dev/providers/Microsoft.Network/virtualNetworks/vnet-alz-pilot-dev";
const WORKSPACE = "/subscriptions/" + SUB + "/resourceGroups/alz-pilot-dev/providers/Microsoft.OperationalInsights/workspaces/law";
const tokenFile = join(root, "discovery.jwt");
writeFileSync(tokenFile, ARM_FEDERATED_TOKEN_CANARY);
const env = { ALZ_DISCOVERY_ARM_CLIENT_ID: "discovery-client-1", ALZ_DISCOVERY_ARM_TENANT_ID: TENANT, ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE: tokenFile };
const entry = (id: string, address: string) => ({ address, type: "azurerm_x", arn: null, id, origin: "IN_PLAN" as const });
async function observed(locations: Record<string, string | null>, bound: string | null = "eastus2") {
  const location = bound ?? undefined;
  const arm = fakeArmHttp({ existing: [VNET, WORKSPACE], tagged: [VNET], locations });
  const { reader, close } = createDiscoveryArmReader({ env, subscriptionId: SUB, location, http: arm.http });
  try {
    return await observeBlueprint({ entries: [entry(VNET, "azurerm_virtual_network.pilot"), entry(WORKSPACE, "azurerm_log_analytics_workspace.law")], missing: [] }, { unitId: "unit-1", reader });
  } finally { close(); }
}

test("observation verifies where each resource really is: the contract's location (as ARM spells it) is VERIFIED; another is misplaced and FAILED; a network that names none is not VERIFIED", async () => {
  const verified = await observed({ [VNET]: "East US 2", [WORKSPACE]: "eastus2" });
  assert.equal(verified.verdict, "VERIFIED", JSON.stringify(verified));
  assert.ok(verified.checks.every((c) => c.existence === "PRESENT" && c.misplaced === undefined));

  const misplaced = await observed({ [VNET]: "westeurope", [WORKSPACE]: "eastus2" });
  assert.equal(misplaced.verdict, "FAILED");
  assert.deepEqual(misplaced.checks.map((c) => [c.address, c.existence, c.misplaced]), [["azurerm_virtual_network.pilot", "PRESENT", true], ["azurerm_log_analytics_workspace.law", "PRESENT", undefined]]);
  // Any other resource found elsewhere fails the observation too.
  assert.equal((await observed({ [VNET]: "eastus2", [WORKSPACE]: "westus" })).verdict, "FAILED");

  // The canary's network always carries a location: an answer without one cannot show where it is (UNKNOWN, never VERIFIED).
  const unreadable = await observed({ [VNET]: null, [WORKSPACE]: "eastus2" });
  assert.equal(unreadable.verdict, "INCONCLUSIVE");
  assert.deepEqual(unreadable.checks[0], { address: "azurerm_virtual_network.pilot", type: "azurerm_x", identifier: VNET, existence: "UNKNOWN", reason: "LOCATION_UNREADABLE" });
  assert.ok(ARM_LOCATED_TYPES.has("microsoft.network/virtualnetworks"));
  // A type that may have no location (a role or policy object) is judged only when its answer names one.
  assert.equal((await observed({ [VNET]: "eastus2", [WORKSPACE]: null })).verdict, "VERIFIED");

  // Without a bound location the reader reports existence only, as before; a malformed one is refused before any request.
  assert.equal((await observed({ [VNET]: "westeurope" }, null)).verdict, "VERIFIED");
  for (const bad of ["East US 2", "", "eastUS2"]) assert.throws(() => createDiscoveryArmReader({ env, subscriptionId: SUB, location: bad, http: fakeArmHttp().http }), /ARM_LOCATION_INVALID/, bad);
});

test("observation and the leftover check refuse an Azure target that names no location: where its resources are could not be verified", () => {
  const withLocation = join(root, "located.json");
  writeFileSync(withLocation, JSON.stringify(contractJson(join(root, "KILL"))));
  const opened = openReader({ contractPath: withLocation, evidenceDir: root, env }, "DEV");
  assert.ok(opened.ok, JSON.stringify(opened));
  if (opened.ok) opened.close();
  const contract = contractJson(join(root, "KILL")) as { targets: Record<string, Record<string, unknown>> };
  for (const env of Object.keys(contract.targets)) delete contract.targets[env].location;
  const unlocated = join(root, "unlocated.json");
  writeFileSync(unlocated, JSON.stringify(contract));
  const refused = openReader({ contractPath: unlocated, evidenceDir: root, env }, "DEV");
  assert.equal(refused.ok, false);
  assert.equal((refused as { code: string }).code, "CONTRACT_INVALID");
  assert.match((refused as { message: string }).message, /names no location \(targets\.DEV\.location\)/);
  assert.equal(AZURE_LOCATION_FIXTURE, "westeurope");
});

test("Bicep keeps the equivalent observed check: its target's location reaches the reader, so a stack's network found elsewhere is misplaced and one at the location is PRESENT", async () => {
  const path = join(root, "bicep.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, enabled: true, provider: "AZURE", engine: "BICEP", enabledEnvironments: ["DEV"], targets: { DEV: BICEP_TARGET },
    requiredApprovals: { DEV: 1 }, maxApprovalAgeMinutes: 60, approvers, killSwitchPath: join(root, "KILL"), authorize: { DEV: ["APPLY", "CLEANUP"] },
  }));
  const bicepEnv = { ...env, ALZ_DISCOVERY_ARM_TENANT_ID: BICEP_TARGET.tenantId };
  for (const [where, misplaced] of [["eastus2", undefined], ["East US 2", undefined], ["westeurope", true]] as const) {
    const arm = fakeArmHttp({ existing: [BICEP_VNET], locations: { [BICEP_VNET]: where } });
    const opened = openReader({ contractPath: path, evidenceDir: root, env: bicepEnv, arm: arm.http }, "DEV");
    assert.ok(opened.ok, JSON.stringify(opened));
    if (!opened.ok) return;
    try {
      const check = await opened.reader.check({ address: BICEP_VNET, type: "Microsoft.Network/virtualNetworks", arn: null, id: BICEP_VNET, origin: "IN_PLAN" });
      assert.equal(check.existence, "PRESENT", where);
      assert.equal(check.misplaced, misplaced, where);
    } finally { opened.close(); }
  }
});
