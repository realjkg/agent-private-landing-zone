output "container_name" {
  value = azurerm_storage_container.state.name
}

output "apply_scope" {
  value = local.apply_scope
}

# The state account's security settings and each identity's role, as configured, so the offline tests
# (tests/environments.tftest.hcl) can prove both modes keep them. Names and settings only; nothing secret.
output "controls" {
  value = {
    shared_access_key_enabled       = azurerm_storage_account.state.shared_access_key_enabled
    default_to_oauth_authentication = azurerm_storage_account.state.default_to_oauth_authentication
    allow_nested_items_to_be_public = azurerm_storage_account.state.allow_nested_items_to_be_public
    min_tls_version                 = azurerm_storage_account.state.min_tls_version
    network_default_action          = azurerm_storage_account.state.network_rules[0].default_action
    versioning_enabled              = azurerm_storage_account.state.blob_properties[0].versioning_enabled
    roles = {
      STATE       = azurerm_role_assignment.state.role_definition_name
      STATE_WRITE = azurerm_role_assignment.state_write.role_definition_name
      DISCOVERY   = azurerm_role_assignment.discovery.role_definition_name
      APPLY       = azurerm_role_assignment.apply.role_definition_name
    }
    # The Bicep path's custom role (owner decision E2): where it is defined, where it may be assigned, where it is assigned, and
    # exactly its actions. Empty when the Bicep path is off.
    bicep_stack_role = [for i, d in azurerm_role_definition.bicep_stack_apply : {
      scope             = d.scope
      assignable_scopes = d.assignable_scopes
      actions           = d.permissions[0].actions
      not_actions       = d.permissions[0].not_actions
      assigned_scope    = azurerm_role_assignment.bicep_stack_apply[i].scope
      assigned_to       = azurerm_role_assignment.bicep_stack_apply[i].principal_id
    }]
  }
}
