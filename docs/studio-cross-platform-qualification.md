# Linux ARM64/AMD64 AI Studio compatibility gate

**Scope:** cross-platform image ABI, native SQLite, release-manifest verification, compiled operator startup, and fail-closed private Studio/SSO configuration **prerequisites**.

- The same image source builds natively on GitHub-hosted Linux ARM64 and AMD64 runners.
- Both images run with networking disabled for qualification. The final Node runtime is examined inside each image rather than relying on the host CPU.
- Studio integration requires an external trusted OIDC/OAuth2 gateway capable of verifying issuer, audience, signature (via trusted key source), expiry, revocation policy, and role-specific scopes. This repository's admission metadata and typed flags **do not authenticate users**.
- Only the approved private ALZ MCP ingress should become reachable to Studio. The current Docker image runs the `operator help` CLI by default and does **not** expose a working MCP HTTP endpoint or implement Studio SSO.
- Local-only inference policy requires a loopback Ollama endpoint in the chosen container/network topology. `localhost` is resolved in the container's own network namespace; an Ollama instance on the Mac host is **not automatically reachable** from a Linux container.
- Do not add publicly reachable model endpoints, ambient cloud credentials, direct apply tools or remote inference fallbacks in order to make connectivity succeed.

## Remaining live acceptance

1. Obtain Studio's actual supported MCP transport, ingress/network requirements, agent skill installation method and SSO issuer/audience configuration.
2. Deploy a trusted private ingress with TLS and OIDC token validation; bind delegated scopes to ALZ policy broker.
3. Verify MCP initialization/discovery, invalid token rejection, cross-agent isolation, session expiry, delegated cancellations and evidence correlation using test identities.
4. Qualify the specific container → inference network path and enforce private-only traffic.
5. Repeat authenticated tests on both Linux architectures before labeling harness interoperability supported.

The `studio-platform.yml` CI run supplies **offline prerequisites only**, not end-to-end identity or hosted-harness certification.
