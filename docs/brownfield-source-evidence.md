# Brownfield source snapshots and physical resource naming — offline development contract

This iteration extends the debt-aware brownfield screen with customer-exported, read-only **native control state** and actual hyperscaler-specific **physical-name constraints**. It never authenticates, creates a cloud account, changes IaC state, grants ACT, or independently attests effective compliance.

## Native response normalization

`src/governance/cloud-policy-snapshots.ts` accepts three bounded JSON read envelopes:

| Provider | Source method (reported by customer) | Evidence it can screen | Still not independently proven |
|---|---|---|---|
| AWS | Control Tower `GetEnabledControl` | Enabled-control ARN, assigned OU, SUCCEEDED status, drift indicators | Target account's membership in that OU, preventive vs detective vs proactive behavior, parameter behavior, full Config/SCP/RCP hierarchy |
| Azure | Policy Assignment `GET` | Assignment identity and hierarchical scope, `DoNotEnforce`, `Enroll`, exact `notScopes` exclusions, selectors/overrides | Full initiative semantics, exemptions, actual compliance/effective policy, management-group ancestry not supplied |
| GCP | Organization Policy v2 `getEffectivePolicy` | Exact org/folder/project policy name, reset, boolean disabled, allow-all patterns, incomplete rules | Authenticity of exported response, complete constraint semantics, custom policy conditions, policy-library Rego results |

Every snapshot has `controlId`, provider, exact intended target scope, declared source method, UTF-8 JSON, SHA-256 content hash, and a completeness assertion. The importer rejects method/provider/control mismatches, bad hashes, invalid or oversized JSON, target-scope mismatches, and known risky state. It always reports **not attested**. These checks are not an alternative to signed provenance, cloud IAM-scoped reads, or actual native policy engines. It deliberately does not assume that a Control Tower OU assignment applies to a child account without verified hierarchy membership.

In the `screenBrownfieldInheritance` contract, each supplied snapshot is tied to an existing control ID and the customer manifest scope. Rejected state results in `BLOCK_INHERITANCE`; apparently sound but customer-supplied state remains `REVIEW_REQUIRED`, and absent coverage is also `REVIEW_REQUIRED`.

## Resource-specific names

`src/governance/naming-resource-catalog.ts` distinguishes:

- `APP_LOGICAL_KEY` — the customer's logical application code format, not a physical resource name.
- `AWS_S3_BUCKET` — general-purpose bucket lexical constraints and reserved prefixes/suffixes. Actual availability is partition-scoped and cannot be verified offline.
- `AZURE_STORAGE_ACCOUNT` — 3–24 lowercase letters/numbers. Actual uniqueness is global.
- `GCP_PROJECT_ID` — 6–30 lowercase ASCII letters/numbers/hyphens, starts with a letter, no trailing hyphen; actual uniqueness needs an authorized read.

An existing physical resource cannot be renamed merely by changing an app's display name. The `REFERENCE_EXISTING` operation must preserve the exact existing physical name and remain read-only. `CREATE_NEW` requires separate ADD intent and authorization, not inherited permissions. Each name checks declared used/reserved inventories, character rules, provider match, and namespace completeness. Missing global uniqueness evidence cannot be counted as a pass.

These are **selected profiles**, not a complete AWS/Azure/GCP resource-name catalog. In particular Azure resource naming varies by exact ARM resource type. Other names must stay UNKNOWN/REVIEW, never be forced through an unsuitable generic regex.

## Deterministic tests

From the parent directory on the developer Mac:

```sh
cd ~/adaptcloud
cd agent-private-landing-zone
./node_modules/.bin/tsx --test test/cloud-policy-snapshots.test.ts test/naming-resource-catalog.test.ts test/brownfield-source-integration.test.ts
```

No live cloud credentials, private-model sessions, package downloads or ACT. This lane supports ongoing DO while production release evidence remains governed by #39. Scope and naming qualification continue in #153. Provider account binding and environment separation remain #141 and #147.

Official references: [AWS Control Tower GetEnabledControl](https://docs.aws.amazon.com/controltower/latest/APIReference/API_GetEnabledControl.html), [Azure Policy assignment GET](https://learn.microsoft.com/en-us/rest/api/policy-authorization/policy-assignments/get?view=rest-policy-authorization-2026-06-01), [GCP GetEffectivePolicy](https://docs.cloud.google.com/organization-policy/reference/rest/v2/projects.policies/getEffectivePolicy), [S3 bucket naming](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html), [Azure resource naming](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules), and [GCP project identifiers](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects).
