# IDs, names and paths only. Nothing here is a secret. bootstrap/config.gcp.template.json says where each value goes.
output "service_account_emails" {
  description = "ALZ_<IDENTITY>_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT for this environment: the attested principals."
  value       = local.emails
}

output "workload_identity_audience" {
  description = "The audience of every credential configuration: the pool provider's full resource name."
  value       = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.oidc.name}"
}

output "credential_configurations" {
  description = "Per identity, the credential configuration file to write on the runner and name in ALZ_<IDENTITY>_GOOGLE_APPLICATION_CREDENTIALS. Exactly the shape the G0 package requires and the S1 provider spec (src/apply/providers/gcp.ts) checks: an external_account file source, no key, token or impersonation URL of its own."
  value = { for i in local.identities : i => jsonencode({
    type               = "external_account"
    audience           = "//iam.googleapis.com/${google_iam_workload_identity_pool_provider.oidc.name}"
    subject_token_type = "urn:ietf:params:oauth:token-type:jwt"
    token_url          = "https://sts.googleapis.com/v1/token"
    credential_source  = { file = var.token_files[i] }
  }) }
}

output "identity_variables" {
  description = "Per identity, the ALZ_<IDENTITY>_GOOGLE_* values other than the credential configuration path, which the owner chooses on the runner."
  value = { for i in local.identities : i => {
    GOOGLE_IMPERSONATE_SERVICE_ACCOUNT = local.emails[i]
    GOOGLE_PROJECT                     = var.project_id
    GOOGLE_REGION                      = var.region
  } }
}

output "contract_target" {
  description = "This environment's entry in the contract's targets block. GCP_API keeps no state, so its target is the project alone."
  value = { for key, value in {
    projectId = var.project_id
    region    = var.region
    backend   = "${coalesce(var.state_bucket_name, "unused")}/${local.state_prefix}"
    workspace = "default"
  } : key => value if local.terraform || key == "projectId" }
}
