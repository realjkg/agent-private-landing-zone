# ACT pilot: the Azure Bicep / ARM engine (path 4)

Status: **engine admitted in code for DEV only (owner decision E2). ACT stays DISABLED.** The `BICEP` engine is registered and a contract may name Azure with it under the DEV-only scope; admission still needs the owner's reviewed contract with an `authorize` entry, and the repository ships none. Nothing in this note enables infrastructure mutation, and no run on Azure has happened.

**Registration is not readiness.** There is no emulator for Azure Resource Manager, so this path has no emulated qualification and none is claimed: every test of it is SYNTHETIC (a fake `az` and `bicep`), and every Azure fact below is either checked against the vendor's own source (the az CLI 2.91.0 wheel, Microsoft's published operation and role lists) or marked UNVERIFIED. Live qualification is the owner-supervised **G2** DEV run, and it needs the owner's authorization.

The owner's E2 decision (issue #39, coordinator PLAN 6467476073, option A) sets the identities: the seal-time what-if runs as **APPLY**, with the human approvals still between that preview and the stack create; DISCOVERY stays read-only; and `manageDenySetting` goes to APPLY only, through a custom role scoped to the dedicated pilot resource group. `bootstrap/azure` implements it behind `bicep_deployment_stacks` (see [Identities and roles](#identities-and-roles)).

