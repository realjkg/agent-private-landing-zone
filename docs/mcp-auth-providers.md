# MCP authentication provider connector (initial foundation)

This module supports the three requested **MCP endpoint** authentication configurations:
OAuth 2.0, OAuth 2.1, and API key.

It models the “Create Auth Provider” form: name, description, authentication type and
type-specific fields. OAuth requires client ID, authorization endpoint, token endpoint,
redirect URI, scopes, and PKCE S256; client secrets, when needed, are referenced
by opaque secret store URI. API keys use a secret reference and named HTTP header.
Provider endpoint URLs require HTTPS.

Implementation: `src/mcp/auth-providers.ts`.
Synthetic unit coverage: `test/mcp-auth-providers.test.ts`.

## Security and scope
- Provider definitions contain secret **references**, never actual token or API-key values.
- Unknown authentication methods and unexpected fields fail validation.
- PKCE is mandatory for authorization-code clients. OAuth client-specific redirect,
  token exchange and discovery validation must be performed by the runtime integration.
- The registry is currently **in-memory**. It does not persist credentials or perform
  network authentication. Vault adapter, HTTP MCP client binding, OAuth callback,
  token refresh, audience and issuer validation, and server-side API endpoints are
  future integration work.
- AWS SigV4 and cloud-native credential chains are not MCP endpoint auth types and
  remain the responsibility of AWS provider tooling.
- No secret values should be included in logs, traces, or evidence artifacts.

## Acceptance gaps
- Wire provider selection to MCP endpoint connection UI and server API.
- Implement standards-compliant OAuth discovery, PKCE challenge/verifier exchange,
  state checking, refresh and revocation, token storage and TLS enforcement.
- Provide vault/keyring secret-reference resolver with strict host/domain binding.
- Synthetic connector tests including credential expiry, revoke, denied scopes,
  MITM/redirect rejection, replay attempts and redaction checks.
- Verify the new component in CI before merging.
