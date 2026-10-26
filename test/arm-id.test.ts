import assert from "node:assert/strict";
import { test } from "node:test";

import { armTypeOf, armTypePairsOf, isArmRegistrationId, parseArmId } from "../src/observe/arm-id.js";

// The positional ARM id parser (review 6410149770, B3): a `providers` segment is the keyword only in a key slot. Pure, synthetic, table-driven.
const SUB = "12345678-1234-4123-8123-123456789abc";
const sub = "/subscriptions/" + SUB;
const RG = sub + "/resourceGroups/alz-pilot-rg";
const GROUPS = { namespace: "Microsoft.Resources", typePath: "resourceGroups" };

test("parseArmId reads an id by position: subscription, group, then provider blocks of type/name pairs, with `providers` as a name wherever it sits in a name slot", () => {
  const rows: [string, string, ReturnType<typeof parseArmId>][] = [
    ["a subscription", sub, { subscription: SUB, pairs: [] }],
    ["a subscription in upper case keywords", "/SUBSCRIPTIONS/" + SUB.toUpperCase(), { subscription: SUB.toUpperCase(), pairs: [] }],
    ["a resource group", RG, { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [GROUPS] }],
    ["a resource group named providers", sub + "/resourceGroups/providers", { subscription: SUB, resourceGroup: "providers", pairs: [GROUPS] }],
    ["a resource group named resourceGroups", sub + "/resourceGroups/resourceGroups", { subscription: SUB, resourceGroup: "resourceGroups", pairs: [GROUPS] }],
    ["a tracked resource", RG + "/providers/Microsoft.OperationalInsights/workspaces/law", { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [{ namespace: "Microsoft.OperationalInsights", typePath: "workspaces" }] }],
    ["a nested tracked type", RG + "/providers/Microsoft.Storage/storageAccounts/x/blobServices/default/containers/c", { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [{ namespace: "Microsoft.Storage", typePath: "storageAccounts/blobServices/containers" }] }],
    ["an extension resource on a tracked one", RG + "/providers/Microsoft.OperationalInsights/workspaces/law/providers/Microsoft.Authorization/roleAssignments/g",
      { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [{ namespace: "Microsoft.OperationalInsights", typePath: "workspaces" }, { namespace: "Microsoft.Authorization", typePath: "roleAssignments" }] }],
    ["a role assignment in a group named providers (reviewer id 1)", sub + "/resourceGroups/providers/providers/Microsoft.Authorization/roleAssignments/g",
      { subscription: SUB, resourceGroup: "providers", pairs: [{ namespace: "Microsoft.Authorization", typePath: "roleAssignments" }] }],
    ["a lock on a storage account named providers (reviewer id 2)", RG + "/providers/Microsoft.Storage/storageAccounts/providers/providers/Microsoft.Authorization/locks/alz-lock",
      { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [{ namespace: "Microsoft.Storage", typePath: "storageAccounts" }, { namespace: "Microsoft.Authorization", typePath: "locks" }] }],
    ["a deployment in a group named providers (reviewer id 3)", sub + "/resourceGroups/providers/providers/Microsoft.Resources/deployments/alz-deploy",
      { subscription: SUB, resourceGroup: "providers", pairs: [{ namespace: "Microsoft.Resources", typePath: "deployments" }] }],
    ["a storage account named providers", sub + "/resourceGroups/providers/providers/Microsoft.Storage/storageAccounts/providers",
      { subscription: SUB, resourceGroup: "providers", pairs: [{ namespace: "Microsoft.Storage", typePath: "storageAccounts" }] }],
    ["a nested name of providers followed by an extension", RG + "/providers/Microsoft.Storage/storageAccounts/a/blobServices/providers/providers/Microsoft.Authorization/locks/l",
      { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [{ namespace: "Microsoft.Storage", typePath: "storageAccounts/blobServices" }, { namespace: "Microsoft.Authorization", typePath: "locks" }] }],
    ["mixed-case keywords", "/Subscriptions/" + SUB + "/ResourceGroups/providers/PROVIDERS/microsoft.authorization/ROLEASSIGNMENTS/g",
      { subscription: SUB, resourceGroup: "providers", pairs: [{ namespace: "microsoft.authorization", typePath: "ROLEASSIGNMENTS" }] }],
    ["a subscription-scoped resource", sub + "/providers/Microsoft.Authorization/roleDefinitions/d", { subscription: SUB, pairs: [{ namespace: "Microsoft.Authorization", typePath: "roleDefinitions" }] }],
    ["a tenant-level resource", "/providers/Microsoft.Management/managementGroups/mg", { pairs: [{ namespace: "Microsoft.Management", typePath: "managementGroups" }] }],
    ["a deployment at management-group scope", "/providers/Microsoft.Management/managementGroups/mg/providers/Microsoft.Resources/deployments/d",
      { pairs: [{ namespace: "Microsoft.Management", typePath: "managementGroups" }, { namespace: "Microsoft.Resources", typePath: "deployments" }] }],
    ["a name with a pipe (a diagnostic setting id)", RG + "/providers/Microsoft.Compute/virtualMachines/vm|diag", { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [{ namespace: "Microsoft.Compute", typePath: "virtualMachines" }] }],
    // Registrations and provider-level scopes (review 6410591513, NB-B): a block with a namespace and no pair.
    ["a provider registration", sub + "/providers/Microsoft.ContainerService", { subscription: SUB, pairs: [{ namespace: "Microsoft.ContainerService", typePath: "" }] }],
    ["a feature registration", sub + "/providers/Microsoft.Features/providers/Microsoft.ContainerService/features/AKS-x",
      { subscription: SUB, pairs: [{ namespace: "Microsoft.Features", typePath: "" }, { namespace: "Microsoft.ContainerService", typePath: "features" }] }],
    ["a marketplace-scope role assignment", "/providers/Microsoft.Marketplace/providers/Microsoft.Authorization/roleAssignments/g",
      { pairs: [{ namespace: "Microsoft.Marketplace", typePath: "" }, { namespace: "Microsoft.Authorization", typePath: "roleAssignments" }] }],
    ["a provider block with no pair under a resource", RG + "/providers/Microsoft.Storage", { subscription: SUB, resourceGroup: "alz-pilot-rg", pairs: [{ namespace: "Microsoft.Storage", typePath: "" }] }],
  ];
  for (const [label, id, expected] of rows) assert.deepEqual(parseArmId(id), expected, label);
  for (const id of [sub + "/providers/Microsoft.ContainerService", sub + "/providers/Microsoft.Features/providers/Microsoft.ContainerService/features/AKS-x", "/providers/Microsoft.Marketplace/providers/Microsoft.Authorization/roleAssignments/g", RG + "/providers/Microsoft.Storage"]) {
    assert.ok(isArmRegistrationId(parseArmId(id)!), id + " is a registration or provider scope, not a resource");
  }
  for (const id of [RG, RG + "/providers/Microsoft.OperationalInsights/workspaces/law", sub + "/providers/Microsoft.Authorization/roleDefinitions/d", sub]) assert.ok(!isArmRegistrationId(parseArmId(id)!), id);
});