This note covers path 4 of the narrow ACT-DEV release (`docs/act-dev-paths.md`; owner decision on issue #39, comment 6443352284). It follows the coordinator's defaults (comment 6443800275) and the shared Azure workload that the coordinator set for paths 3 and 4.

## Scope

- **Minimal workload:** one empty, tagged virtual network, deployed into the **existing pilot resource group** that the `bootstrap/azure` DEV mode creates (#304). The run never creates, adopts or deletes a resource group.
- **Engine:** one Azure **deployment stack scoped to that resource group** (`az stack group ...`), with deny settings on.
- **No provider registration:** the engine runs no `az provider register`, and none of its identities needs registration rights. UNVERIFIED (A5): if `Microsoft.Network` or `Microsoft.Resources` is not registered in the subscription, the what-if fails, so the seal is refused before anything is created.
- **Reuse:** the shared seal, driver, approval, ledger, evidence, readiness and console modules are unchanged. The engine is one `EngineSpec` (`src/apply/engines/bicep.ts`, added in #316), modeled on the CDK engine (`src/apply/engines/cdk.ts`). These shared pieces are reused as they are:
  - the unit tags (`src/apply/unit.ts`);
  - the Bicep what-if tag reader (`readBicepWhatIfTags`, `src/teardown/readers.ts`);
  - the ARM id parser (`src/observe/arm-id.ts`);
  - the identity value reader (`pickIdentityValue`, `src/apply/providers/shared.ts`);
  - the independent ARM reader (`src/observe/azure-rest.ts`).

## Plan of record: the deployment what-if, not the stack what-if

az 2.91.0 has `az stack-whatif group create`, but it **creates a persistent what-if result resource**, which would be a write by the sealing identity. The engine instead uses `az deployment group what-if`, as the existing Bicep preview does: a POST that persists nothing. That what-if cannot show which resources the stack would drop, so the engine adds those itself, as `DELETE` lines taken from the stack's own managed-resource list.

## Identities

The engine uses two principals. Their variables have the same form as the Azure Terraform identities' (`ALZ_<IDENTITY>_ARM_CLIENT_ID`, `_ARM_TENANT_ID`, `_ARM_SUBSCRIPTION_ID`, `_ARM_USE_OIDC=true`, `_ARM_OIDC_TOKEN_FILE`), so the Azure provider spec's variable checks (`src/apply/providers/azure.ts`) and `checkApplyIdentities` read them as they are.

Which identity runs each step (the engine's allowlist, `isAllowedBicepArgv`, enforces it; each adapter's argv digest is taken over these lists with their identities, so the qualified digests change with this table and the argument shapes do not):

| Step | DISCOVERY | APPLY | No identity |
|---|---|---|---|
| Seal | `az login`, `az account show`, `az group show`, `az stack group show` | `az login`, `az account show`, **`az deployment group what-if`** | `az version`, `bicep --version`, `bicep build` |
| Qualify | `az login`, `az account show`, `az group show`, `az stack group show` | `az login`, `az account show`, `az stack group show` | `az version`, `bicep --version`, `bicep build` |
| Apply | `az login`, `az account show`, `az group show`, `az stack group show` (the ownership and blueprint reads after the run) | `az login`, `az account show`, `az stack group show`, **`az deployment group what-if`** (re-derivation), `az stack group create` | `az version`, `bicep --version`, `bicep build` |
| Cleanup | `az login`, `az account show` | `az login`, `az account show`, `az stack group show`, `az stack group delete` | `az version`, `bicep --version` |
| Observe, leftovers | the independent ARM REST read-back (no az process) | none | none |

### Why the seal-time preview runs as APPLY

Azure Bicep is the one engine whose seal-time preview runs as APPLY, as the CDK engine's change set is created by its own CHANGESET identity rather than by DISCOVERY (`docs/act-pilot-apply.md`, "CDK"). ARM authorizes the deployment what-if (a POST to `.../deployments/<name>/whatIf`) as `Microsoft.Resources/deployments/whatIf/action`, and Microsoft documents what-if as needing the same permissions as a deployment. Giving that action to DISCOVERY would make it more than a reader. Under the owner's option A, DISCOVERY keeps Reader and gains nothing, and the what-if runs as APPLY, which holds the deployment rights anyway.

This does not move the approval boundary. The what-if persists no deployment and creates, changes or deletes nothing (UNVERIFIED (A1) for ARM's behavior). The seal ends after it. Nothing is created until a person runs the apply with the required approvals, which the ledger consumes once, and the apply runs the what-if again as APPLY and refuses a plan whose change list moved (`PLAN_STALE`). The stack create and delete run as APPLY only, and nothing in a seal can reach them: the allowlist admits `stack group create` for the apply adapter alone and `stack group delete` for the cleanup adapter alone.

## Identities and roles

| Identity | Azure roles (`bootstrap/azure` with `bicep_deployment_stacks = true`, DEV only) | Effective permissions at the pilot resource group |
|---|---|---|
| DISCOVERY | Reader on the pilot resource group (unchanged) | `*/read` only: no what-if, deployment, stack write or deny-setting action |
| APPLY | No built-in role (owner decision of 2026-10-28: no Contributor). The custom role `alz-pilot-bicep-stack-apply-<group>` below, plus the Azure Terraform path's custom role `alz-pilot-apply-<subscription>-<group>` (virtual network read, write and delete; `docs/act-pilot-bootstrap.md`, "APPLY's role (Azure)"), each defined, assignable and assigned at the pilot resource group only | Exactly the union of the two lists: no `Microsoft.Authorization` action, so APPLY cannot assign roles or write deny assignments of its own; ARM creates the stack's deny assignment on the stack's behalf. |

The custom role lists exactly the operations the engine's az calls need, and nothing else (no wildcard, no `Microsoft.Authorization` action, no data action, nothing at subscription scope). `bootstrap/azure/tests/environments.tftest.hcl` checks the list, the scopes and the assignee offline with mocked providers. Each name was checked against Microsoft's published resource-provider operations (the `MicrosoftDocs/azure-docs` sources of learn.microsoft.com, `articles/role-based-access-control/permissions/management-and-governance.md` and `.../networking.md`, ms.date 07/01/2026, read on 2026-10-28):

| Operation | Why the engine needs it | Source |
|---|---|---|
| `Microsoft.Resources/deployments/whatIf/action` | `az deployment group what-if` (seal, apply) | management-and-governance: "Predicts template deployment changes." |
| `Microsoft.Resources/deployments/validate/action` | the what-if's and the stack's template validation | management-and-governance: "Validates a deployment." |
| `Microsoft.Resources/deployments/write` | the deployment the stack creates in the group | management-and-governance: "Creates or updates an deployment." |
| `Microsoft.Resources/deployments/read` | reading that deployment | management-and-governance: "Gets or lists deployments." |
| `Microsoft.Resources/deployments/operationstatuses/read` | polling that deployment's asynchronous operation (added on 2026-10-28 when Contributor, which covered it, was removed; P1 below) | management-and-governance: "Gets or lists deployment operation statuses." |
| `Microsoft.Resources/deploymentStacks/read` | `az stack group show` | management-and-governance: "Gets or lists deployment stacks" |
| `Microsoft.Resources/deploymentStacks/validate/action` | `az stack group create` validates first (`begin_validate_stack_at_resource_group`, az 2.91.0 `custom.py`) | management-and-governance: "Validates a deployment stack." |
| `Microsoft.Resources/deploymentStacks/write` | `az stack group create` | management-and-governance: "Creates or updates a deployment stack" |
| `Microsoft.Resources/deploymentStacks/delete` | `az stack group delete` | management-and-governance: "Deletes a deployment stack" |
| `Microsoft.Resources/deploymentStacks/manageDenySetting/action` | `--deny-settings-mode denyWriteAndDelete` | management-and-governance: "Manage the denySettings property of a deployment stack."; built-in-roles/privileged.md lists it in Contributor's NotActions |
| `Microsoft.Network/virtualNetworks/read`, `/write`, `/delete` | the stack creates and deletes the one virtual network | networking: "Get the virtual network definition", "Creates a virtual network or updates an existing virtual network", "Deletes a virtual network" |

**Choice (owner decision of 2026-10-28, "Azure APPLY role").** APPLY no longer holds Contributor on any path, so this role is APPLY's whole Bicep authority, and the deployment's operation-status read that Contributor used to cover is now listed (13 actions). No Contributor exception is needed or proposed. UNVERIFIED (P1): that this set is sufficient for ARM (for example, whether the what-if's or the stack's polling needs `deployments/operations/read` too), checked at G2; a refused operation is added by name in a reviewed commit, never by restoring Contributor.

**Location, observed.** The seal and the apply bind `location` as before (the group's region and every what-if `after.location`). After the run, the independent ARM reader is given the target's `location` too (`src/apply/observe.ts`): a stack resource found in another region is `DIFFERENT_FROM_DESIRED` with `LOCATION_NOT_IN_CONTRACT`, the observation is `FAILED`, and no cleanup is proposed from it; a virtual network whose answer names no location is `UNKNOWN` (`LOCATION_UNREADABLE`), never `VERIFIED`. The region is compared in process and never recorded.

STATE, STATE_WRITE and CHANGESET are not used. As for CDK, `checkApplyIdentities` refuses a run that has any of them configured.

### How az signs in

For each identity, the engine makes a private az configuration directory (mode 0700) in the run's scratch directory and runs:

```text
az login --service-principal --username <ARM_CLIENT_ID> --tenant <ARM_TENANT_ID> --federated-token @<ARM_OIDC_TOKEN_FILE> --output none
```

- **No token in argv.** The `@<path>` form is az's own file expansion (`_expand_file_prefixed_files` in azure-cli-core 2.91.0): az reads the token from the file, so the token is never a process argument.
- **az never compiles Bicep.** The engine compiles with the pinned `bicep` itself and hands az only the compiled `.json` template, written to a private file in the run's scratch directory, with the identity's private `AZURE_CONFIG_DIR`. az therefore never compiles a `.bicep` file, and never downloads or runs a Bicep of its own (its `bicep.use_binary_from_path` setting never comes into play).
- **Nothing ambient in the child's environment.** It holds only `AZURE_CONFIG_DIR` (that private directory) and fixed, non-secret settings: telemetry off, no color, and no dynamic extension install. No `ARM_*`, `AZURE_*` or ambient credential reaches it.
- **Explicit subscription.** Every later step for that identity names `--subscription <contract subscription>`.
- **Sign-in checks.** `az account show` must report the contract's tenant and subscription, and the identity's own client id as a service principal (otherwise `ACCOUNT_NOT_IN_CONTRACT`). DISCOVERY and APPLY must report different client ids (otherwise `IDENTITY_COLLAPSED`).
- **Clean-up.** `removeSecrets()` deletes the directories, which hold az's token cache.

The `@` expansion applies to every az argument, in exactly two places: az splits each argument on its first `=`, and reads as a file the part after that `=`, or the whole argument when it has no `=`, when that part starts with `@` and something follows it (`_expand_file_prefixed_files`, azure-cli-core 2.91.0). So both `@/path` and `key=@/path` (the shape of a `--tags` value) are file reads, and `@-` reads standard input; an `@` anywhere else (`a@b`, `key=a@b`) is left as written. Each argument list is therefore matched exactly against an allowlist (`isAllowedBicepArgv`) before it runs, and the allowlist is stricter than az: no argument may contain `@` at all, except the login's own token slot, which must be `@` followed by an absolute token-file path.

## Contract target

The contract names `provider: AZURE` and `engine: BICEP`. Each environment's target holds the provider's `tenantId` and `subscriptionId`, plus:

- `backend`: the deployment stack's name (`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,88}[A-Za-z0-9_-])?$`: a letter or digit first, so a value never reads as an option, and no trailing `.`). The same name may repeat across environments, because the subscription already differs.
- `workspace`: `default`.
- `resourceGroup`: the existing pilot resource group (#304) that the stack is scoped to. It is an engine target field (`EngineSpec.target.fields`) and a location field (`EngineSpec.target.locationFields`), so it joins the run's target hash (`pilotTargetSha256`) with the tenant, the subscription, the stack name and the canary allowlist, and a cleanup refuses a contract that moved the stack to another group.
- `canary` (owner decision E1): exactly `{ "resources": [{ "type": "Microsoft.Network/virtualNetworks", "count": 1 }] }` for the committed canary (`qualification/azure/act-dev1-bicep-canary`). A target with no `canary` cannot be authorized for APPLY (`CANARY_ALLOWLIST_MISSING`).

- `location`: the Azure region the run deploys to, as ARM's programmatic name (`eastus2`, `westeurope`: lowercase letters and digits). It is a target field and a location field, so it joins the target hash, and the sealed record names it. The seal and the apply each refuse with `LOCATION_NOT_IN_CONTRACT` unless the existing group's `location` (`az group show`, read as DISCOVERY) is this region and every resource the what-if creates or changes has this region as its `after.location` (as ARM evaluated it, so a literal, a parameter default or `[resourceGroup().location]` are all judged by where the resource would actually go). At the apply that refusal is `TARGET_NOT_IN_CONTRACT`, before any approval is consumed (review of #332, B1).

## Plan (seal)

1. **Check the project.** Copy the snapshot to a private work directory, and require the copy to equal the manifest (`projectDifference`).
2. **Check the tool versions.** `bicep --version` and `az version --output json` must report the pinned versions (`config/tool-pins.json`, `bicep` and `azureCli`). The pinned az version is the manifest's `engineVersion`.
3. **Compile** `main.bicep` with the pinned bicep: `bicep build main.bicep --stdout --no-restore`. No identity is given. With `--no-restore` and an empty home directory, no registry or template-spec module can be fetched, so only local files compile.
4. **Read the compiled ARM JSON** and refuse anything outside the minimal workload:
   - the schema must be exactly `https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#`, the host included;
   - there must be exactly one resource, of type `Microsoft.Network/virtualNetworks`, holding only `type`, `apiVersion`, `name`, `location`, `tags` and `properties`;
   - its properties must be only `addressSpace.addressPrefixes`: the network is empty, so no subnet (and so no delegation), no peering and no `ddosProtectionPlan`;
   - the template may hold only `$schema`, `languageVersion`, `contentVersion`, `metadata`, `parameters`, `variables` and `resources`: no `outputs` and no user `functions`;
   - no `list*` function call (`listKeys` and the like) appears in any key or string value of the parsed template (judged after parsing, so a JSON escape such as `\u006cistKeys(` cannot hide one);
   - each address prefix is a literal CIDR block and the tags, keys and values, are literal strings: no ARM expression (`[...]`), so what is deployed is exactly the sealed text (`TEMPLATE_VALUE_NOT_LITERAL`); a project that passes its tags as a parameter is refused;
   - there may be no module (`Microsoft.Resources/deployments`), no `existing` resource and no extension resource (`scope`).

   Any other type is `RESOURCE_TYPE_NOT_ALLOWED`, and any other shape is `TEMPLATE_SHAPE_NOT_ALLOWED`. A `Microsoft.Resources/resourceGroups` resource is refused like any other type: the run must not create a group.

   The compiled template's resources must also be exactly the target's canary allowlist (owner decision E1, `src/apply/canary.ts`), each by its type exactly as written: another type, another count, or no allowlist is refused (`RESOURCE_NOT_IN_CANARY`, `CANARY_ALLOWLIST_MISSING`) before any az call. Both checks hold; neither replaces the other.
5. **Sign both identities in** and **check the resource group** as DISCOVERY (`az group show`). It must already exist (otherwise `RESOURCE_GROUP_NOT_FOUND`) and be in the contract's `location` (otherwise `LOCATION_NOT_IN_CONTRACT`). The engine never creates it.
6. **Read the stack** as DISCOVERY (`az stack group show`). If the stack exists, it must be in a final state, carry the deny settings below, and carry exactly the deletion unit's three tags, keys and values (a cleanup, which is given no unit, requires the three keys). Its fingerprint (id, state, last modification, deployment id, managed resources and deny settings) is bound into the seal.
7. **Run the what-if** as APPLY (owner decision E2, option A; see [Why the seal-time preview runs as APPLY](#why-the-seal-time-preview-runs-as-apply)). This is the plan of record:

   ```text
   az deployment group what-if --resource-group <group> --template-file <compiled>
     --result-format FullResourcePayloads --validation-level ProviderNoRbac
     --no-pretty-print --no-prompt true --subscription <sub> --output json
   ```

   - `ProviderNoRbac`, as in the existing preview, checks the template with the provider but not the caller's write permissions. It does not remove the need for `Microsoft.Resources/deployments/whatIf/action` itself, which is why the what-if runs as APPLY.
   - Each change becomes one line of the change list (ARM id, type, action): `Create` is CREATE; `Modify` and `Deploy` are UPDATE; `Delete` is DELETE.
   - `NoChange` and `Ignore` are not changes.
   - `Unsupported`, or any other change type, refuses the seal (`WHATIF_UNSUPPORTED_CHANGE`).
   - Managed resources that the what-if no longer lists are added as DELETE, because the stack's `deleteResources` would delete them.
8. **Check the change list.** The seal is refused for:
   - a type outside the allowlist (`RESOURCE_TYPE_NOT_ALLOWED`);
   - an id outside the contract's subscription and resource group (`WHATIF_NOT_IN_CONTRACT`);
   - a resource that already exists but that the stack does not manage (`RESOURCE_PREEXISTS`): the stack would adopt it, and cleanup would then delete something the run did not create;
   - a created or modified resource without exactly the unit's tags (`UNIT_TAG_MISSING`), read with `readBicepWhatIfTags`;
   - a created or modified resource whose `after.location` is not the contract's `location` (`LOCATION_NOT_IN_CONTRACT`);
   - nothing to change (`NO_CHANGES_TO_APPLY`);
   - anything but creates of exactly the canary allowlist's types and counts (`RESOURCE_NOT_IN_CANARY`): an UPDATE or DELETE is refused, so a run against a stack that already manages the network cannot be sealed.
9. **Seal the artifact.** The sealed artifact is canonical JSON. It holds the compiled template's exact text and binds:
   - the tenant, subscription, resource group, location and stack name;
   - the deny settings and the action on unmanage;
   - the template's SHA-256;
   - the change list's hash;
   - the stack fingerprint;
   - the unit tags' hash.

   The unit is sealed with `untagged: []`, because a virtual network takes tags.

## Execute (apply)

`prepare` copies and checks the snapshot again, checks both versions, signs both identities in, checks the group and its location again as DISCOVERY, and reads the stack as APPLY.

`rederive(artifact)` refuses unless all of the following hold:

- the artifact parses with exactly the record's keys and the contract's values (otherwise `ARTIFACT_TAMPERED`);
- the template text hashes to the sealed hash (otherwise `ARTIFACT_TAMPERED`);
- compiling the snapshot again with the pinned bicep gives the sealed template byte for byte (otherwise `ARTIFACT_TAMPERED`). This is the refusal of any template change after the seal;
- the template passes the checks of seal step 4 again, the canary allowlist included;
- a new what-if as APPLY gives the sealed change list (otherwise `PLAN_STALE`), and that list is again exactly the canary allowlist's creates;
- the stack's fingerprint is the sealed one (otherwise `PLAN_STALE`). The first apply moves the stack, so a second apply of the same artifact refuses here, even before the ledger's `ARTIFACT_ALREADY_APPLIED`.

`execute(artifact)` checks the kill switch, then the record and the stack fingerprint once more. It writes the sealed template to a private file and runs, as APPLY:

```text
az stack group create --name <stack> --resource-group <group> --template-file <sealed template>
  --deny-settings-mode denyWriteAndDelete --deny-settings-apply-to-child-scopes
  --action-on-unmanage deleteResources --tags alz-build=<..> alz-managed-by=<..> alz-unit=<..>
  --yes --no-wait --subscription <sub> --output none
```

- **No parameters.** The template's defaults are the only values, and they are inside the sealed bytes.
- **No exclusions.** No excluded principals or actions are allowed.
- **Nothing throws from the create call on.** The engine polls `az stack group show` as APPLY until one of these happens:
  - the stack reaches a final state;
  - a stop arrives (the kill switch, a signal, or the 60-minute limit);
  - the stack cannot be read three times in a row.
- **No cancel.** There is no cancel in the engine's allowlist, so a stopped create runs on in Azure, and the outcome is KILLED.

`settle` returns one of four outcomes:

| Outcome | When |
|---|---|
| SUCCEEDED | The create exited 0, the stack moved (new deployment id or last-modified time), its state is `succeeded`, it lists no failed resources, and it reports the sealed deny settings. All five must hold. |
| FAILED_NO_CHANGE | Positive evidence only: az ran to completion and gave a definite non-zero exit, and at least three reads over the poll window show the stack unmoved. Definite means a refusal ARM itself returned, printed by az as `(<Code>) <message>`; an az transport error that exits 1 (a closed connection, a timeout) may follow a request that reached ARM, so it is not definite (UNVERIFIED (A3): az's error format). A create with no exit code (a timeout, the output cap or a spawn error) may have reached ARM, so it is never this outcome. |
| KILLED | A stop arrived. |
| PARTIAL_REQUIRES_REVIEW | Everything else. |

## Deny settings

The stack uses mode `denyWriteAndDelete` with `applyToChildScopes`, no excluded principals and no excluded actions. This is the most restrictive mode:

- only the stack's own operations change or delete managed resources;
- APPLY reaches them only through the stack;
- the resource group is not managed, so the settings never apply to it.

UNVERIFIED (D1): that a stack delete with `deleteResources` removes resources under its own `denyWriteAndDelete` assignment without an excluded principal. Microsoft documents deleting protected resources "through the stack". G2 checks it. If it does not hold, the fallback is `denyDelete`.

The mode is never `none`. A stack read with `none`, or with any excluded principal or action, is refused (`DENY_SETTINGS_OFF`) at seal, at apply and at cleanup.

## Ownership

Ownership comes from the stack's `resources` list, filtered to status `managed`. az prints the stack's properties at the top level, as its own `transform_stacks` formatter reads them. After an apply, `managedResources()` reads the list once as DISCOVERY.

Tags stay pointers, never ownership (`src/apply/unit.ts`). The stack carries the unit tags, and every created resource must carry them (seal step 8).

## Verify

Verification is an independent ARM read-back as DISCOVERY. Every managed resource id is read with the existing REST reader (`src/observe/azure-rest.ts`), which runs no az process, so no credential reaches argv.

- After an apply, each id must exist.
- After a cleanup, a GET of each id must return not found.

## Cleanup

Cleanup is whole-stack only. A cleanup is a proposal, approved by quorum and run behind the kill switch like every cleanup. Its addresses must be exactly the stack's managed resource ids. Each must be inside the pilot resource group, and none may be the group itself. Anything less is `CLEANUP_PARTIAL_UNSUPPORTED`: a partial removal would be a template edit, which this minimal path does not offer.

Before the delete, the engine checks that the stack exists, is in a final state, carries the unit's three tags, and has the deny settings above. Then, as APPLY:

```text
az stack group delete --name <stack> --resource-group <group> --action-on-unmanage deleteResources --yes --subscription <sub> --output none
```

- **Last check.** Just before the call, the engine checks once more that the stack fingerprint is unchanged.
- **The group stays.** `deleteResources` deletes managed resources and detaches resource groups (`_prepare_stacks_action_on_unmanage` in az 2.91.0). The stack manages no group, so the pilot resource group is never deleted.
- **Stopping.** az 2.91.0 offers no `--no-wait` for a delete, so the call runs as a stoppable process. A stop ends the local call (KILLED), and Azure may still finish the delete.
- **Outcome.** `settle` returns SUCCEEDED only when the delete exited 0 with nothing cut off and the stack is gone. It returns FAILED_NO_CHANGE only after a definite non-zero exit (an ARM refusal, as for the create) and at least three reads over the poll window that show the stack unchanged. A delete stopped by the kill switch or the time limit is KILLED, and any other result is PARTIAL_REQUIRES_REVIEW. A person then confirms each id is gone with the independent read-back.
- **Order with the bootstrap teardown.** The stack cleanup (or `az stack group delete`) must run **before** the bootstrap teardown removes the pilot resource group. A stack left behind keeps its `denyWriteAndDelete` assignment on its resources, applied to child scopes, and that blocks the group's deletion.

## Engine-id admission (owner decision E2)

The engine is registered, for DEV only:

- `BICEP` is an `EngineId` and is in `SPECS` (`src/apply/engine-spec.ts`); the evidence names its two `mutation` values (`AZURE_DEPLOYMENT_STACK_CREATE_OF_SEALED_TEMPLATE`, `AZURE_DEPLOYMENT_STACK_DELETE_OF_RUN_STACK`).
- A contract may name `AZURE` with `BICEP` only under `"enabledEnvironments": ["DEV"]` (`DEV_ONLY_PATHS`, `src/apply/contract.ts`); a three-stage one is `CONTRACT_INVALID`, so no QA or PROD target can exist. `BICEP` with another provider is `CONTRACT_INVALID`. Each target adds `resourceGroup` and `location`, which join the run's target hash.
- The driver's blueprint hook reads the stack's id and managed resources as DISCOVERY after the run (`stateDocument`, source `AZURE_DEPLOYMENT_STACK_RESOURCES`); each managed resource is its own address, by ARM id, and the stack is the unit's container. The cleanup proposal names resources by their ARM ids, and the cleanup deletes the whole stack.
- `test/apply-bicep-admission.test.ts` drives the path through the driver (contract, requester signature, approvals, ledger and replay, kill switch, the canary allowlist, the template binding, evidence, observe, proposal, cleanup with the deny settings on, leftovers) with the fake `az` and `bicep` and a scripted ARM. SYNTHETIC: it is not emulation and not provider qualification.
- The release gate `act:azure-bicep` is in `ACT_RELEASE_PATHS` and `config/release/scope.json`, BLOCKED until live evidence exists.

The static production contract's pilot combinations (`src/qualification/production-contract.ts`) do not list Azure Bicep, so a release under a pilot contract for it is refused until the owner adds it.

## Assumptions to verify at G2

- UNVERIFIED (A1): the shape of `az deployment group what-if --no-pretty-print --output json` (`status`, `changes[].resourceId`, `changeType`, `after.type`, `after.tags`). The existing preview and `readBicepWhatIfTags` assume the same shape.
- UNVERIFIED (A2): the error text that tells a missing stack (`DeploymentStackNotFound`) or a missing group (`ResourceGroupNotFound`) apart from a failed read.
- UNVERIFIED (A3): the stack's final states (`succeeded`, `failed`, `canceled`) and its in-progress states.
- UNVERIFIED (A4): that Bicep's output for a resource-group file with one virtual network has the shape described in seal step 4. bicep 0.47.16 was not run here, and the tests use a hand-written template of that shape.
- D1 above.
- UNVERIFIED (A5): that an unregistered `Microsoft.Network` or `Microsoft.Resources` namespace fails the what-if, so the seal is refused.
- UNVERIFIED (P1): that the custom role's operations ([Identities and roles](#identities-and-roles)) are sufficient for ARM, and which permissions the what-if needs under `ProviderNoRbac`. The names themselves are Microsoft's published operation names.

## Tool pins

`config/tool-pins.json` adds two check-only pins, like the AWS CLI (#288). `./alz deps` compares the installed version and never installs either tool.

- **`azureCli` 2.91.0:** the newest release on PyPI, published 2026-10-05.
  - The wheel (`azure_cli-2.91.0-py3-none-any.whl`, SHA-256 `998f2b78…5e0b6`) was downloaded, and only its source was read. The stack, what-if, login and `@file` facts above come from it.
  - It was not run, and no Azure call was made.
- **`bicep` 0.47.16:** the version that the Bicep preview adapter already records as tested (`src/plugins/catalog.ts`), published 2026-09-08.
  - A test requires the pin and the catalog to agree, so the preview's lint/build step and the engine both run the same Bicep version from PATH. The preview's what-if is different: it hands az the `.bicep` file, and outside CI az uses (and may install) a Bicep of its own (`bicep.use_binary_from_path=if_found_in_ci`, `_bicep.py` in az 2.91.0). The engine avoids that by giving az only compiled JSON. `./alz deps` already reports Bicep on its product row against that version.
  - `./alz deps` probes az with a private, empty `AZURE_CONFIG_DIR` and telemetry off. With no configuration file, az's `auto-upgrade.enable` stays at its default (off), so a person's own az settings can never make the probe run `az upgrade`.
  - bicep 0.48.1 (the newest) printed its version in a sandbox; 0.47.16 was downloaded but not run.

The pins name the tested version only after the engine's qualification run against DEV binds the exact programs that ran.

## Release gates

- `act:azure-bicep`: the full DEV lifecycle through this engine. It is added with the registration, because the release scope must equal `ACT_RELEASE_PATHS` (`src/release/status.ts`), whose rows are typed by `EngineId`.
- `preview:bicep-azure-brownfield`: returned to scope by the owner's rebaseline (#39, 6443352284), then dropped from this release by the owner on 2026-10-28 (#39, 6480066863). It is OUT_OF_SCOPE because E1 makes APPLY seals create-only, so a brownfield what-if cannot be sealed.

All evidence produced in this lane is **SYNTHETIC** (a fake `az` and `bicep`). It is not provider qualification and does not certify a release.
