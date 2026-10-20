# Unified ALZ Operations API and AI Studio MCP adapter

This phase exposes the existing ALZ operations catalog as a **shared internal service** (`UnifiedOperations`) and a **read-only JSON-RPC MCP adapter**. The CLI/operator console retain their existing behavior; migration to the shared service is separate follow-up work.

## Current implementation

- Operations identity: subject, audience, expiry, trace ID, delegated scopes; `ALZ_DISCOVERY_READ` is required for discovery and read-only calls.
- Operations catalog: only `READ_ONLY` operations are listable or invocable via MCP. Existing `planOperation` and `runPlanned` preserve validated arguments and handoff denials.
- MCP adapter: `initialize`, `tools/list`, `tools/call` with `alz.operations.list` and `alz.operations.invoke`; outputs are bounded and redacted.
- HTTP transport: `createPrivateMcpServer` accepts an **injected cryptographic bearer verifier**. It does not derive identities from untrusted headers, implement OIDC verification, serve public TLS, or auto-start. Bind using `PRIVATE_MCP_BIND_HOST` to loopback and connect through a separately validated private ingress.
- Tests: invalid and expired identity, wrong audience, missing scopes, prohibited writes, injection parameters and simulated bearer roundtrip. These are synthetic fixtures, **not Studio SSO validation**.

## Studio agent provisioning

Studio's interactive wizard supports selecting **Agents → Create Agent → Connectors → Skills → Model**. That is a supported **manual setup path**, not evidence of an agent-creation API. Provision the ALZ supervisor and specialist agents through Studio, bind only their needed MCP scopes, and choose an approved private inference provider after verifying Studio's provider integration capability.

## Production acceptance still required

1. Verify the actual Studio-supported MCP transport and JSON-RPC protocol version, stream/session requirements, reconnect behavior, and connector ingress.
2. Deploy a trusted SSO verifier (OIDC JWKS, issuer, audience, expiry, client/tenant, scopes, token revocation policy) and mutually authenticated network boundary. Do not infer token validity from the TypeScript `verifiedBy` field.
3. Ensure an ALZ-only token cannot be used to enumerate other tenant data, and reject untrusted `Origin`, malformed headers, and unsolicited requests at the gateway.
4. Validate live Studio-to-private-ALZ read-only calls with operator-approved test credentials, then confirm agent skills, routing and local-only model inference, including egress controls.
5. Wire the operator CLI and console through the shared Operations API and add explicit administrative lifecycle operations on a separate human-authorized channel.
6. Complete PR #166 architecture and evidence fixture tests; do not treat a passing unit test as cross-architecture SSO qualification.

No live Studio credentials or accessible endpoint were provided to this repository task. There is **no claim of a successful authenticated end-to-end Studio handshake**.
