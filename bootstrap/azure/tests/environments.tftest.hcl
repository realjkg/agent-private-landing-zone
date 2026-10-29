# Offline, synthetic: mocked providers, plan only. No credential, no cloud call, nothing created.
# Run from bootstrap/azure: terraform init -backend=false && terraform test
# It proves the configuration's own wiring (what is created per mode and what is refused), not Azure behavior.

mock_provider "azuread" {}

mock_provider "azurerm" {
  alias = "dev"
}

mock_provider "azurerm" {
  alias = "qa"
}

mock_provider "azurerm" {
  alias = "prod"
}

variables {
  tenant_id               = "00000000-0000-0000-0000-000000000000"
  location                = "eastus2"
  state_allowed_ip_ranges = ["203.0.113.10"]

  environments = {
    DEV  = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", apply_resource_group_name = "rg-pilot-dev" }
    QA   = { subscription_id = "00000000-0000-0000-0000-000000000002", state_resource_group_name = "rg-state-qa", state_storage_account_name = "examplestateqa", apply_resource_group_name = "rg-pilot-qa" }
    PROD = { subscription_id = "00000000-0000-0000-0000-000000000003", state_resource_group_name = "rg-state-prod", state_storage_account_name = "examplestateprod", apply_resource_group_name = "rg-pilot-prod" }
  }

  oidc_subjects = {
    DISCOVERY   = { DEV = "repo:o/r:environment:dev-discovery", QA = "repo:o/r:environment:qa-discovery", PROD = "repo:o/r:environment:prod-discovery" }
    STATE       = { DEV = "repo:o/r:environment:dev-state", QA = "repo:o/r:environment:qa-state", PROD = "repo:o/r:environment:prod-state" }
    STATE_WRITE = { DEV = "repo:o/r:environment:dev-state-write", QA = "repo:o/r:environment:qa-state-write", PROD = "repo:o/r:environment:prod-state-write" }
    APPLY       = { DEV = "repo:o/r:environment:dev-apply", QA = "repo:o/r:environment:qa-apply", PROD = "repo:o/r:environment:prod-apply" }
  }
}

# --- the default: the three-stage chain, unchanged -------------------------------------------------------------------

run "chain_is_the_default" {
  command = plan

  assert {
    condition     = var.enabled_environments == tolist(["DEV", "QA", "PROD"])
    error_message = "The default must stay the three-stage chain."
  }
  assert {
    condition     = length(azuread_application.identity) == 4 && length(azuread_application_federated_identity_credential.identity) == 12
    error_message = "The chain has four identities with one federated credential per environment (twelve)."
  }
  assert {
    condition     = length(module.environment_qa) == 1 && length(module.environment_prod) == 1
    error_message = "The chain creates the QA and PROD environments."
  }
  assert {
    condition     = keys(output.contract_targets) == ["DEV", "PROD", "QA"] && output.contract_targets.QA.backend == "examplestateqa/tfstate/qa.tfstate"
    error_message = "The chain outputs a contract target per environment."
  }
}

run "chain_refuses_a_shared_subscription" {
  command = plan
  variables {
    environments = {
      DEV  = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev" }
      QA   = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-qa", state_storage_account_name = "examplestateqa" }
      PROD = { subscription_id = "00000000-0000-0000-0000-000000000003", state_resource_group_name = "rg-state-prod", state_storage_account_name = "examplestateprod" }
    }
  }
  expect_failures = [var.environments]
}

run "chain_refuses_a_shared_state_account" {
  command = plan
  variables {
    environments = {
      DEV  = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev" }
      QA   = { subscription_id = "00000000-0000-0000-0000-000000000002", state_resource_group_name = "rg-state-qa", state_storage_account_name = "examplestatedev" }
      PROD = { subscription_id = "00000000-0000-0000-0000-000000000003", state_resource_group_name = "rg-state-prod", state_storage_account_name = "examplestateprod" }
    }
  }
  expect_failures = [var.environments]
}

run "chain_refuses_a_missing_environment" {
  command = plan
  variables {
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev" }
      QA  = { subscription_id = "00000000-0000-0000-0000-000000000002", state_resource_group_name = "rg-state-qa", state_storage_account_name = "examplestateqa" }
    }
  }
  expect_failures = [var.environments]
}

# --- DEV-only mode ------------------------------------------------------------------------------------------------

