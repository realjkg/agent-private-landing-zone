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
  description = "This environment's entry in the contract's targets block, in decision D9's shape. TERRAFORM: the project, region, state bucket and prefix, workspace and the one-topic canary. GCP_API: the same with the no-state sentinel backend and the topic prefix. parent appears only when set, and is owner-declared, not observed."
  value = merge(
    {
      projectId = var.project_id
      region    = var.region
      backend   = local.api ? "GCP_API_NO_STATE" : "${coalesce(var.state_bucket_name, "unused")}/${local.state_prefix}"
      workspace = "default"
      canary    = { resources = [{ type = "google_pubsub_topic", count = 1 }] }
    },
    var.parent == null ? {} : { parent = var.parent },
    local.api ? { topicPrefix = var.topic_prefix } : {},
  )
}

output "contract_settings" {
  description = "Contract settings this bootstrap requires besides the target. TERRAFORM: embedStateWrite = true, or the plan leaves the gcs backend's credentials to the APPLY process, which the deny policy here forbids every Cloud Storage object (EMULATED finding, test/apply-emulated-gcp.test.ts)."
  value       = merge({ enabledEnvironments = ["DEV"] }, local.terraform ? { embedStateWrite = true } : {})
}
