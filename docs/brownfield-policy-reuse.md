# Brownfield application reuse with customer controls intact

## Scope of this contract

Enterprise customers often operate a governed platform already: Azure Policy and Azure Verified Modules; AWS Control Tower controls, IAM/SCP/RCP, AWS Config and CloudFormation/CDK; and GCP Organization Policy, policy-library constraints, Terraform blueprints and Shared VPC.

**ALZ must not redeploy, import into its ownership, rewrite or retag customer platform controls when an operator only wants to change an application's display name.**

The new `src/governance/brownfield-reuse.ts` implements a strictly offline **declaration comparator** for a before/after customer-supplied manifest. Controls are described by their native identifiers, assigned scope, source-of-truth references and SHA-256 fingerprints. The customer's protected network, identity, logging, encryption, platform and policy resources carry stable IDs, fingerprints, external ownership and `READ_ONLY` mutation policies.

The comparison permits a different `applicationLabel` only when **every other declared field** is unchanged (order of control arrays is immaterial). A control removed, changed, reassigned, version-drifted or replaced with an unknown family blocks the comparison. A shared network, NSG/security group/firewall rule, identity policy, logging sink or KMS key that changes ownership, hash, ID or declared source also blocks. The model returns a hash-linked `DECLARED_APP_LABEL_ONLY` or `BLOCKED` result and never performs a provider call.

**Limitations:** this does not independently verify that the supplied fingerprints are authentic, complete or the effective policies in a live cloud. A successful local comparison is NOT a native policy compliance PASS, permission to update infrastructure, a Terraform import, an Azure Bicep deployment, an AWS CloudFormation changeset or a production-qualification artifact. The return data always says `nativePolicyComplianceVerified: false`, `importPerformed: false`, `infrastructureMutationAllowed: false`.

## Reuse versus native import versus governance

| Cloud | Native governance system | Template/module ecosystem | Approach for existing platform |
|---|---|---|---|
| Azure | Azure Policy definitions, assignments and initiatives applied at management-group/subscription/resource scopes; RBAC and network security groups | Azure Verified Modules (AVM) in Terraform/Bicep, ARM JSON, private Bicep registries | Reference existing VNet, NSG, identities and inherited Policy assignments. Prefer existing-resource/data references; don't declare control-plane resources for replacement |
| AWS | AWS Control Tower OU controls (SCP, RCP, declarative, Config detective, CloudFormation hook proactive), IAM and security-group rules | CloudFormation JSON/YAML, CDK and Terraform | Preserve organizational-unit control assignments and existing VPC/SG/KMS/CloudTrail; create only separately approved application resources |
| GCP | Organization Policy constraints (organization/folder/project inheritance; custom constraints; IAM and firewall policies), and Policy Library constraint templates | Google Cloud Terraform blueprints/modules and policy-library YAML/Rego constraints | Reference existing project/folder/Shared VPC/IAM/logging; keep inherited Org Policy untouched and validate candidate application requirements against the customer's approved library |

AVM modules and Terraform blueprints **are IaC building blocks**, while Azure Policy, AWS Control Tower controls and GCP Organization Policy are **enforcement/assessment rules**. Both must be accounted for, but neither is interchangeable with the other.

GCP policy-library conventions include `policies/templates` (ConstraintTemplate YAML), `policies/constraints` (constraint YAML), and `validator/` Rego rules. GCP Organization Policy also uses hierarchical resource constraints. `gcloud beta terraform vet` can evaluate compatible policy libraries against Terraform plans, but it can make live Cloud API calls to resolve IAM and ancestry; therefore, ALZ's offline comparison **does not call it**.

### Source references

- [Azure Verified Modules](https://azure.github.io/Azure-Verified-Modules/) and [Azure Policy](https://learn.microsoft.com/en-us/azure/governance/policy/overview)
- [AWS Control Tower control behaviors](https://docs.aws.amazon.com/controltower/latest/controlreference/control-behavior.html) and [Control Tower proactive CloudFormation-hook scope](https://docs.aws.amazon.com/controltower/latest/controlreference/proactive-controls.html)
- [Google Cloud Organization Policy](https://docs.cloud.google.com/organization-policy/overview), [Terraform blueprints](https://docs.cloud.google.com/docs/terraform/blueprints/terraform-blueprints) and [Policy Library structure](https://docs.cloud.google.com/docs/terraform/policy-validation/create-policy-library)

## Example: changing an application label, not infrastructure

The following is **illustrative JSON**, not a deployment template or customer attestation:

```json
{
  "schemaVersion": 1,
  "provider": "GCP",
  "scope": "organizations/1234567890/folders/111",
  "applicationLabel": "Customer App B",
  "controls": [
    {
      "id": "orgpolicy/constraints/gcp.resourceLocations",
      "family": "ORGANIZATION_POLICY",
      "sourceOfTruth": "customer-governance-repo@reviewed-commit",
      "definitionSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "assignedScope": "organizations/1234567890"
    }
  ],
  "protectedResources": [
    {
      "id": "projects/shared-network/global/networks/platform",
      "category": "NETWORK",
      "configurationSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "sourceOfTruth": "customer-platform-state@reviewed-commit",
      "ownership": "EXTERNAL_IAC",
      "mutationPolicy": "READ_ONLY"
    }
  ]
}
```

Both snapshots must agree exactly on the customer controls and infrastructure; only `applicationLabel` may differ. The hashes above are **placeholders**, not claims of a real scanned environment.

## Qualification roadmap

1. **Offline DO:** deterministic manifests, policy family schema validation, missing/changed reference denial and proof of no network/mutation; run `./node_modules/.bin/tsx --test test/brownfield-policy-reuse.test.ts`.
2. **Native READ ONLY import:** account-scoped read-only connectors for Azure Policy/AVM and network, AWS Control Tower+Organizations/Config/CloudFormation and SG, and GCP Org Policy effective constraints plus Policy Library/GCP Terraform state; require explicit approved source and owner.
3. **Policy checks:** feed native policy documents to their actual parsers/evaluators; distinguish controls present from controls effective and satisfied. Policy source revisions need provenance and independent evidence; uncertainty stays UNKNOWN.
4. **App-scoped PREVIEW:** generate a new app-scoped IaC candidate using existing-resource references and compare against canonical customer-provided state and policy snapshots; insist on **zero existing-resource mutations**.
5. **Release-only:** owner and security review, live read-only provider qualification and explicit admission. No automatic IaC adoption, security-group change, Control Tower or Org Policy mutation, Terraform apply or production ACT.

Existing release and environment governance issues remain #39, #147 and #141. This comparison is intentionally independently useful in offline development even when those live qualification items are unavailable.
