import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { codeOf } from "../src/apply/engine.js";
import { ALLOWED_RESOURCE_TYPE, BICEP, BICEP_ENTRY, RESOURCE_GROUP_TEMPLATE_SCHEMA, checkTemplate, pinnedBicepVersion } from "../src/apply/engines/bicep.js";
import { AZURE } from "../src/apply/providers/azure.js";
import { removeTree } from "../src/teardown/driver/cleanup.js";
import { createImmutableSnapshot } from "../src/teardown/snapshot.js";
import { AZ_VERSION, CANARY, RESOLVED, RESOURCE_GROUP, SUBSCRIPTION_ID, TARGET, UNIT, behave, identityEnv, installFakes, writeBicepProject } from "./helpers/bicep-fixtures.js";

// The committed ACT-DEV-1 Azure Bicep canary (qualification/azure/act-dev1-bicep-canary). SYNTHETIC and offline: the committed
// compiled template is judged by the Bicep engine's own seal-time check (checkTemplate). The opt-in run recompiles main.bicep with
// the pinned bicep (ALZ_BICEP names the program; its version must be config/tool-pins.json `bicep`) and requires the committed bytes.

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIR = join(ROOT, "qualification", "azure", "act-dev1-bicep-canary");
const compiled = (): string => readFileSync(join(DIR, "main.json"), "utf8");
const refusal = (text: string): string => { try { checkTemplate(text); return "ACCEPTED"; } catch (error) { return codeOf(error); } };

test("the compiled canary passes the Bicep engine's seal-time template check", () => {
  assert.equal(BICEP_ENTRY, "main.bicep");
  assert.equal(refusal(compiled()), "ACCEPTED");
});

test("the compiled canary is exactly one empty virtual network with the AWS canaries' tag scheme", () => {
  const template = JSON.parse(compiled());
  assert.equal(template.$schema, RESOURCE_GROUP_TEMPLATE_SCHEMA);
  assert.deepEqual(Object.keys(template), ["$schema", "contentVersion", "metadata", "parameters", "resources"]);
  assert.equal(template.metadata._generator.name, "bicep");
  assert.match(template.metadata._generator.version, new RegExp("^" + pinnedBicepVersion().replace(/\./g, "\\.") + "\\.\\d+$"), "compiled by the pinned bicep");
  assert.equal(template.resources.length, 1);
  const [vnet] = template.resources;
  assert.deepEqual(Object.keys(vnet), ["type", "apiVersion", "name", "location", "tags", "properties"]);
  assert.equal(vnet.type, ALLOWED_RESOURCE_TYPE);
  assert.equal(vnet.apiVersion, "2024-05-01");
  assert.equal(vnet.name, "[parameters('name')]");
  assert.equal(vnet.location, "[parameters('location')]");
  assert.deepEqual(vnet.properties, { addressSpace: { addressPrefixes: ["10.250.0.0/24"] } });
  // The tags are literal strings, never an ARM expression (the engine refuses one, TEMPLATE_VALUE_NOT_LITERAL): the four tags of the
  // AWS canaries' scheme, then the three unit tags. Owner and unit tags are EXAMPLE values the operator replaces in main.bicep.
  assert.deepEqual(vnet.tags, {
    environment: "DEV", "managed-by": "sovereign-alz", purpose: "act-dev-1", owner: "REPLACE-WITH-APPROVED-OWNER",
    "alz-build": "REPLACE-WITH-PREPARE-OUTPUT", "alz-managed-by": "REPLACE-WITH-PREPARE-OUTPUT", "alz-unit": "REPLACE-WITH-PREPARE-OUTPUT",
  });
  // The engine passes no parameter values, so each parameter has a default. Name is an EXAMPLE value the operator replaces;
  // location follows the existing pilot resource group.
  assert.deepEqual(Object.keys(template.parameters), ["name", "location"]);
  for (const [name, parameter] of Object.entries<any>(template.parameters)) assert.ok(Object.hasOwn(parameter, "defaultValue"), name);
  assert.equal(template.parameters.location.defaultValue, "[resourceGroup().location]");
  assert.match(template.parameters.name.defaultValue, /^vnet-alz-act-dev-1-/);
});

test("the compiled canary is exactly the canary allowlist an Azure Bicep contract names: one Microsoft.Network/virtualNetworks", () => {
  const [vnet] = JSON.parse(compiled()).resources;
  assert.equal(BICEP.canaryTypeOk!(vnet.type), true);
  assert.deepEqual(CANARY.resources, [{ type: vnet.type, count: 1 }]);
});

test("tags written as an ARM expression (the canary's earlier union of parameters) are refused TEMPLATE_VALUE_NOT_LITERAL", () => {
  const template = JSON.parse(compiled());
  template.resources[0].tags = "[union(createObject('environment', 'DEV'), parameters('unitTags'))]";
  assert.equal(refusal(JSON.stringify(template)), "TEMPLATE_VALUE_NOT_LITERAL");
});

test("the same check refuses a subnet, a second resource or another type, so the acceptance above is not vacuous", () => {
  const template = JSON.parse(compiled());
  const withSubnet = structuredClone(template);
  withSubnet.resources[0].properties.subnets = [{ name: "s", properties: { addressPrefix: "10.250.0.0/26" } }];
  assert.equal(refusal(JSON.stringify(withSubnet)), "TEMPLATE_SHAPE_NOT_ALLOWED");
  const twice = structuredClone(template);
  twice.resources.push(structuredClone(template.resources[0]));
  assert.equal(refusal(JSON.stringify(twice)), "TEMPLATE_SHAPE_NOT_ALLOWED");
  const other = structuredClone(template);
  other.resources[0].type = "Microsoft.Network/publicIPAddresses";
  assert.equal(refusal(JSON.stringify(other)), "RESOURCE_TYPE_NOT_ALLOWED");
  const outputs = { ...template, outputs: { id: { type: "string", value: "x" } } };
  assert.equal(refusal(JSON.stringify(outputs)), "TEMPLATE_SHAPE_NOT_ALLOWED");
});

