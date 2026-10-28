# ACT-DEV-1 Azure Bicep canary

The Bicep counterpart of the Azure Terraform canary in [`../act-dev1-canary`](../act-dev1-canary). It declares the same **one empty virtual network**: address space `10.250.0.0/24`, no subnets, the same tags. It is deployed as a deployment stack into the **existing pilot resource group** and never creates one.

This folder is an EXAMPLE. Nothing in it enables ACT. The reviewed pilot contract, approvals and every gate in [`docs/act-pilot-plan.md`](../../../docs/act-pilot-plan.md) still apply.

## What is committed

| File | Purpose |
| --- | --- |
| `main.bicep` | The project's entry file, which the Bicep engine compiles itself (`bicep build main.bicep --stdout --no-restore`). |
| `main.json` | The same template compiled with the pinned Bicep 0.47.16, for review and for the test. The engine does not read it. |

The compiled template has exactly one resource, of type `Microsoft.Network/virtualNetworks` (API `2024-05-01`), holding only `type`, `apiVersion`, `name`, `location`, `tags` and `properties.addressSpace.addressPrefixes`. It has no module, no `existing` resource, no outputs and no `list*` call, and its tags and address prefix are literal, so it passes the engine's seal-time check (`checkTemplate`, `src/apply/engines/bicep.ts`). Its one resource is exactly the canary allowlist an Azure Bicep contract names: `{ "resources": [{ "type": "Microsoft.Network/virtualNetworks", "count": 1 }] }`.

## Inputs the operator supplies

The engine passes no parameter values, so each parameter has a default. Edit `main.bicep` for each run:

| Value | Rule |
| --- | --- |
| `name` (parameter) | `vnet-alz-act-dev-1-<name>`. Use a new name for each run. EXAMPLE default: `vnet-alz-act-dev-1-canary-01`. |
| `location` (parameter) | Defaults to the pilot resource group's region. Leave it. The reviewed contract's target names that region as `location` (the operator supplies it, for example `eastus2`); the seal and the apply refuse unless the group is in it and the what-if places the network there (`LOCATION_NOT_IN_CONTRACT`). |
| `owner` tag | The approved owner tag. EXAMPLE value: `REPLACE-WITH-APPROVED-OWNER`. |
| `alz-build`, `alz-managed-by`, `alz-unit` tags | The values `./alz apply prepare` prints. The engine refuses a created resource without them (`UNIT_TAG_MISSING`). |

The tags are written as literal strings in `main.bicep`, not passed as parameters: the engine refuses tags or address prefixes that compile to an ARM expression (`TEMPLATE_VALUE_NOT_LITERAL`), so what is deployed is exactly the sealed text.

The subscription, the resource group, the location and the stack name come from the reviewed contract's target (`config/act-pilot-contract.azure-bicep-dev.example.json`).

## Expected preview

Exactly **1 create**: one `Microsoft.Network/virtualNetworks` resource in the pilot resource group, carrying the unit tags. Anything else means a changed project or the wrong target. Stop and do not approve.

## Read-back to verify after apply

- `az stack group show --name <stack> --resource-group <group>` shows one managed resource, the network, and the deny settings `denyWriteAndDelete`.
- `az network vnet show --resource-group <group> --name <name>`: `provisioningState` is `Succeeded`, `addressSpace.addressPrefixes` is exactly `["10.250.0.0/24"]`, `subnets` is empty, and the tags are `environment=DEV`, `managed-by=sovereign-alz`, `purpose=act-dev-1`, `owner=<owner>` plus the three unit tags.

## Cleanup

Cleanup is whole-stack only (`docs/act-pilot-bicep.md`, "Cleanup"): `az stack group delete ... --action-on-unmanage deleteResources` deletes the network, and the stack manages no resource group, so the pilot group stays. Run it before the bootstrap teardown removes the group. After cleanup, the network read-back must report not found.

## Tests

`test/act-dev1-bicep-canary.test.ts` (SYNTHETIC): the compiled template passes the engine's own `checkTemplate`, and the same check refuses a subnet, a second resource or another type. With `ALZ_BICEP` naming the pinned Bicep, it also recompiles `main.bicep` and requires the committed `main.json` byte for byte. The test also seals the template through the Bicep engine's plan step with the fake `az` and `bicep`. The test puts the operator's values in the way ARM would, and the unit check passes with prepare's unit tags. With the committed placeholder unit tags, the seal is refused with `UNIT_TAG_MISSING`; tags written as an ARM expression are refused with `TEMPLATE_VALUE_NOT_LITERAL`.
