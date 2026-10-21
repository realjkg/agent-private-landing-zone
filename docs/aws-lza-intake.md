# AWS Landing Zone Accelerator configuration intake

This pure TypeScript component ingests *operator-supplied file bytes*, checks
expected digests, required root names and bounded `!include` references, and
produces a stable manifest fingerprint. It does not read local directories,
parse LZA YAML semantically, verify AWS's versioned schema, contact AWS or
execute the LZA CDK pipeline.

## What is reusable from AWS LZA

AWS LZA uses six required top-level YAML files:
`accounts-config.yaml`, `global-config.yaml`, `iam-config.yaml`,
`network-config.yaml`, `organization-config.yaml`, and
`security-config.yaml`. `customizations-config.yaml` and
`replacements-config.yaml` are optional. This intake distinguishes a
complete enterprise file set from an intentionally partial personal-account
design review. A complete file set remains **REVIEW_REQUIRED**, never
automatically schema-valid, deployed or approved.

The function `inspectLzaConfiguration(files, mode)` accepts only UTF-8
strings with independently declared SHA-256 digests. It validates hashes
and file names, flags missing or cyclic basic scalar `!include` files,
and returns normalized digest references rather than echoing potentially
sensitive YAML content. Include discovery is conservative: an actual
LZA-version-compatible YAML loader and pinned JSON schema must be used
before the config is trusted for deployment.

## Accelerated Sovereign ALZ workflow

1. Inventory existing AWS tenancy and Control Tower/Organizations posture
   with operator-approved read-only discovery.
2. Load a reviewed LZA base or universal-configuration candidate as untrusted
   declarative input; screen byte integrity and includes offline.
3. Run official version-matched LZA config validation and obtain a signed,
   reviewed configuration artifact. Do not infer policy effectiveness from a
   template.
4. Compare desired and observed resources; distinguish existing governance
   reuse from additive application changes, and flag conflicting account
   vending, network, IAM and security controls.
5. Generate the engine-native plan with source and target identity binding.
   Keep the decision as an advisory proposal until the existing review,
   policy, lease and signing contracts explicitly permit an operation.

Milestone 1 stays Preview/Operate with infrastructure ACT disabled.
Future scoped actuation must follow an independently approved Milestone 2
contract. This PR does **not** activate or modify any cloud execution route.
For personal AWS accounts, preview and offline checks can proceed without
requiring the multi-account universal configuration to be deployed.

## Sources

- https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/using-configuration-files.html
- https://github.com/aws/lza-universal-configuration
- https://github.com/awslabs/lza-mcp-server

Do not copy third-party templates into this repository without version,
license and provenance review. The universal configuration is an optional
source of design candidates, not evidence that any guardrail is enforced.
