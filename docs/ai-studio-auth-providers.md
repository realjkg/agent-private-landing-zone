# AI Studio MCP authentication providers — staged integration

## Scope

This change introduces a **metadata-only, fail-closed authentication-provider admission contract** for a hosted AI Studio to future Sovereign ALZ MCP gateway integration. It does NOT claim to create an OAuth provider within AI Studio, serve OAuth endpoints, manage client credentials, or complete remote MCP authentication.

### Immediate setup: AWS Knowledge MCP

- Connector name: AWS Knowledge MCP
- Base URL: `https://knowledge-mcp.global.api.aws`
- Authentication Provider: **None Selected**
- No AWS credential, Salesforce OAuth provider, or Presidio AD provider should be attached.
- Acceptance: AI Studio successfully lists/invokes knowledge tools from its hosted backend; no cloud discovery or IaC permission is granted.

### Future setup: Sovereign ALZ MCP

- Build a versioned, remote HTTPS Streamable HTTP MCP gateway.
- Confirm AI Studio's actual supported authentication schemes and callback URLs before configuring an issuer.
- Register a dedicated **ALZ** OAuth/OIDC client with a trusted provider; do not reuse existing Salesforce or unrelated enterprise auth grants.
- Verify issuer discovery metadata, token signature, expected issuer/audience, expiration, scopes, client identity, token revocation/rotation, redirect URI and PKCE for interactive authorization.
- Hosted-to-private transport must be authenticated and scoped; gateway MUST NOT expose localhost-only ALZ health, raw secrets, remote shell, arbitrary cloud mutation, or general IaC deploy capabilities.
- Keep machine-to-machine client credentials separate from user-delegated OAuth authorizations.
- Resolve `secret://`, `vault://` and `keyring://` references only within the trusted runtime; do not serialize resolved values in evidence.
- Deny unexpected issuer, requested scope, redirect URL, DNS target, resource, or connector binding.

### Required follow-up code PR

1. Define ALZ MCP connector admission schema (URL, authRef, read-only capabilities, transport profile) and correlate it with this auth provider contract.
2. Implement the MCP server transport and request routing to the existing typed broker, with no new authority granted by MCP.
3. Implement OAuth resource-server token verification using a vetted maintained library and trusted issuer metadata (do not write custom signature verification).
4. Wire secure provider configuration with the operator UI and CLI; require explicit deployment-specific issuer/client registration.
5. Add synthetic and integration tests: invalid/expired/wrong-audience tokens, unauthorized scopes, secret-reference failure, HTTPS-only ingress, throttling, replay/session confusion, cloud mutations refused, safe telemetry, and disconnected private runtime.
6. Run repository `npm run check`, `npm run test:node`, `npm run test:ui`, security scans and exact-commit CI validation.
7. Record AI Studio hosted connection handshake and documentation search as independent live evidence; no fixture-only PASS is evidence of successful remote integration.

## Current code contract

`src/integrations/ai-studio/auth-providers.ts` validates selected authorization metadata and rejects embedded secrets and unsafe endpoint shapes. The schema is intentionally limited to ALZ discovery/evidence/policy/preview scopes. There is no mutation grant.

This metadata validation is not a complete authentication solution. Do not treat a valid schema as proof of token validation, issuer trust, or endpoint connectivity.
