output "container_name" {
  value = azurerm_storage_container.state.name
}

output "apply_scope" {
  value = local.apply_scope
}
