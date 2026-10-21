# AWS scoped session broker — qualification boundary

The narrow AWS-first broker is `src/tools/aws-session-broker.ts`. It reuses
Sovereign ALZ's existing private identity, tool, policy and evidence contracts;
it does **not** create another agent, IAM service, SSO service or credential cache.

## Design

- Trusted **host-owned** resolver retrieves an existing SSO or workload
  identity session using the approved AWS credential provider chain.
- The host must independently verify its caller identity with AWS STS and
  attest session validity and delegated permissions via its own trusted policy.
- Broker checks request ID, operator, exact AWS account, IAM role ARN, region,
  environment (DEV/STAGING/PROD), time-to-expiry, requested capability, and
  Terraform/CDK compatibility. Denials happen before adapter invocation.
- Host retains credentials in its own session closure. The broker passes only
  a typed capability and engine to that closure; it never returns credential
  material. Responses are a local `evidence://` reference and status, not
  raw provider output.
- Session expiry is checked with 30-second minimum remaining validity and
  12-hour maximum accepted lifetime. Revocation/refresh must be handled by
  the trusted resolver (session certificates or JWT metadata alone do not
  prove the AWS role is still authorized).

## No privilege elevation

Only `DISCOVERY_READ`, `IAC_PLAN` and `CHANGESET_PREVIEW` are
accepted. Terraform native planning is distinct from CDK CloudFormation
Change Set preview. Neither grants `apply`, `deploy`, `destroy` or
credential issuance. Cross-account/region/stage requests fail closed.

## Qualification status

The broker **does not yet supply** an AWS SDK provider, cryptographic SSO/OIDC
token verifier, verified credential cache, STS caller-identity lookup or an
adapter-bound live invocation. The `trust: STS_VERIFIED_BY_HOST` property
is a *contract supplied by trusted host code*, not a cryptographically
validated proof and must never be filled from model or Studio input.

Synthetic tests exercise the success route and denials for malformed targets,
untrusted/expired sessions, account/role/region/stage/operator mismatch,
invalid capabilities, engine restrictions, resolver error and adapter failures.
A passing unit suite proves the pure boundary contract only. Production
acceptance still requires real Studio-to-private-ALZ authenticated ingress,
trusted OIDC verifier, protected credential provider, live STS and AWS Dev
read/preview tests, token revocation tests and cloud-deny proofs. ACT remains
disabled in the regular ALZ harness.