run "dev_only_creates_dev_alone_with_the_same_controls" {
  command = plan
  variables {
    enabled_environments = ["DEV"]
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", apply_resource_group_name = "rg-pilot-dev" }
    }
    oidc_subjects = {
      DISCOVERY   = { DEV = "repo:o/r:environment:dev-discovery" }
      STATE       = { DEV = "repo:o/r:environment:dev-state" }
      STATE_WRITE = { DEV = "repo:o/r:environment:dev-state-write" }
      APPLY       = { DEV = "repo:o/r:environment:dev-apply" }
    }
  }

  assert {
    condition     = length(module.environment_qa) == 0 && length(module.environment_prod) == 0
    error_message = "DEV-only mode creates nothing for QA or PROD."
  }
  # The four identities stay four separate app registrations, each with exactly one federated credential (its DEV subject).
  assert {
    condition     = length(azuread_application.identity) == 4 && length(azuread_service_principal.identity) == 4
    error_message = "DEV-only mode keeps the four separate identities."
  }
  assert {
    condition     = toset(keys(azuread_application_federated_identity_credential.identity)) == toset(["APPLY/DEV", "DISCOVERY/DEV", "STATE/DEV", "STATE_WRITE/DEV"])
    error_message = "DEV-only mode creates one federated credential per identity, for DEV only."
  }
  assert {
    condition     = length(distinct([for c in azuread_application_federated_identity_credential.identity : c.subject])) == 4
    error_message = "Each identity keeps its own subject."
  }
  # Entra-only state: no shared key, OAuth by default, no public blobs, deny-by-default network, TLS 1.2, versioning.
  assert {
    condition = (
      module.environment_dev.controls.shared_access_key_enabled == false &&
      module.environment_dev.controls.default_to_oauth_authentication == true &&
      module.environment_dev.controls.allow_nested_items_to_be_public == false &&
      module.environment_dev.controls.min_tls_version == "TLS1_2" &&
      module.environment_dev.controls.network_default_action == "Deny" &&
      module.environment_dev.controls.versioning_enabled == true
    )
    error_message = "DEV-only mode keeps every state account control."
  }
  assert {
    condition = (
      module.environment_dev.controls.roles.STATE == "Storage Blob Data Reader" &&
      module.environment_dev.controls.roles.STATE_WRITE == "Storage Blob Data Contributor" &&
      module.environment_dev.controls.roles.DISCOVERY == "Reader" &&
      module.environment_dev.controls.roles.APPLY == "alz-pilot-apply-00000000-0000-0000-0000-000000000001-rg-pilot-dev"
    )
    error_message = "DEV-only mode keeps the separated roles: APPLY holds its custom role, never Contributor."
  }
  assert {
    condition     = output.enabled_environments == tolist(["DEV"]) && keys(output.contract_targets) == ["DEV"] && keys(output.apply_scopes) == ["DEV"]
    error_message = "DEV-only mode outputs the DEV target alone."
  }
  assert {
    condition = output.contract_targets.DEV == {
      tenantId       = "00000000-0000-0000-0000-000000000000"
      subscriptionId = "00000000-0000-0000-0000-000000000001"
      backend        = "examplestatedev/tfstate/dev.tfstate"
      workspace      = "default"
      location       = "eastus2"
    }
    error_message = "The DEV contract target is the contract's targets.DEV, with its authorized location."
  }
}

run "dev_only_refuses_a_qa_or_prod_entry" {
  command = plan
  variables {
    enabled_environments = ["DEV"]
    oidc_subjects = {
      DISCOVERY   = { DEV = "repo:o/r:environment:dev-discovery" }
      STATE       = { DEV = "repo:o/r:environment:dev-state" }
      STATE_WRITE = { DEV = "repo:o/r:environment:dev-state-write" }
      APPLY       = { DEV = "repo:o/r:environment:dev-apply" }
    }
  }
  expect_failures = [var.environments]
}

run "dev_only_refuses_a_qa_or_prod_subject" {
  command = plan
  variables {
    enabled_environments = ["DEV"]
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", apply_resource_group_name = "rg-pilot-dev" }
    }
  }
  expect_failures = [var.oidc_subjects]
}

run "dev_only_refuses_a_shared_dev_subject" {
  command = plan
  variables {
    enabled_environments = ["DEV"]
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", apply_resource_group_name = "rg-pilot-dev" }
    }
    oidc_subjects = {
      DISCOVERY   = { DEV = "repo:o/r:environment:dev-apply" }
      STATE       = { DEV = "repo:o/r:environment:dev-state" }
      STATE_WRITE = { DEV = "repo:o/r:environment:dev-state-write" }
      APPLY       = { DEV = "repo:o/r:environment:dev-apply" }
    }
  }
  expect_failures = [var.oidc_subjects]
}

