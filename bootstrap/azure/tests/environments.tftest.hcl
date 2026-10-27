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
      module.environment_dev.controls.roles.APPLY == "Contributor"
    )
    error_message = "DEV-only mode keeps the separated roles."
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
    }
    error_message = "The DEV contract target is the contract's targets.DEV."
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
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev" }
    }
  }
  expect_failures = [var.oidc_subjects]
}

run "dev_only_refuses_a_shared_dev_subject" {
  command = plan
  variables {
    enabled_environments = ["DEV"]
    environments = {
      DEV = { subscription_id = "00000000-0000-0000-0000-000000000001", state_resource_group_name = "rg-state-dev", state_storage_account_name = "examplestatedev" }
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
