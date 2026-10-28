import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { codeOf } from "../src/apply/engine.js";
import { ALLOWED_RESOURCE_TYPE, BICEP_ENTRY, RESOURCE_GROUP_TEMPLATE_SCHEMA, checkTemplate, pinnedBicepVersion } from "../src/apply/engines/bicep.js";

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
  assert.equal(vnet.tags, "[union(createObject('environment', 'DEV', 'managed-by', 'sovereign-alz', 'purpose', 'act-dev-1', 'owner', parameters('owner')), parameters('unitTags'))]");
  // The engine passes no parameter values, so each parameter has a default. Name, owner and unit tags are EXAMPLE values the
  // operator replaces; location follows the existing pilot resource group.
  assert.deepEqual(Object.keys(template.parameters), ["name", "location", "owner", "unitTags"]);
  for (const [name, parameter] of Object.entries<any>(template.parameters)) assert.ok(Object.hasOwn(parameter, "defaultValue"), name);
  assert.equal(template.parameters.location.defaultValue, "[resourceGroup().location]");
  assert.match(template.parameters.name.defaultValue, /^vnet-alz-act-dev-1-/);
  assert.equal(template.parameters.owner.defaultValue, "REPLACE-WITH-APPROVED-OWNER");
  assert.deepEqual(Object.keys(template.parameters.unitTags.defaultValue).sort(), ["alz-build", "alz-managed-by", "alz-unit"]);
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

const BICEP = process.env.ALZ_BICEP;
test("recompiling main.bicep with the pinned bicep yields the committed main.json byte for byte (opt-in)", { skip: BICEP ? false : "set ALZ_BICEP to the pinned bicep program" }, () => {
  const version = spawnSync(BICEP!, ["--version"], { encoding: "utf8", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
  assert.equal(/^Bicep CLI version (\d+\.\d+\.\d+)(?:\s|$)/.exec(version.stdout.trim())?.[1], pinnedBicepVersion());
  // The engine's own compile step: `bicep build main.bicep --stdout --no-restore` in the project folder.
  const build = spawnSync(BICEP!, ["build", BICEP_ENTRY, "--stdout", "--no-restore"], { cwd: DIR, encoding: "utf8", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" } });
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.stdout, compiled());
});
