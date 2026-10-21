# Linux runtime security blueprint

Status: IMPLEMENTATION FOR REVIEW following blueprint PR #168 — independent approval and target qualification required before runtime rollout.
Owner: Landing Zone PM; coordination ledger: #39; release blocker: #77.
Lifecycle: Inventory → Plan → Design → Execute → Verify → Operate (Maintain).
Baseline inspected: `ffa3eb58f95a766327c8b07fcdb14a1300438b6a` on 2026-10-20.

## Inventory and evidence

This plan supplements the existing production release contract; it grants no infrastructure execution authority.

| Observation | Exact evidence | Consequence |
| --- | --- | --- |
| No open PRs at inventory time; #166 merged | GitHub open-PR collection and main branch API | Refresh before every implementation claim and handoff |
| ARM64/AMD64 native ABI and offline prerequisites passed | [run 39497419412](https://github.com/realjkg/agent-private-landing-zone/actions/runs/39497419412), source `475deaac9d97ccc031ea0c23b2c8ffe7aa10a604` | Historical PR-head evidence; not exact-main release or live SSO certification |
| PR validation and CodeQL passed at that PR head | [validation 39498074383](https://github.com/realjkg/agent-private-landing-zone/actions/runs/39498074383), [CodeQL 39498074432](https://github.com/realjkg/agent-private-landing-zone/actions/runs/39498074432) | Do not transfer PASS to a changed candidate |
| Earlier validation failed its full-suite step | [run 39489768083](https://github.com/realjkg/agent-private-landing-zone/actions/runs/39489768083), source `2d5d0d981b17939ef17c29459f0a6005454c687b` | Later head passes; root cause was not established in this inventory |
| Dockerfile uses `node:26-bookworm-slim` and `node:26-alpine` without digests | [Dockerfile at baseline](https://github.com/realjkg/agent-private-landing-zone/blob/ffa3eb58f95a766327c8b07fcdb14a1300438b6a/Dockerfile) | Pin verified multi-platform indexes before claiming immutable base identity |
| SBOM and release-manifest verification exist; workflow step calls itself provenance but uses ordinary docker build | [supply-chain workflow at baseline](https://github.com/realjkg/agent-private-landing-zone/blob/ffa3eb58f95a766327c8b07fcdb14a1300438b6a/.github/workflows/supply-chain.yml) | Manifest/checksum is not signed image provenance; image signing and attestation remain unqualified |
| Compose drops capabilities, uses a read-only root and no-new-privileges | [compose at baseline](https://github.com/realjkg/agent-private-landing-zone/blob/ffa3eb58f95a766327c8b07fcdb14a1300438b6a/compose.yaml) | Explicit seccomp/AppArmor and resource ceilings still need design and target proof |
| Private HTTP MCP module exists with injected BearerVerifier | [HTTP module at baseline](https://github.com/realjkg/agent-private-landing-zone/blob/ffa3eb58f95a766327c8b07fcdb14a1300438b6a/src/integrations/ai-studio/operations-mcp-http.ts) | This is not a deployed listener, TLS gateway or cryptographic verifier; a host constant does not enforce listener binding |
| Main reports protected=false; repository ruleset collection is empty; release collection is empty | GitHub branch/main, rulesets and releases API reads at inventory | Repository enforcement and independent release approval remain open |

Existing Studio documentation describes prerequisites and has older scope markers that predate the HTTP module. Reconcile those statements in the MCP implementation lane; do not infer deployed connectivity from source availability. Existing Trivy findings remain unresolved until fresh exact-candidate scans and documented disposition satisfy the blocking policy.

## Plan and approval boundary

PR #168 merged the blueprint only. The owner requested the four work packages below as one follow-up implementation with one owner per shared file; see [implementation and qualification](container-security.md). Check #39 ACTIVE claims, current main, and all open PR changed paths before editing. A merged blueprint alone is not a deployment approval. Record the approving security/platform reviewers, reviewed blueprint commit, target platforms and accepted limits in #39. Missing approval blocks rollout, not ordinary code, unit tests or disconnected simulations.

Keep default Compose and offline developer commands usable. Introduce an explicitly selected hardened production profile and read-only preflight. Production or sensitive execution must reject missing controls; a development profile may report unsupported controls without claiming production readiness. Never substitute fixtures for authentic release evidence.

### R1 — Immutable base identity

Proposed scope: Dockerfile, reviewed base-image lock, lock validator and focused tests.

- Obtain publisher manifest data through an authenticated or otherwise trusted registry channel. Record full repository, human-readable tag, immutable index digest, ARM64/AMD64 child digests, retrieval date and review provenance.
- Pin every external FROM to its verified index digest, including build and runtime dependency stages. Internal stage references remain local.
- Verify both required child architectures exist and resolve to the reviewed index. Reject missing/invalid digest, changed repository, architecture mismatch and lock/Dockerfile drift.
- Preserve Node major, musl ABI compatibility and native SQLite behavior. Do not invent digest values or accept a tag-only fallback.
- Base identity does not make apt/apk repositories immutable. Record resolved package inventories; separately evaluate repository snapshots or pinned package sources before claiming reproducible image bytes.
- Acceptance: static negative cases plus native image build, SQLite, compiled CLI and manifest verification on both architectures. This lane does not publish images.

### R2 — Signed image and provenance

Proposed scope: separate protected release workflow, verification policy, focused policy tests and operator procedure. Shared workflow changes require a fresh ownership claim.

- Select an approved registry, protected release environment and signing identity before publication. Use short-lived identity; PR jobs retain read-only permissions and receive no publishing or signing credentials.
- Build the exact clean source revision for both architectures. Bind index and child image digests, source repository/commit, builder identity, invocation, base materials, tool versions and SBOM subjects in generated provenance.
- Sign immutable image subjects with an approved Sigstore/cosign or equivalent mechanism. Pin verifier tooling and external Actions immutably. Verify issuer and exact signer/workflow identity, subject digest, source revision, provenance predicate and trust policy; signature existence alone is insufficient.
- Decide public transparency versus approved private trust/retention explicitly. Keep tenant secrets and private inventory out of provenance and public logs.
- Acceptance: valid artifact succeeds; unsigned, wrong signer/issuer, altered subject, stale source, untrusted builder and missing/wrong provenance or SBOM subject fail. Scan final ARM64 and AMD64 images with zero unresolved HIGH/CRITICAL under current policy.
- Publishing/signing runs only at the approved release boundary. No pull-request workflow may publish merely to test this design.

### R3 — Production Linux confinement

Proposed scope: dedicated production Compose overlay, versioned profiles, preflight, focused tests and operator runbook.

- Keep non-root UID, read-only root, dropped capabilities and no-new-privileges. Size tmpfs and pids/memory/CPU ceilings from measured CLI, SQLite and selected preview-tool workloads; document numbers before rollout.
- Review a seccomp allowlist against required Node/V8, native SQLite and approved child-process behavior on ARM64 and AMD64. Deny privileged kernel interfaces and namespace/inspection operations outside the approved runtime needs. Do not label Docker's implicit default as an independently qualified custom profile.
- Version and hash an AppArmor profile restricting filesystem writes to declared temporary/evidence paths, executable paths and required process access. Network destination enforcement belongs to the private ingress/egress layer; AppArmor/seccomp alone does not prove destination confinement.
- Read-only preflight checks the actual Linux daemon/kernel, loaded enforcing AppArmor profile and seccomp application. Unsupported or unconfined production targets fail closed with remediation. Profile loading is a separate authorized host-administration step, never an automatic developer prerequisite.
- Docker Desktop's Linux VM capabilities must be observed; macOS itself is not an AppArmor host. If unsupported, retain the development path and mark the production target unsupported pending a reviewed alternative.
- Acceptance on both native Linux architectures: CLI/SQLite/evidence writes and approved preview process succeed under the profiles; root writes, forbidden process/kernel operations and undeclared writes are denied. Capture actual kernel/daemon/profile identities and audit evidence. Static YAML tests alone do not qualify confinement.
- Do not add privileged mode, host networking, Docker socket mounts or unconfined fallback to obtain PASS.

### R4 — Authenticated private MCP/SSO

Proposed scope: trusted verifier/gateway integration, explicit listener bootstrap, protocol handling, tests and Studio documentation.

- Confirm Studio's actual supported MCP protocol/transport version, connector/private routing and cancellation/session requirements. Choose an approved private TLS termination and issuer/audience contract before implementing target connectivity.
- Trusted host validates signature using an approved key source, algorithm allowlist, issuer, audience, expiry/not-before, key rotation and revocation/session policy. Never accept model-supplied verified flags or identity headers as authentication.
- Enforce listener binding and ingress trust in executable configuration. Bind verified tenant, stage, subject, delegated scopes, role and correlation to each broker call. Preserve read/preview-only tool exposure and blueprint approval boundaries.
- Bound requests, timeouts, cancellation and session lifecycle; validate initialization/discovery/tool schemas and transport compatibility. Do not claim full Streamable HTTP MCP support from a JSON POST handler alone.
- Keep credentials, bearer tokens, key material and sensitive tool outputs out of model context and logs. Validate TLS trust and exact allowed ingress/model egress from inside each target container; no public Ollama or generic remote inference fallback.
- Acceptance first uses offline injected identities for parser/authorization failures. Separately authorized private target qualification must exercise real trusted tokens and Studio initialize/discovery/read/preview, invalid signature/issuer/audience, expiry/revocation, cross-tenant/stage/agent confusion, replay policy, insufficient scopes, oversized payload, timeout/cancellation and attempted mutation on both architectures.
- Missing Studio route, issuer/audience, verifier, disposable identities or target access is BLOCKED, not PASS.

## Verify and release evidence

Use focused tests during DO; no heavyweight model/cloud run for blueprint edits. Converge once on a clean candidate and repeat only checks affected by source changes. Keep development, offline architecture prerequisites, live SSO, supply chain and release admission as separate evidence classes.

Every qualification record must identify source commit, target hardware/architecture, immutable image index/child digest, base digests, kernel/daemon and confinement profile hashes where applicable, verifier/trust policy version, command or workflow/run identity, timestamps, result, retained artifact hashes and reviewer. Redact identities appropriately without removing correlation. A checksum proves integrity, not authentic execution.

| Completion item | State at inventory | Required closeout |
| --- | --- | --- |
| Source and repository inventory | COMPLETE for stated baseline | Refresh before handoff |
| Blueprint design | IMPLEMENTED FOR REVIEW | Independent security/platform review recorded |
| Immutable bases | IMPLEMENTED; CI qualification required | R1 validated registry lock and both native gates |
| Signed image/provenance | IMPLEMENTED; release workflow NOT_RUN | R2 authentic subject-bound verification and scans |
| Seccomp/AppArmor | IMPLEMENTED; target qualification required | R3 observed enforcement and denial evidence |
| Private MCP/SSO | JWT/bootstrap/probe IMPLEMENTED; target SSO NOT_RUN | R4 authenticated end-to-end target evidence |
| Repository release controls | BLOCKED | Authorized administrator enables and verifies protected review/status/release controls |
| Exact-candidate consolidated admission | BLOCKED | All applicable existing production gates plus this plan's evidence |
| Independent release approval | BLOCKED | Separate reviewer decision; no tool self-approval |

Existing model/provider/recovery/operational gates in production-release-admission.md remain applicable. This plan does not close #39, #77, #87, #141 or #147.

## Operate (Maintain) and rollback

Retain approved image digests, signatures, provenance, SBOMs, profile versions and configuration with the existing evidence retention policy. Assign platform ownership for base updates/CVEs, signer trust/key rotation, kernel/profile compatibility, ingress certificate/SSO changes and evidence expiry. Open a bounded DO lane on drift; never edit a prior qualification report into PASS.

Rollback selects a previously approved signed digest and its compatible configuration/profiles after verification. Keep encrypted evidence volumes intact and validate manifest/SQLite access. Reject unsigned or unconfined rollback candidates; if no qualified candidate exists, stop the production workload and follow the approved recovery procedure. Do not auto-roll back customer infrastructure or invoke IaC mutation.
