# AI Studio agent harness → private Sovereign ALZ

## Reuse-first choice

The user-facing agent orchestrator lives in the existing `studio.presidio.ai` harness. Reuse the harness's available agents, skills, authentication configuration, and connectors where they satisfy requirements. Do not deploy duplicate skills, connector registries, model servers, or an independent agent UI as a prerequisite.

ALZ remains the private TypeScript deterministic orchestrator and executor. A hosted connector must reach an authenticated, protected MCP resource-server endpoint with private-network ingress to ALZ. There is no proof yet that the existing Studio connection provides this network path; do not describe the current branch as a deployed MCP gateway.

## Sub-agent roles and authority boundaries

The typed dispatch contract in `src/integrations/ai-studio/subagent-routing.ts` defines the following bounded roles: INVENTORY, PLAN, DESIGN, POLICY, IAC, VERIFY, OPERATE. A delegated request carries caller identity, correlation/trace IDs and a blueprint ID. Per-role grants cover discovery/evidence read, policy assessment and IaC preview. The dispatcher does **not** grant mutation privileges. Actual authorization comes from independently validated tokens, policy evaluation and the private ALZ broker, not from these typed fields alone.

Execution is a separate signed, target-specific, human-authorized ACT workflow. Agent messages and MCP tool calls must never be mapped directly to OS shell, Terraform apply, Ansible mutation, Crossplane reconciliation, or Control Tower creation.

## Base tools and activation

The base ALZ capability catalog includes all eight adapter choices:
Terraform, Pulumi, OpenTofu, Bicep, CloudFormation, AWS CDK, Ansible, and Crossplane.

Each adapter is part of the TypeScript distribution, **not** a guarantee that the vendor executable is installed. A bundled all-tools profile can offer the four optional executables, but must use reviewed/pinned downloads and checksums, explicit local consent, separate SDK/tool licensing, and compatibility tests. Existing `./alz deps` currently only installs pinned Terraform and optional Ollama. Do not claim that running `npm ci` installs OpenTofu, Bicep, Ansible or Crossplane; other manual/vendor package paths require qualification. Missing unselected tools should be informational; missing selected tools must block the corresponding engine operation.

## Required hosted-to-private engineering acceptance

1. Determine whether Studio's provided connector can already speak authenticated Streamable HTTP MCP to a reachable private ALZ endpoint; reuse it where supported.
2. Establish protected ingress/network path without exposing the Mac or tenant credentials publicly. Validate exact HTTPS/TLS trust, issuer, audience, expiry, delegated scopes, and authorization per call.
3. Implement/qualify MCP initialize, tool discovery, schemas, request handling, cancellation, timeouts, bounded payloads and audit correlation. An auth-provider **metadata registry alone is not a token verifier**.
4. Bind each read/preview tool to the deterministic ALZ policy broker, and retain private evidence and state locally.
5. Keep blueprint completion and review signatures authoritative; promote Dev → Non-Prod → Production through separate approval and execution identity channels.
6. Validate negative tests for replay, revoked credentials, cross-tenant scope, malicious prompts, tool confusion and prohibited mutation.
7. Run live end-to-end qualification with the approved Studio environment and a disposable AWS Dev account before claiming availability.

### Scope marker
The routing module is an initial **pure admission contract**, not a working hosted service or network-connected subagent implementation. It does not inspect Studio's installed skills/connectors and cannot assert which ones are actually configured.