run "only_dev_or_the_full_chain_is_accepted" {
  command = plan
  variables {
    enabled_environments = ["DEV", "QA"]
  }
  expect_failures = [var.enabled_environments]
}

run "qa_alone_is_refused" {
  command = plan
  variables {
    enabled_environments = ["QA"]
  }
  expect_failures = [var.enabled_environments]
}

run "a_repeated_environment_is_refused" {
  command = plan
  variables {
    enabled_environments = ["DEV", "DEV"]
  }
  expect_failures = [var.enabled_environments]
}

run "dev_only_refuses_a_missing_pilot_group" {
  command = plan
  variables {
    enabled_environments = ["DEV"]
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev" }
    }
    oidc_subjects = {
      DISCOVERY   = { DEV = "repo:o/r:environment:dev-discovery" }
      STATE       = { DEV = "repo:o/r:environment:dev-state" }
      STATE_WRITE = { DEV = "repo:o/r:environment:dev-state-write" }
      APPLY       = { DEV = "repo:o/r:environment:dev-apply" }
    }
  }
  expect_failures = [var.environments]
}

run "dev_only_refuses_a_blank_pilot_group" {
  command = plan
  variables {
    enabled_environments = ["DEV"]
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", apply_resource_group_name = "  " }
    }
    oidc_subjects = {
      DISCOVERY   = { DEV = "repo:o/r:environment:dev-discovery" }
      STATE       = { DEV = "repo:o/r:environment:dev-state" }
      STATE_WRITE = { DEV = "repo:o/r:environment:dev-state-write" }
      APPLY       = { DEV = "repo:o/r:environment:dev-apply" }
    }
  }
  expect_failures = [var.environments]
}

# Owner decision of 2026-10-28 ("Azure APPLY role"): no subscription-wide Contributor, and no subscription-wide replacement. The chain
# now needs a pilot group in every environment too: one missing anywhere is refused, never a fallback to the subscription.
run "chain_refuses_a_missing_pilot_group" {
  command = plan
  variables {
    environments = {
      DEV  = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", apply_resource_group_name = "rg-pilot-dev" }
      QA   = { subscription_id = "00000000-0000-0000-0000-000000000002", state_resource_group_name = "rg-state-qa", state_storage_account_name = "examplestateqa" }
      PROD = { subscription_id = "00000000-0000-0000-0000-000000000003", state_resource_group_name = "rg-state-prod", state_storage_account_name = "examplestateprod", apply_resource_group_name = "rg-pilot-prod" }
    }
  }
  expect_failures = [var.environments]
}

run "chain_scopes_every_environment_to_its_pilot_group" {
  command = plan

  assert {
    condition = (
      module.environment_dev.controls.roles.APPLY == "alz-pilot-apply-00000000-0000-0000-0000-000000000001-rg-pilot-dev" &&
      module.environment_qa[0].controls.roles.APPLY == "alz-pilot-apply-00000000-0000-0000-0000-000000000002-rg-pilot-qa" &&
      module.environment_prod[0].controls.roles.APPLY == "alz-pilot-apply-00000000-0000-0000-0000-000000000003-rg-pilot-prod" &&
      alltrue([for m in [module.environment_dev, module.environment_qa[0], module.environment_prod[0]] : m.controls.roles.DISCOVERY == "Reader"])
    )
    error_message = "In the chain, APPLY holds its own custom role in each environment's pilot group, and DISCOVERY holds Reader."
  }
}

# --- APPLY's custom role (owner decision of 2026-10-28) -------------------------------------------------------------------

