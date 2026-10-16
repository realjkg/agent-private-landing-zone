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


## Debt-aware inheritance gate (authority, naming and native sources)

The manifest comparison is a **first prerequisite, not acceptance**. Calling `assessBrownfieldApplicationReuse()` alone proves nothing about security quality. Importers and console journeys must next call `screenBrownfieldInheritance()` in `src/governance/brownfield-inheritance.ts` before offering an existing control or module for an application design.

The screen checks:
- **Governance authority:** each existing control has an explicit security owner, pinned source revision, target-scope applicability, reported enforcement state and exception status. Missing entries or UNKNOWN authority are REVIEW_REQUIRED; disabled controls, unpinned sources, exclusions, active/expired exceptions or falsely promoted audit-only protections block reuse.
- **Native semantics:** a customer policy definition/module is not itself an effective enforcement assignment. Azure Verified Modules, CloudFormation templates and GCP constraint templates are treated as **templates only**. AWS Config rules are **detective**, whereas SCP/RCP and effective Organization Policy may be **preventive**. AWS proactive CloudFormation hooks are not assumed effective for direct Terraform/provider API creation.
- **Source checks:** optional bounded native JSON inspection (`src/governance/native-policy-inspection.ts`) validates provided source digests against customer manifest fingerprints and flags high-risk patterns: permissive AWS IAM actions/resources, unrestricted SSH/RDP/all-protocol ingress, Azure Policy `DoNotEnforce`, GCP `allowAll`/`enforce: false`/`reset`. Bad examples BLOCK. Unprovided or unfamiliar source documents, target-specific inheritance, exemptions and scope remain REVIEW_REQUIRED. This is deliberately **not** a full policy-language parser or replacement for Azure Policy, AWS Control Tower/Config and GCP effective Organization Policy evaluation.
- **Technical-debt posture:** every protected resource needs six customer-declared risk domains: network, identity, encryption, logging, change control and vulnerability. A failed check or signal such as public administrative ports, wildcard privileges, open egress, missing encryption/logging, shared mutable state or unpinned components blocks; absent/UNKNOWN domains require review.
- **Naming authority:** an approved customer logical-app naming convention must match environment code (dev/stg/prod), region and sequence. The proposed technical key cannot collide case-insensitively with declared existing or reserved keys; incomplete inventories require review. GCP project-ID lexical rules get a separate check; global uniqueness needs a later live query. Azure resource-specific rules differ substantially, so this generic application key **must not** be used to certify a storage-account/VNet/NSG name.

The outcome is one of:
- `BLOCK_INHERITANCE` — known defect or conflict; do not reuse as-is. Open a remediation proposal owned by the customer's platform/security team, outside ALZ's application change.
- `REVIEW_REQUIRED` — uncertainty, missing source, unknown scope or policy semantics; do not inherit automatically.
- `CANDIDATE_FOR_INDEPENDENT_VERIFICATION` — declared checks clear, but STILL no effective control attestation. Remains **not compliant**, preview disabled and ACT disabled until actual native policy evaluation, inventory, customer-owner attestation and separately authorized release work.

**No automatic policy repair or adoption.** The proper remediation for a weak inherited policy is a separately approved control-plane change by the responsible platform team. ALZ's app-only design continues in dry-run/discovery until a defensible approved boundary is available.

### Example guardrail cases

| Situation | Gate |
|---|---|
| App display name changes; approved, version-pinned reference inventory and no detected debt | Review pending native/effective policy verification |
| Azure assignment exists but has `DoNotEnforce` | Block inherited enforcement claim |
| AWS Config rule reports compliance but no preventive guardrail is attested | Review, not proof of prevention |
| AWS security group allows public SSH/RDP, or overly broad IAM Allow | Block |
| AWS CloudFormation hook is claimed as Terraform enforcement | Review coverage; no inferred protection |
| GCP Org Policy declares `allowAll`, has `enforce: false` or resets without effective proof | Block |
| GCP ConstraintTemplate is imported but no effective Org Policy assignment demonstrated | Review |
| Existing network/IAM object, scope or source digest changes while renaming app | Block |
| Technical application key collides with a reserved name | Block |
| All offline checks appear green | Candidate at most; **not production authorized** |

Tests: `./node_modules/.bin/tsx --test test/brownfield-policy-reuse.test.ts test/brownfield-inheritance.test.ts test/native-policy-inspection.test.ts`.

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


## Native exported policy state and physical naming (offline v2)

Customer-supplied **Control Tower enabled-control**, **Azure Policy assignment**, and **GCP GetEffectivePolicy** JSON snapshots can now be checked for exact target scope, control binding, response-hash integrity, and selected weakening conditions. Provider-specific physical-name profiles detect S3 bucket, Azure Storage account, and GCP project naming conflicts separately from a logical application label. Both are optional inputs to `screenBrownfieldInheritance`; missing or unverified sources remain REVIEW_REQUIRED, and known drift or prohibited changes block inheritance. No response alone proves active enforcement or global uniqueness. See [Brownfield source evidence](brownfield-source-evidence.md).
