# ACT pilot bootstrap

**Offline-validated only; unverified until run by an account owner.** `fmt`, `init -backend=false` and `validate` pass with the provider versions named in `docs/act-pilot-bootstrap.md`, which checks names against the provider schemas and nothing about real cloud behavior. These templates have never created a resource. Read `docs/act-pilot-bootstrap.md` before running anything.

This is an owner-run, one-time provisioning package. It is separate from the pilot apply: nothing under `src/` references it, `./alz apply` never runs it, and it never enables ACT. The contract stays `enabled: false` and its pin stays empty; bootstrap only produces the identifiers the owner then reviews into `config/act-pilot-contract.json`.

| Path | Provisions |
| --- | --- |
| `azure/` | Four Entra app registrations (DISCOVERY, STATE, STATE_WRITE, APPLY) with subject-bound federated credentials, the state storage account and container per environment, and the role assignments |
| `aws/` | Per account: the OIDC provider, the web-identity roles for the chosen engine (Terraform: four, CDK: three), and for Terraform the state bucket and its policy |
| `gcp/` | Per project and engine (TERRAFORM: DEV, QA and PROD; GCP_API: DEV only): a workload identity pool and OIDC provider, the engine's service accounts with one federated subject each and no key, the minimal Pub/Sub workload grants, for TERRAFORM the state bucket and its bucket-level grants, and the key-creation org policy and deny guardrails. Runbook: `docs/act-pilot-bootstrap-gcp.md` |
| `config.azure.template.json`, `config.aws.template.json`, `config.gcp.template.json` | Where each output goes in the contract and in the `ALZ_<IDENTITY>_<VAR>` variables. Identifiers and paths only |

## Why Terraform for both clouds

- The pilot's Terraform engine already requires Terraform (1.10 or later for `use_lockfile`), so the owner needs no second toolchain.
- The AWS trust policies need condition keys built from the issuer (`<issuer-host>:sub`). CloudFormation cannot build a map key from a parameter, so a template would hard-code the issuer, and a self-hosted runner issuer would need a different template.
- Azure needs Entra objects (app registrations and federated credentials) next to role assignments in three subscriptions. Terraform's `azuread` provider does that in one plan; Bicep would need its Microsoft Graph extension (from memory, preview when this was written).
- The cost is that the bootstrap itself has Terraform state (local, no secrets, identifiers only). `.gitignore` here keeps it out of version control.
