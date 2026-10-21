# One ALZ operations API, two authenticated entry adapters

The shared service is `src/operations/unified.ts`. The two small entry
adapters are `src/operations/local-adapter.ts` (for `./alz` and the local
workspace) and `src/integrations/ai-studio/operations-mcp.ts` (for Studio).
`src/integrations/ai-studio/dual-entry-operations.ts` composes both on the
**same instance**, catalog, job runner, policy gate and output redaction.
Neither adapter is a privileged execution engine.

The shared catalog currently permits **READ_ONLY** operations through
this API. No `apply`, `destroy`, arbitrary shell or AWS role escalation
is made available through either adapter. The existing separate ACT
approval process is unchanged.

## Authentication flow

### Local `./alz` entry

- The trusted operator host must provide `verifyLocalSession()`. The
  adapter never accepts operator/agent-supplied identity JSON or raw
  bearer strings as a substitute.
- For browser-based AWS authentication, use the **standard AWS CLI IAM
  Identity Center sign-in** with an approved AWS profile. On a workstation
  with browser access, `aws sso login --profile <approved-profile>`
  opens the sign-in page; where a browser callback is unavailable, the
  operator can use AWS CLI's device authorization mode.
- The AWS CLI's SSO credential handling is distinct from the ALZ
  application login: a trusted ALZ host must **independently verify**
  the caller's ALZ session/RBAC, then bind the chosen AWS role/account
  and permitted operation. A successful `aws sts get-caller-identity`
  alone does not prove permissions or credential expiration.
- No AWS token, profile cache, SSO verifier or credential is passed to
  models, Studio messages or API responses.

### Studio entry

- The existing `StudioMcpAdapter` and loopback
  `createPrivateMcpServer` accept a verifier injected by a trusted
  deployment host. It must validate OIDC issuer, signature, audience,
  expiry, client and delegated scopes; a self-declared
  `verifiedBy` property is **not** proof of authentication.
- Hosted Studio must use a separately qualified private-network
  HTTPS ingress. Do not publish the Mac's loopback listener to the Internet.

## Fallback and correctness

Both paths can call the same service and produce the same decision
for the same independently verified caller and request.
Failover is **entry-point selection only**, never a privilege fallback.
A failed local session can be replaced by a separately authenticated
Studio session and vice versa, if ALZ remains reachable. All requests
use the same operation catalog; write operations remain refused.

Synthetic integration tests check local + Studio success and denial
parity, a real loopback MCP HTTP round trip, forbidden operations,
missing bearer, missing local session, expired/wrong-audience/missing-
scope identities, and verifier exceptions.

## Release gates not met by this PR

The composition is **not automatically invoked by current `./alz`
dispatcher or a deployed Studio gateway**. Host credential resolution,
cryptographic OIDC verification and live AWS role mapping must be
installed by their approved integrations. The private Studio network
route and live failover test require deployment-specific evidence.
No credentials were provisioned and no real AWS provisioning tested.
Do not interpret green unit tests as a completed production SSO path.
