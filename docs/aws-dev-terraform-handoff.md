# Sovereign ALZ — multicloud application landing zone contract

**End state:** one governed multicloud application landing zone builder for AWS, Azure, GCP and private environments. Shared lifecycle: identity verification, inventory, brownfield/greenfield selection, isolated scope, governance, cost and credit checks, engine-specific preview, approval, evidence, recovery and retirement. Provider-specific functionality must be implemented behind independently qualified adapters.

| Provider | Infrastructure paths | Automation interfaces |
| --- | --- | --- |
| AWS | Terraform first; **CDK separately** | AWS APIs, Control Tower Account Factory; console, not mandatory CLI |
| Azure | **Terraform and Bicep** as separate choices | ARM/Resource Manager APIs; **PowerShell optional** |
| GCP | Terraform **and API-native provisioning** | Cloud Resource Manager v3 REST for folders/projects; Cloud Billing and IAM APIs; Google Cloud Infrastructure Manager REST for Terraform preview/deploy (where supported) |
| Private | Qualified provider-specific workflows | Explicit authorized adapters |

GCP API-native account/project provisioning is **not equivalent to provisioning an application workload**; after project creation, billing association, IAM, network and app platform need governed, individually approved API calls. Google Cloud Infrastructure Manager is a managed Terraform API, not a generic application deployment engine. No GCP live provisioning qualification is implied by this design.

A provider/engine choice is frozen into each reviewed plan; **no fallback that silently changes Terraform to CDK or Bicep**. Optional PowerShell cannot be required for Azure onboarding. Each provider's identity model, policy and account hierarchy remain independently enforced.

## AWS Terraform-first DEV handoff (PLAN only)

Verified: Adapt Cloud organization `o-0u6mts6li3`, management account `973471129135`, Control Tower us-east-2 ACTIVE/IN_SYNC, Security OU, zero budgets and no DEV member account. Owner-proposed DEV email: `info@adaptcloud.io`; Identity Center administrator email: `kristian@adaptcloud.io`. Actual email availability, credit eligibility and authorization remain unverified.

After governed account provisioning, generate proposed Terraform bootstrap inputs using:
```bash
python3 scripts/aws-dev-terraform-handoff.py \
  --dev-account ACTUAL_DEV_ACCOUNT_ID \
  --management-account 973471129135 \
  --identifier adaptcloud-dev
```
The generated JSON always reports BLOCKED, no mutations and ACT disabled. It cannot be passed to Terraform unchanged: the APPLY policy, state bootstrap role, budget, unique account and OIDC trust require separate owner review. No AWS writes performed by this workflow. Cumulative pilot cloud-credit ceiling remains $80; $0 additional spend authorized during preparation.

CDK requires its own independently qualified IAM separation and native CloudFormation preview, on a separate operator-selected execution path.
