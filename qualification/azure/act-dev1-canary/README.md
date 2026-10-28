# ACT-DEV-1 Azure Terraform canary

The Azure counterpart of the AWS Terraform canary in [`../../aws/act-dev1-canary`](../../aws/act-dev1-canary). It creates **one empty virtual network**: address space `10.250.0.0/24`, no subnets, no peering, no gateway. A virtual network with no subnets has no billable workload. It goes into the **existing pilot resource group** that `bootstrap/azure` creates; the canary never creates, adopts or deletes a resource group. The Bicep canary in [`../act-dev1-bicep-canary`](../act-dev1-bicep-canary) declares the same network.

This folder is an EXAMPLE. Nothing in it enables ACT. The reviewed pilot contract, approvals and every gate in [`docs/act-pilot-plan.md`](../../../docs/act-pilot-plan.md) still apply.

## Pins

- `hashicorp/azurerm` exactly `= 4.81.0`, the version the pilot's denied-type lists were reviewed against.
- `.terraform.lock.hcl` pins that one provider with HashiCorp's `h1:` hashes for `linux_amd64` and `darwin_arm64` (the values in `OFFICIAL_PROVIDER_HASHES`, `src/apply/lockfile.ts`). It was written by `terraform providers lock` (Terraform 1.16.4) from the signature-verified release zips. Keep it unchanged.
- `resource_provider_registrations = "none"`: the plan runs as DISCOVERY, which cannot register providers. `Microsoft.Network` must already be registered (`docs/act-pilot-azure-terraform-g0.md`).
- `backend "azurerm" {}`: the product supplies the backend settings at init. Subscription and tenant come from the identity's `ARM_*` variables, never from the project.

## Inputs the operator supplies

Copy `terraform.tfvars.example.json` to `terraform.tfvars.json` and replace each EXAMPLE value:

| Variable | Rule |
| --- | --- |
| `resource_group_name` | The existing pilot resource group (for example `rg-alz-pilot-dev`). |
| `location` | That group's region. |
| `canary_name` | `vnet-alz-act-dev-1-<name>`. Use a new name for each run. |
| `owner` | The approved owner tag. |
| `unit_tags` | Exactly `alz-managed-by`, `alz-unit` and `alz-build`, with the values `./alz apply prepare` prints. |

## Expected preview

Exactly **1 create**: `azurerm_virtual_network.act_dev1`. Anything else means a changed project or the wrong target. Stop and do not approve.

## Read-back to verify after apply

`az network vnet show --resource-group <group> --name <canary_name>`:

- `provisioningState` is `Succeeded`, and `location` is the group's region;
- `addressSpace.addressPrefixes` is exactly `["10.250.0.0/24"]`;
- `subnets` is empty, and there are no peerings;
- the tags are `environment=DEV`, `managed-by=sovereign-alz`, `purpose=act-dev-1`, `owner=<owner>` plus the three unit tags.

## Cleanup

The governed cleanup removes the virtual network, the only resource the run created. The pilot resource group is retained (`RETAINED_GROUP`, `src/apply/cleanup-proposal.ts`); the bootstrap teardown removes it. After cleanup, the read-back above must report the network as not found.

## Tests

`test/act-dev1-azure-canary.test.ts` (SYNTHETIC): one resource block, the pin, the provider settings, the single lock entry with the official hashes, and the same lock and input readers `./alz apply prepare` uses. With `ALZ_CANARY_TERRAFORM` (the pinned Terraform) and `TF_CLI_CONFIG_FILE` (an offline azurerm 4.81.0 mirror), it also runs `fmt -check`, `init -backend=false -lockfile=readonly` and `validate`.

`test/act-dev1-terraform-unit-tags.test.ts` (SYNTHETIC) seals this canary, and the AWS Terraform canary, through the real driver and Terraform engine with the fake `terraform`. It uses the unit tags exactly as prepare derives them. The seal-time unit check passes with exactly one create. Without `unit_tags`, the same seal is refused with `UNIT_TAG_MISSING`.