test("parseArmId is undefined for anything it cannot consume in full: a trailing slash, an empty segment, an odd pair, a name-less type, a bad subscription, a dotless namespace, a path the URL parser would rewrite, and garbage", () => {
  const rows: [string, string][] = [
    ["empty", ""], ["no leading slash", "subscriptions/" + SUB], ["a relative path", "foo/bar"], ["garbage", "not an id"],
    ["a trailing slash on a group", RG + "/"], ["a trailing slash on a resource", RG + "/providers/Microsoft.Storage/storageAccounts/x/"],
    ["an empty segment", RG + "/providers//roleAssignments/x"], ["a double slash in the group", sub + "//resourceGroups/x"],
    ["a dot segment", RG + "/providers/Microsoft.Storage/./storageAccounts/x"], ["a dot-dot segment", RG + "/providers/Microsoft.Storage/storageAccounts/a/../b"],
    ["a backslash", RG + "/providers/Microsoft.Storage/storageAccounts/a\\b"], ["a percent escape", RG + "/providers/Microsoft.Storage/storageAccounts/a%2Fb"],
    ["whitespace", RG + "/providers/Microsoft.Storage/storageAccounts/a b"], ["a control character", RG + "/providers/Microsoft.Storage/storageAccounts/a\u0001b"],
    ["a query", RG + "?api-version=1"], ["a fragment", RG + "#x"],
    ["a type with no name", RG + "/providers/Microsoft.Storage/storageAccounts"], ["an authorization type with no name", RG + "/providers/Microsoft.Authorization/roleAssignments"],
    ["providers with nothing after it", RG + "/providers"], ["a registration followed by a stray segment", sub + "/providers/Microsoft.ContainerService/foo"],
    ["a bad subscription", "/subscriptions/not-a-guid/resourceGroups/x"], ["a subscription with a stray segment", sub + "/foo"], ["a group keyword with no name", sub + "/resourceGroups"],
    ["something after the group that is not providers", RG + "/foo/bar"],
    ["a dotless namespace", RG + "/providers/providers/locks/l"], ["a namespace that is the keyword after a name named providers", RG + "/providers/Microsoft.Storage/storageAccounts/x/providers/providers/providers/Microsoft.Authorization/locks/l"],
    ["a site named providers with an odd tail (reviewer probe)", RG + "/providers/Microsoft.Web/sites/providers/Microsoft.Authorization/roleAssignments/g"],
    ["a data-plane URL", "https://acct.blob.core.windows.net/c"], ["a key vault secret URL", "https://kv.vault.azure.net/secrets/s/1"], ["a directory object", "/servicePrincipals/" + SUB],
  ];
  for (const [label, id] of rows) {
    assert.equal(parseArmId(id), undefined, label);
    assert.equal(armTypePairsOf(id), undefined, label);
    assert.equal(armTypeOf(id), undefined, label);
  }
});

test("armTypePairsOf and armTypeOf follow the parser: every pair in order, the last pair as the resource's own type, none for a bare subscription", () => {
  assert.deepEqual(armTypePairsOf(RG), [GROUPS]);
  assert.deepEqual(armTypeOf(RG), GROUPS);
  const ext = RG + "/providers/Microsoft.Storage/storageAccounts/providers/providers/Microsoft.Authorization/locks/l";
  assert.deepEqual(armTypePairsOf(ext), [{ namespace: "Microsoft.Storage", typePath: "storageAccounts" }, { namespace: "Microsoft.Authorization", typePath: "locks" }]);
  assert.deepEqual(armTypeOf(ext), { namespace: "Microsoft.Authorization", typePath: "locks" });
  assert.equal(armTypePairsOf(sub), undefined, "a subscription names no resource type");
  assert.equal(armTypeOf(sub), undefined);
  assert.deepEqual(parseArmId(sub), { subscription: SUB, pairs: [] }, "but it parses, as a scope");
});