# The environment module on its own, with literal principal ids so "assigned to APPLY only" is checked against a known value, and the
# pilot group's id given at plan time (the mock leaves it unknown otherwise). Plan only: nothing is created anywhere.
run "apply_role_is_exact_and_scoped_to_the_pilot_group" {
  command = plan
  module {
    source = "./modules/environment"
  }
  providers = {
    azurerm = azurerm.dev
  }
  variables {
    settings       = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", state_container_name = "tfstate", apply_resource_group_name = "rg-pilot-dev" }
    principal_ids  = { DISCOVERY = "11111111-0000-4000-8000-00000000d15c", STATE = "11111111-0000-4000-8000-000000057a7e", STATE_WRITE = "11111111-0000-4000-8000-0000057a7e33", APPLY = "11111111-0000-4000-8000-0000000a9971" }
    retention_days = 30
    replication    = "ZRS"
    tags           = {}
  }
  override_resource {
    target          = azurerm_resource_group.apply
    override_during = plan
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev"
    }
  }

  assert {
    condition = toset(azurerm_role_definition.apply.permissions[0].actions) == toset([
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/virtualNetworks/write",
      "Microsoft.Network/virtualNetworks/delete",
    ]) && length(azurerm_role_definition.apply.permissions[0].actions) == 3
    error_message = "APPLY's role holds exactly the canary's virtual network read, write and delete."
  }
  assert {
    condition = (
      length(azurerm_role_definition.apply.permissions[0].not_actions) == 0 &&
      length(coalesce(azurerm_role_definition.apply.permissions[0].data_actions, [])) == 0 &&
      alltrue([for a in azurerm_role_definition.apply.permissions[0].actions : !startswith(lower(a), "microsoft.authorization/") && !strcontains(a, "*") && !startswith(lower(a), "microsoft.resources/subscriptions/resourcegroups/")])
    )
    error_message = "No Microsoft.Authorization action, no resource group action, no data action and no wildcard."
  }
  assert {
    condition = (
      azurerm_role_definition.apply.scope == "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev" &&
      azurerm_role_definition.apply.assignable_scopes == tolist(["/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev"]) &&
      azurerm_role_assignment.apply.scope == "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev"
    )
    error_message = "APPLY's role is defined, assignable and assigned at the pilot resource group only (the assignment names the custom role by id, never a built-in role by name: test/bootstrap-azure.test.ts)."
  }
  assert {
    condition     = azurerm_role_assignment.apply.principal_id == "11111111-0000-4000-8000-0000000a9971" && azurerm_role_assignment.discovery.role_definition_name == "Reader"
    error_message = "Only APPLY holds the custom role; DISCOVERY keeps the built-in Reader."
  }
}

# The module's own pilot-group rule: no environment module, in any mode, scopes APPLY or DISCOVERY to the subscription.
run "apply_role_refuses_a_missing_pilot_group_in_the_module" {
  command = plan
  module {
    source = "./modules/environment"
  }
  providers = {
    azurerm = azurerm.dev
  }
  variables {
    settings       = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", state_container_name = "tfstate" }
    principal_ids  = { DISCOVERY = "11111111-0000-4000-8000-00000000d15c", STATE = "11111111-0000-4000-8000-000000057a7e", STATE_WRITE = "11111111-0000-4000-8000-0000057a7e33", APPLY = "11111111-0000-4000-8000-0000000a9971" }
    retention_days = 30
    replication    = "ZRS"
    tags           = {}
  }
  expect_failures = [var.settings]
}

# --- Azure Bicep (DEV only; owner decision E2) ---------------------------------------------------------------------

run "bicep_is_off_by_default" {
  command = plan

  assert {
    condition     = length(module.environment_dev.controls.bicep_stack_role) == 0
    error_message = "No Bicep stack role exists unless the owner turns the Bicep path on."
  }
}