test("main.bicep declares the one resource and no module, existing resource, output or subnet", () => {
  // Declarations only: the comments and descriptions are prose.
  const source = readFileSync(join(DIR, BICEP_ENTRY), "utf8").split("\n").filter((line) => !/^\s*(?:\/\/|@description\()/.test(line)).join("\n");
  assert.equal(source.match(/^resource /gm)?.length, 1);
  assert.ok(source.includes("resource canary 'Microsoft.Network/virtualNetworks@2024-05-01' = {"));
  assert.doesNotMatch(source, /^(?:module|output|targetScope|import|extension) /m);
  assert.doesNotMatch(source, /'\s+existing\s*=|subnets|\blist[A-Za-z]*\(/);
});

/**
 * The compiled template with the operator's values put in: `name` and `location` the way ARM evaluates the parameters for the
 * what-if, and the owner and unit tags as the operator writes them, literally, into main.bicep (the committed tag keys, asserted
 * above). Everything else is the committed bytes' content.
 */
function evaluated(values: { name: string; location: string; owner: string; unitTags: Record<string, string> }): string {
  const template = JSON.parse(compiled());
  const [vnet] = template.resources;
  const committed = { ...vnet.tags };
  for (const key of ["alz-build", "alz-managed-by", "alz-unit"]) delete committed[key];
  template.resources[0] = { ...vnet, name: values.name, location: values.location, tags: { ...committed, owner: values.owner, ...values.unitTags } };
  return JSON.stringify(template, null, 2) + "\n";
}

/** Seals `template` through the Bicep engine's own plan step with the FAKE `az` and `bicep` of the Bicep unit tests (identity compiler). */
function sealThroughEngine(template: string) {
  const root = mkdtempSync(join(tmpdir(), "alz-bicep-canary-"));
  try {
    const dir = (name: string): string => { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; };
    const toolDir = dir("bin");
    installFakes(toolDir);
    behave(toolDir, pinnedBicepVersion(), { killPath: join(root, "KILL") });
    const project = writeBicepProject(dir("project"), template);
    const snapshot = createImmutableSnapshot(project.projectRoot, project.manifest, dir("snapshot"));
    try {
      return BICEP.plan({
        scratchDir: dir("scratch"), env: identityEnv(dir("tokens")), toolDirs: [toolDir], manifest: project.manifest, pinned: TARGET, spec: AZURE,
        target: RESOLVED, engineVersion: AZ_VERSION, snapshotPath: snapshot.path, unit: UNIT,
      });
    } finally {
      snapshot.remove();
    }
  } finally {
    removeTree(root);
  }
}

test("with prepare's unit tags written in, the seal-time unit check and the canary allowlist pass: exactly one create, unit sealed, nothing untagged", () => {
  const name = "vnet-alz-act-dev-1-canary-01";
  const sealed = sealThroughEngine(evaluated({ name, location: "eastus2", owner: "qa", unitTags: { ...UNIT.tags } }));
  const id = "/subscriptions/" + SUBSCRIPTION_ID + "/resourceGroups/" + RESOURCE_GROUP + "/providers/Microsoft.Network/virtualNetworks/" + name;
  assert.deepEqual(sealed.changes, [{ address: id, type: ALLOWED_RESOURCE_TYPE, action: "CREATE" }]);
  assert.deepEqual(sealed.unit, { unitId: UNIT.unitId, tags: { ...UNIT.tags }, untagged: [] });
});

test("with the committed placeholder unit tags, or none, the same seal is refused UNIT_TAG_MISSING", () => {
  const tags = JSON.parse(compiled()).resources[0].tags as Record<string, string>;
  const defaults = { "alz-build": tags["alz-build"]!, "alz-managed-by": tags["alz-managed-by"]!, "alz-unit": tags["alz-unit"]! };
  for (const unitTags of [defaults, {}]) {
    let code = "";
    try { sealThroughEngine(evaluated({ name: "vnet-alz-act-dev-1-canary-01", location: "eastus2", owner: "qa", unitTags })); } catch (error) { code = codeOf(error); }
    assert.equal(code, "UNIT_TAG_MISSING", JSON.stringify(unitTags));
  }
});

const BICEP_PROGRAM = process.env.ALZ_BICEP;
test("recompiling main.bicep with the pinned bicep yields the committed main.json byte for byte (opt-in)", { skip: BICEP_PROGRAM ? false : "set ALZ_BICEP to the pinned bicep program" }, () => {
  const version = spawnSync(BICEP_PROGRAM!, ["--version"], { encoding: "utf8", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
  assert.equal(/^Bicep CLI version (\d+\.\d+\.\d+)(?:\s|$)/.exec(version.stdout.trim())?.[1], pinnedBicepVersion());
  // The engine's own compile step: `bicep build main.bicep --stdout --no-restore` in the project folder.
  const build = spawnSync(BICEP_PROGRAM!, ["build", BICEP_ENTRY, "--stdout", "--no-restore"], { cwd: DIR, encoding: "utf8", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.stdout, compiled());
});
