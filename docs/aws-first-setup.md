# AWS-first guided setup (Terraform / CDK)

This change extends the **existing** `./alz` terminal configuration flow
and `src/onboarding/plan.ts`. No installer, module framework, runtime
service, provider integration, orchestration path or execution driver is
introduced.

## Operator path

1. Run `./alz bootstrap` once for source checkout; then `./alz`.
2. Choose **Configure**, **development**, **aws**.
3. Select **terraform** (default/recommended) or **cdk**. The existing
   other engines remain accessible through **advanced**.
4. Select offline fixtures or local Ollama models, inspect prerequisites,
   and explicitly consent before a pinned tool install.
5. Review AWS account/identity permission guidance, select the local
   browser workspace, and initiate the existing discovery/design workflow.

The selection is **advisory**. It does not capture credentials, authenticate
with AWS, acquire a cloud role, create a state backend, run an IaC plan,
invoke provider APIs or enable ACT. Read-only AWS discovery is a separate
operator-authenticated command (`./alz inspect aws`). Cloud-side
CloudFormation Change Sets are limited-scope write operations; they require
distinct authority, and synthesis is not permission to execute a Change Set.

## AWS Dev → Staging → Production

The same reviewed blueprint and preferred engine progress between
**separate accounts/identities/state**. Stage choice does not grant access.
DEV is qualified first; STAGING requires fresh discovery and reviewed
promotion; PROD requires independent release approval and isolated
production identity. The currently approved production scope remains
Preview/Operate with ACT disabled. The preexisting separated pilot apply
contract may be considered by an owner separately, never enabled here.

Terraform and CDK are the initial primary engine paths. CloudFormation is
CDK's native underlying preview path. Pulumi/OpenTofu/Ansible/Crossplane
remain optional advanced choices with no new automatic installation.
Azure/GCP retain existing separate provider flows and do not introduce
prerequisites for the AWS selection.

No additional plan is needed to integrate this UX increment. Actual
full Dev-to-Prod provisioning qualification still requires real cloud
credentials/identity under owner control, independent CI and approval,
and the existing separately authorized ACT contract.
