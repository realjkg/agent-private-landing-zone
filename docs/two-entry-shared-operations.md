# Two entry adapters, one governed Operations API

The local `./alz` operator workspace and hosted Studio MCP adapter share
`UnifiedOperations`, the same operation catalog, authorization scopes,
redaction and read-only execution restrictions.

## Local path

The existing loopback server optionally accepts a **trusted host-provided**
`localIdentity.resolveLocalCaller()`. With it configured, the existing
127.0.0.1 workspace offers `GET /api/operations` and
`POST /api/operations/invoke`. Both require the existing local CSRF token
in `X-ALZ-CSRF`, loopback Host/Origin enforcement, and a verified identity
with `ALZ_DISCOVERY_READ`. Without an identity resolver, these endpoints
return `LOCAL_AUTH_NOT_CONFIGURED` and are unavailable. This does not
silently authenticate the user based on local OS account or HTTP headers.

## Studio path

The existing `StudioMcpAdapter` calls the same `UnifiedOperations`
instance type through `createPrivateMcpServer` and its injected
cryptographic bearer verifier. It exposes only read-only operations.
Hosted Studio transport, TLS, OAuth issuer, actual MCP compatibility and
private ingress must still be qualified in the real deployment.

## Browser-based authentication in a CLI

A CLI can open the system browser for an identity provider's
**OAuth 2.0 Authorization Code + PKCE** login with a localhost callback
and a state/nonce check. Where loopback callback is unavailable, use the
provider's supported **device authorization** flow: print a verification
URL and short user code, complete login in any browser, then poll for the
result. GitHub CLI `gh auth login --web` is an example of the UX, not a
reusable credential grant for AWS or Presidio Studio.

For AWS infrastructure, use `aws sso login --profile <approved-profile>`
and the standard AWS SDK/CLI credential provider chain. Never substitute
a GitHub OAuth token for AWS STS credentials. The host must validate
account, region, role, delegated scope, expiry and operation independently.
Do not send tokens to agents, Studio model context or diagnostic output.

## Security / acceptance

Both adapters refuse unauthorized operations and share the exact
READ_ONLY catalog. Local CSRF does not replace authentication. Neither
adapter grants apply/destroy or provisions IAM roles. Browser login
automation, actual local identity resolver, AWS STS binding and hosted
Studio OAuth verification are **not** implemented by this PR. Those
require trusted issuer configuration and live operator-controlled tests.
Synthetic parity and deny tests are in
`test/shared-entry-adapters.test.ts`.
