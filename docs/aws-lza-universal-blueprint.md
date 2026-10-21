# AWS LZA Universal Configuration → Sovereign ALZ review adapter

This PR extends the merged #173 byte-integrity intake without adding cloud
credentials or provisioning. LZA uses six core configuration files and can
reference included YAML; actual semantics require a version-matched official
LZA loader and validator. See the AWS LZA documentation and Universal
Configuration repository for authoritative definitions.

## Review contract

`mapLzaUniversalConfiguration` consumes the intake's pinned bundle fingerprint,
a separately collected official-version validator result, normalized parsed
sections, and independently observed AWS target identity metadata. Structured
sections are a **caller-supplied representation**, not validated by this
module against the YAML bytes. A claim of independentlyVerified=true is not
cryptographic verification. Integrators must bind signed validator evidence
and parser output to the exact source bundle, verify both outside model
context, and reject untrusted payload substitution before invocation.

Allowed outcome on conflict-free data is `REVIEW_REQUIRED`: an incomplete
`LandingZoneBlueprint` draft containing only project ID, AWS provider,
application landing zone scope and region/governance candidates. No
fabricated policy authority, account separation, IaC plan or approval is
inserted. The draft cannot satisfy production blueprint completeness and
never authorizes ACT.

Explicitly block proposed Control Tower enablement, new accounts,
organization OUs and VPC creation until a separate plan and authority
review. Flag root governance duplication, VPC-name collisions, mismatched
account/region, missing observed identity, and stale configuration hash.

## Follow-on implementation requirements

1. Pin and review an official LZA parser/validator release and dependency
   digest; perform true `!include` evaluation and cross-file JSON schema
   validation on bytes from #173.
2. Verify a signed or otherwise trusted validator report binding exact
   bytes, schema/validator versions and immutable Universal Configuration
   revision; do not let model-supplied claims determine validation status.
3. Perform personal AWS account read-only inventory, identify effective
   Control Tower/Organizations scope, and compare actual resource identity.
4. Complete explicit policy, architecture and state contracts, independently
   review the blueprint, then execute native *preview-only* IaC qualification.
5. A separate authorized Milestone 2 change is required for governed ACT;
   Milestone 1 Issue #39 remains ACT DISABLED.

Sources:
- https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/using-configuration-files.html
- https://github.com/aws/lza-universal-configuration
- https://awslabs.github.io/landing-zone-accelerator-on-aws/latest/user-guide/configuration-include/
