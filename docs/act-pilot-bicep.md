# ACT pilot: the Azure Bicep / ARM engine (path 4)

Status: **design and engine spec. ACT stays DISABLED.** Nothing in this note enables infrastructure mutation, and no run on Azure has happened. There is no emulator for Azure Resource Manager, so every Azure fact below is either checked against the vendor's own source (the az CLI 2.91.0 wheel) or marked UNVERIFIED. Live verification is the owner-supervised **G2** DEV run.

**Path 4 cannot run on the `bootstrap/azure` that is on main today.** Its two identities need two actions that the merged bootstrap does not grant. See [Prerequisites not yet on main](#prerequisites-not-yet-on-main-owner-decision-required).

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

The engine uses two principals. Their variables have the same form as the Azure Terraform identities' (`ALZ_<IDENTITY>_ARM_CLIENT_ID`, `_ARM_TENANT_ID`, `_ARM_SUBSCRIPTION_ID`, `_ARM_USE_OIDC=true`, `_ARM_OIDC_TOKEN_FILE`), so the Azure provider spec's variable checks (`src/apply/providers/azure.ts`) and `checkApplyIdentities` read them as they are. **Their Azure roles are not the bootstrap's.** The roles that `bootstrap/azure` grants on main (DISCOVERY Reader, APPLY Contributor) do not cover this engine. The table below is what the engine needs; [Prerequisites not yet on main](#prerequisites-not-yet-on-main-owner-decision-required) states the gap and the change it needs.

| Identity | Does | Azure permissions the engine needs (not granted on main; see the prerequisites) |
|---|---|---|
| DISCOVERY | `az account show`, `az group show`, the what-if, `az stack group show`; the independent read-back | Reader on the pilot resource group, plus `Microsoft.Resources/deployments/whatIf/action` on it |
| APPLY | `az account show`, `az stack group create`, `az stack group show`, `az stack group delete` | On the pilot resource group only: `Microsoft.Resources/deploymentStacks/*`, `Microsoft.Resources/deploymentStacks/manageDenySetting/action`, `Microsoft.Resources/deployments/*`, `Microsoft.Network/virtualNetworks/*` |

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

The `@` expansion applies to every az argument, and not only at its start: az splits each argument on its first `=` and reads the part after it as a file when it starts with `@`, so `key=@/path` (the shape of a `--tags` value) is a file read too. Each argument list is therefore matched exactly against an allowlist (`isAllowedBicepArgv`) before it runs. No argument may contain `@`, or be one az would expand (`@x` or `key=@x`), except the login's own token slot, which must be `@` followed by an absolute token-file path.

## Prerequisites not yet on main (owner decision required)

`bootstrap/azure` DEV-only mode, as merged, gives DISCOVERY **Reader** and APPLY **Contributor** on the pilot resource group (`bootstrap/azure/modules/environment/main.tf`; `docs/act-pilot-azure-terraform-g0.md`). Neither covers this engine, so **path 4 cannot run on the current bootstrap**:

- **APPLY cannot create the stack.** The built-in Contributor role lists `Microsoft.Resources/deploymentStacks/manageDenySetting/action` among its NotActions, and Microsoft's deployment-stacks documentation says creating a stack's deny assignment needs that action. So `az stack group create --deny-settings-mode denyWriteAndDelete` fails for APPLY as bootstrapped. The engine does not fall back to `none`: deny settings are never off.
- **DISCOVERY cannot run the plan of record.** Reader is `*/read` only and does not include `Microsoft.Resources/deployments/whatIf/action`, which seal step 7 runs as DISCOVERY. Microsoft's template-permissions page says what-if has the same permission requirements as a deployment. How far `--validation-level ProviderNoRbac` relaxes that is unverified.

**Proposed change (the narrowest):** one custom role per identity, assigned **at the pilot resource group only, in DEV only**, that adds exactly one action to what the bootstrap grants today:

| Identity | Keeps | Adds (UNVERIFIED action names, checked at G2) |
|---|---|---|
| APPLY | Contributor on the pilot resource group | `Microsoft.Resources/deploymentStacks/manageDenySetting/action` |
| DISCOVERY | Reader on the pilot resource group | `Microsoft.Resources/deployments/whatIf/action` |

Nothing is added at subscription scope, in QA or PROD, or for any other identity. If G2 shows the what-if needs more under `ProviderNoRbac`, that is a new finding for the owner, not a silent widening.

- **Status:** a permission expansion, so it needs an **owner decision**. The coordinator has put the question to the owner. No PR in this lane changes `bootstrap/azure` roles.
- **Owner:** the owner's decision, then the `bootstrap/azure` lane implements it.
- **Until then:** path 4's G0 and G2 cannot start. The engine and its tests (#316) are synthetic and do not depend on it.

## Contract target

The contract names `provider: AZURE` and `engine: BICEP`. Each environment's target holds the provider's `tenantId` and `subscriptionId`, plus:

- `backend`: the deployment stack's name (`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,88}[A-Za-z0-9_-])?$`: a letter or digit first, so a value never reads as an option, and no trailing `.`). The same name may repeat across environments, because the subscription already differs.
- `workspace`: `default`.
- `resourceGroup`: the existing pilot resource group (#304) that the stack is scoped to.

## Plan (seal)

1. **Check the project.** Copy the snapshot to a private work directory, and require the copy to equal the manifest (`projectDifference`).
2. **Check the tool versions.** `bicep --version` and `az version --output json` must report the pinned versions (`config/tool-pins.json`, `bicep` and `azureCli`). The pinned az version is the manifest's `engineVersion`.
3. **Compile** `main.bicep` with the pinned bicep: `bicep build main.bicep --stdout --no-restore`. No identity is given. With `--no-restore` and an empty home directory, no registry or template-spec module can be fetched, so only local files compile.
4. **Read the compiled ARM JSON** and refuse anything outside the minimal workload:
   - the schema must be exactly `https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#`, the host included;
   - there must be exactly one resource, of type `Microsoft.Network/virtualNetworks`, holding only `type`, `apiVersion`, `name`, `location`, `tags` and `properties`;
   - its properties must be only `addressSpace.addressPrefixes`: the network is empty, so no subnet (and so no delegation), no peering and no `ddosProtectionPlan`;
   - the template may hold only `$schema`, `languageVersion`, `contentVersion`, `metadata`, `parameters`, `variables` and `resources`: no `outputs` and no user `functions`;
   - no `list*` function call (`listKeys` and the like) appears anywhere in the template;
   - there may be no module (`Microsoft.Resources/deployments`), no `existing` resource and no extension resource (`scope`).

   Any other type is `RESOURCE_TYPE_NOT_ALLOWED`, and any other shape is `TEMPLATE_SHAPE_NOT_ALLOWED`. A `Microsoft.Resources/resourceGroups` resource is refused like any other type: the run must not create a group.
5. **Check the resource group** as DISCOVERY (`az group show`). It must already exist (otherwise `RESOURCE_GROUP_NOT_FOUND`). The engine never creates it.
6. **Read the stack** as DISCOVERY (`az stack group show`). If the stack exists, it must be in a final state, carry the deny settings below, and carry exactly the deletion unit's three tags, keys and values (a cleanup, which is given no unit, requires the three keys). Its fingerprint (id, state, last modification, deployment id, managed resources and deny settings) is bound into the seal.
7. **Run the what-if** as DISCOVERY. This is the plan of record:

   ```text
   az deployment group what-if --resource-group <group> --template-file <compiled>
     --result-format FullResourcePayloads --validation-level ProviderNoRbac
     --no-pretty-print --no-prompt true --subscription <sub> --output json
   ```

   - `ProviderNoRbac`, as in the existing preview, checks the template with the provider but not the caller's write permissions, so the read-only DISCOVERY identity can run it.
   - Each change becomes one line of the change list (ARM id, type, action): `Create` is CREATE; `Modify` and `Deploy` are UPDATE; `Delete` is DELETE.
   - `NoChange` and `Ignore` are not changes.
   - `Unsupported`, or any other change type, refuses the seal (`WHATIF_UNSUPPORTED_CHANGE`).
   - Managed resources that the what-if no longer lists are added as DELETE, because the stack's `deleteResources` would delete them.
8. **Check the change list.** The seal is refused for:
   - a type outside the allowlist (`RESOURCE_TYPE_NOT_ALLOWED`);
   - an id outside the contract's subscription and resource group (`WHATIF_NOT_IN_CONTRACT`);
   - a resource that already exists but that the stack does not manage (`RESOURCE_PREEXISTS`): the stack would adopt it, and cleanup would then delete something the run did not create;
   - a created or modified resource without exactly the unit's tags (`UNIT_TAG_MISSING`), read with `readBicepWhatIfTags`;
   - nothing to change (`NO_CHANGES_TO_APPLY`).
9. **Seal the artifact.** The sealed artifact is canonical JSON. It holds the compiled template's exact text and binds:
   - the tenant, subscription, resource group and stack name;
   - the deny settings and the action on unmanage;
   - the template's SHA-256;
   - the change list's hash;
   - the stack fingerprint;
   - the unit tags' hash.

   The unit is sealed with `untagged: []`, because a virtual network takes tags.

## Execute (apply)

`prepare` copies and checks the snapshot again, checks both versions, signs both identities in, and reads the stack as APPLY.

`rederive(artifact)` refuses unless all of the following hold:

- the artifact parses with exactly the record's keys and the contract's values (otherwise `ARTIFACT_TAMPERED`);
- the template text hashes to the sealed hash (otherwise `ARTIFACT_TAMPERED`);
- compiling the snapshot again with the pinned bicep gives the sealed template byte for byte (otherwise `ARTIFACT_TAMPERED`). This is the refusal of any template change after the seal;
- the template passes the checks of seal step 4 again;
- a new what-if as DISCOVERY gives the sealed change list (otherwise `PLAN_STALE`);
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
| FAILED_NO_CHANGE | Positive evidence only: az ran to completion and gave a definite non-zero exit, and at least three reads over the poll window show the stack unmoved. A create with no exit code (a timeout, the output cap or a spawn error) may have reached ARM, so it is never this outcome. |
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
- **Outcome.** `settle` returns SUCCEEDED only when the delete exited 0 with nothing cut off and the stack is gone. It returns FAILED_NO_CHANGE only after a definite non-zero exit and at least three reads over the poll window that show the stack unchanged. A delete stopped by the kill switch or the time limit is KILLED, and any other result is PARTIAL_REQUIRES_REVIEW. A person then confirms each id is gone with the independent read-back.
- **Order with the bootstrap teardown.** The stack cleanup (or `az stack group delete`) must run **before** the bootstrap teardown removes the pilot resource group. A stack left behind keeps its `denyWriteAndDelete` assignment on its resources, applied to child scopes, and that blocks the group's deletion.

## Engine-id admission (not in this lane)

The engine is written against `EngineSpec`, but it is **not registered**. Registering it needs:

- the `BICEP` engine id in `EngineId`;
- the two evidence `mutation` values;
- the `BICEP` manifest engine;
- the contract's DEV-only scope for Azure Bicep.

These belong to the authorization lane (`src/apply/types.ts`, `src/apply/contract.ts`). Until they land:

- `BICEP` is exported with its own narrow type. Registering it is one entry in `SPECS` (`src/apply/engine-spec.ts`).
- Its tests (`test/apply-bicep.test.ts`, added in #316) drive the engine's steps directly with a fake `az` and `bicep`. They do not go through the driver, so the ledger, approvals, requester signature and evidence are not yet exercised for this engine. These shared modules are unchanged and are tested for the other engines.
- The blueprint (`src/observe/blueprint.ts`) and the cleanup proposal's address form (`src/apply/cleanup-proposal.ts`, ARM ids) are wired when the engine is registered.

## Assumptions to verify at G2

- UNVERIFIED (A1): the shape of `az deployment group what-if --no-pretty-print --output json` (`status`, `changes[].resourceId`, `changeType`, `after.type`, `after.tags`). The existing preview and `readBicepWhatIfTags` assume the same shape.
- UNVERIFIED (A2): the error text that tells a missing stack (`DeploymentStackNotFound`) or a missing group (`ResourceGroupNotFound`) apart from a failed read.
- UNVERIFIED (A3): the stack's final states (`succeeded`, `failed`, `canceled`) and its in-progress states.
- UNVERIFIED (A4): that Bicep's output for a resource-group file with one virtual network has the shape described in seal step 4. bicep 0.47.16 was not run here, and the tests use a hand-written template of that shape.
- D1 above.
- UNVERIFIED (A5): that an unregistered `Microsoft.Network` or `Microsoft.Resources` namespace fails the what-if, so the seal is refused.
- UNVERIFIED (P1): the action names in [Prerequisites not yet on main](#prerequisites-not-yet-on-main-owner-decision-required), that Contributor's NotActions block the stack's deny assignment, and which permissions the what-if needs under `ProviderNoRbac`.

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
- `preview:bicep-azure-brownfield`: returns to scope, per the owner's rebaseline (#39, 6443352284).

All evidence produced in this lane is **SYNTHETIC** (a fake `az` and `bicep`). It is not provider qualification and does not certify a release.
