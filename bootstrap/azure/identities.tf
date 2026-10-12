locals {
  identities   = toset(["DISCOVERY", "STATE", "STATE_WRITE", "APPLY"])
  environments = toset(["DEV", "QA", "PROD"])
  # One client per identity for every subscription: the Azure provider spec expects the same client ids in every environment.
  federated_credentials = {
    for pair in setproduct(local.identities, local.environments) :
    "${pair[0]}/${pair[1]}" => { identity = pair[0], environment = pair[1] }
  }
}

resource "azuread_application" "identity" {
  for_each         = local.identities
  display_name     = "${var.name_prefix}-${lower(replace(each.key, "_", "-"))}"
  sign_in_audience = "AzureADMyOrg"
}

resource "azuread_service_principal" "identity" {
  for_each  = local.identities
  client_id = azuread_application.identity[each.key].client_id
}

# Trust is bound to the issuer, the audience and one exact subject. No client secret or certificate is ever created.
resource "azuread_application_federated_identity_credential" "identity" {
  for_each       = local.federated_credentials
  application_id = azuread_application.identity[each.value.identity].id
  display_name   = lower("${replace(each.value.identity, "_", "-")}-${each.value.environment}")
  description    = "ACT pilot ${each.value.identity} in ${each.value.environment}"
  audiences      = [var.oidc_audience]
  issuer         = var.oidc_issuer
  subject        = var.oidc_subjects[each.value.identity][each.value.environment]
}