# The environment module on its own, with literal principal ids so "assigned to APPLY only" is checked against a known value, and
# the pilot group's id given at plan time (the mock leaves it unknown otherwise). Plan only: nothing is created anywhere.
run "bicep_role_is_exact_and_scoped_to_the_dev_pilot_group" {
  command = plan
  module {
    source = "./modules/environment"
  }
  providers = {
    azurerm = azurerm.dev
  }
  variables {
    settings         = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", state_container_name = "tfstate", apply_resource_group_name = "rg-pilot-dev" }
    principal_ids    = { DISCOVERY = "11111111-0000-4000-8000-00000000d15c", STATE = "11111111-0000-4000-8000-000000057a7e", STATE_WRITE = "11111111-0000-4000-8000-0000057a7e33", APPLY = "11111111-0000-4000-8000-0000000a9971" }
    retention_days   = 30
    replication      = "ZRS"
    tags             = {}
    bicep_stack_role = true
  }
  override_resource {
    target          = azurerm_resource_group.apply
    override_during = plan
    values = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev"
    }
  }

  assert {
    condition     = length(azurerm_role_definition.bicep_stack_apply) == 1 && length(azurerm_role_assignment.bicep_stack_apply) == 1
    error_message = "The DEV pilot group gets exactly one Bicep stack role and one assignment."
  }
  assert {
    condition = toset(azurerm_role_definition.bicep_stack_apply[0].permissions[0].actions) == toset([
      "Microsoft.Resources/deployments/read",
      "Microsoft.Resources/deployments/write",
      "Microsoft.Resources/deployments/operationstatuses/read",
      "Microsoft.Resources/deployments/validate/action",
      "Microsoft.Resources/deployments/whatIf/action",
      "Microsoft.Resources/deploymentStacks/read",
      "Microsoft.Resources/deploymentStacks/write",
      "Microsoft.Resources/deploymentStacks/delete",
      "Microsoft.Resources/deploymentStacks/validate/action",
      "Microsoft.Resources/deploymentStacks/manageDenySetting/action",
      "Microsoft.Network/virtualNetworks/read",
      "Microsoft.Network/virtualNetworks/write",
      "Microsoft.Network/virtualNetworks/delete",
    ]) && length(azurerm_role_definition.bicep_stack_apply[0].permissions[0].actions) == 13
    error_message = "The Bicep stack role holds exactly the engine's operations: what-if, deployment stacks with manageDenySetting, the virtual network."
  }
  assert {
    condition = (
      length(azurerm_role_definition.bicep_stack_apply[0].permissions[0].not_actions) == 0 &&
      length(coalesce(azurerm_role_definition.bicep_stack_apply[0].permissions[0].data_actions, [])) == 0 &&
      alltrue([for a in azurerm_role_definition.bicep_stack_apply[0].permissions[0].actions : !startswith(a, "Microsoft.Authorization/") && !strcontains(a, "*")])
    )
    error_message = "No Microsoft.Authorization action, no data action and no wildcard."
  }
  assert {
    condition = (
      azurerm_role_definition.bicep_stack_apply[0].scope == "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev" &&
      azurerm_role_definition.bicep_stack_apply[0].assignable_scopes == tolist(["/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev"]) &&
      azurerm_role_assignment.bicep_stack_apply[0].scope == "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-pilot-dev"
    )
    error_message = "The role is defined, assignable and assigned at the DEV pilot resource group only, never at subscription scope."
  }
  assert {
    condition     = azurerm_role_assignment.bicep_stack_apply[0].principal_id == "11111111-0000-4000-8000-0000000a9971"
    error_message = "Only APPLY holds the Bicep stack role."
  }
  assert {
    condition = (
      azurerm_role_assignment.discovery.role_definition_name == "Reader" && azurerm_role_assignment.discovery.principal_id == "11111111-0000-4000-8000-00000000d15c" &&
      length(azurerm_role_definition.apply.permissions[0].actions) == 3 && azurerm_role_assignment.apply.principal_id == "11111111-0000-4000-8000-0000000a9971"
    )
    error_message = "DISCOVERY stays Reader (no what-if, deployment or deny-setting authority) and APPLY holds its custom role, never Contributor."
  }
}

run "bicep_refuses_the_three_stage_chain" {
  command = plan
  variables {
    bicep_deployment_stacks = true
  }
  expect_failures = [var.bicep_deployment_stacks]
}

run "bicep_refuses_dev_without_a_pilot_group" {
  command = plan
  variables {
    enabled_environments    = ["DEV"]
    bicep_deployment_stacks = true
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev" }
    }
    oidc_subjects = {
      DISCOVERY   = { DEV = "repo:o/r:environment:dev-discovery" }
      STATE       = { DEV = "repo:o/r:environment:dev-state" }
      STATE_WRITE = { DEV = "repo:o/r:environment:dev-state-write" }
      APPLY       = { DEV = "repo:o/r:environment:dev-apply" }
    }
  }
  # DEV-only mode already requires the pilot group (dev_only_refuses_a_missing_pilot_group), so the Bicep role can never fall
  # back to the subscription.
  expect_failures = [var.environments]
}

# The module's own pilot-group rule (review of #332, N5): asked for the Bicep stack role without a pilot resource group, the
# environment module refuses, so the role can never be defined or assigned at subscription scope, whatever the caller passes.
run "bicep_role_refuses_a_missing_pilot_group_in_the_module" {
  command = plan
  module {
    source = "./modules/environment"
  }
  providers = {
    azurerm = azurerm.dev
  }
  variables {
    settings         = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev", state_container_name = "tfstate" }
    principal_ids    = { DISCOVERY = "11111111-0000-4000-8000-00000000d15c", STATE = "11111111-0000-4000-8000-000000057a7e", STATE_WRITE = "11111111-0000-4000-8000-0000057a7e33", APPLY = "11111111-0000-4000-8000-0000000a9971" }
    retention_days   = 30
    replication      = "ZRS"
    tags             = {}
    bicep_stack_role = true
  }
  # Still refused, now first by the module's own pilot-group rule for every environment (owner decision of 2026-10-28), which
  # Terraform reports before it reaches the Bicep role's rule; that rule stays as a second guard.
  expect_failures = [var.settings]
}
