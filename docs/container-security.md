# Container security implementation and qualification

This implementation follows the Linux runtime security blueprint merged in PR #168. Implementation is reviewable code; production qualification still requires authentic target evidence and independent approval. ACT remains disabled. Default developer Compose, offline tests and simulations remain available.

## Immutable image inputs

Every external Dockerfile stage uses the Node publisher's immutable OCI index digest. `config/container-bases.json` records both native child digests and the exact docker-library/repo-info source commit. `node scripts/container-bases.mjs` rejects tag-only references, repository substitution, stage omissions and lock drift. Exact registry index bytes are retained in `config/container-bases/` and hashed offline; both architecture digests must match their Linux descriptors. Native CI additionally retrieves each index by digest. The indexes and all four required child manifests were retrieved and hashed over HTTPS from Docker Hub on 2026-10-20, matching publisher revision `649e73bdd78dd1068baf17119792da9d12ad8423`. Independent review establishes publisher trust; consistency checks alone do not.

This pins base identity. Alpine package repositories still evolve; `apk upgrade` intentionally retains security updates. Do not claim bit-for-bit image reproducibility. Final image digests, native package scans and SBOMs must be recorded for each candidate.

## Production CLI confinement

`compose.production.yaml` is a standalone production definition. Do not combine it with developer Compose. It requires an immutable GHCR image reference, UID/GID 1000, a read-only root, all capabilities dropped, no-new-privileges, explicit seccomp/AppArmor profiles, no network, a 64 MiB noexec/nosuid/nodev temporary filesystem, 128 processes, 1 GiB memory and two CPUs. These conservative limits are the CLI/SQLite baseline, not measured capacity promises for model inference or IaC toolchains.

The vendored Moby profile is an architecture-aware default-deny syscall allowlist. It is not advertised as a workload-minimal custom syscall set. Its source revision and Apache license are retained under `security/`. AppArmor permits Node and Docker init execution, library loading and writes only to temporary/evidence paths; it forbids shell/tool execution and kernel/key writes. Network is disabled. Optional preview executables and inference/SSO networking need separately reviewed workload profiles, limits and target acceptance; never add unconfined fallback.

An authorized Linux administrator must review/load `security/alz-runtime.apparmor` before use. The application never loads kernel profiles or installs host packages. Docker Desktop must demonstrate support inside its Linux VM; unsupported hosts remain usable for development and are blocked for this production profile.

After independent release approval, a human can invoke the production CLI wrapper:

```sh
node scripts/container-run.mjs \
  ghcr.io/realjkg/agent-private-landing-zone@sha256:EXACT_APPROVED_DIGEST \
  EXACT_40_CHARACTER_SOURCE_COMMIT help
```

The placeholders deliberately fail validation. The wrapper verifies signature/provenance before creating a temporary idle container, inspects actual Docker configuration and in-container seccomp/AppArmor/no-new-privileges evidence before invoking the operator, then removes only that container. The wrapper accepts only `help` (including `-h`/`--help`), `plugins`, `sbom`, `prompts` and `prompt-guide`, without additional arguments. Apply, installs, sessions, servers and cloud discovery are rejected before any image verification or container start. Existing external evidence/key volumes must already exist with correct ownership; it never initializes or deletes them. It never applies IaC or auto-installs a profile. Do not run Docker Compose directly as a substitute for signature verification.

For an already running target, the read-only gate is:

```sh
node scripts/container-preflight.mjs CONTAINER_NAME IMMUTABLE_IMAGE SOURCE_COMMIT
```

It verifies signature/provenance, Linux/architecture, restrictions, resource ceilings, volume destinations/key read-only access, tmpfs restrictions and observed enforcement. The host administrator remains trusted: a loaded profile name alone cannot attest that an administrator has not replaced its contents. Retain administrator load/audit evidence and profile hashes with target qualification.

## Signing and provenance

`container-release.yml` is manual-only and main-only. No PR job receives signing/publishing permissions. An administrator must configure the `production-image-release` GitHub environment with independent required reviewers, prevent self-review and main-only deployment rules. The workflow fails closed if it cannot verify the review requirement, an exclusive main branch environment policy, or exact-source native confinement checks. Repository branch protection and release controls remain an independent administrator gate.

Each native architecture builds an immutable candidate with BuildKit provenance, scans that exact digest at HIGH/CRITICAL, verifies native startup/manifest, extracts the runtime CycloneDX SBOM, then signs the image and attests source/base-bound SLSA v1 provenance and SBOM using pinned cosign. Source regressions run before publication. Images are first pushed under **candidate** tags to enable scanning; a failed candidate remains unsigned and must never be admitted. There is no automatic production tag, release, deployment or multi-architecture promotion.

Signing uses GitHub's short-lived OIDC identity and the public Sigstore trust/transparency service for public source images only. Never put tenant/customer evidence or credentials in this workflow. The verifier requires the exact workflow identity on main, GitHub OIDC issuer, immutable subject name/digest, source revision, builder/workflow/invocation identity, tool versions, base index/child materials and signed CycloneDX content. It also hashes the final index bytes and checks the platform child digest bound into provenance. `node scripts/container-signature.mjs IMAGE SOURCE` is a read-only verification command. A signature alone never approves release. BuildKit attestations and the signed workflow predicate are complementary; the predicate is not an independent reproducibility audit.

## Private MCP authentication

`createMcpJwtVerifier` validates RS256 OAuth access tokens with pinned trusted JWKS, RSA keys of at least 2048 bits, an explicit HTTPS issuer, single audience, tenant and stage, short lifetime (at most 15 minutes), issued/not-before/expiry times, session ID and discovery-only scope. It rejects ID-token type, unknown keys/algorithms, token-controlled key URLs, signature forgery, cross-target claims and widened scopes. A mandatory trusted `isActive` callback checks live session/revocation state; failures deny access. Refresh trusted JWKS atomically by constructing a new verifier; unknown rotated keys fail closed until reviewed host configuration is refreshed.

`startAuthenticatedPrivateMcp` wires that verifier to the existing read-only operations adapter and enforces an IPv4 loopback listener. A trusted private TLS proxy on the same host must forward to it with `Host: 127.0.0.1:PORT`. Browser origins are rejected, identity headers are not trusted, bearer verification is bounded, and headers/body limits and request timeouts apply. The host supplies the operations service and the real revocation authority; no token verifier can be enabled by a client/model flag. The default container still runs operator help, not an automatically exposed server.

The no-network CLI profile does not serve MCP. Deploying a connected private TLS gateway/runtime requires a reviewed network-enabled profile and explicit target authorization. TLS bearer tokens may be reused within their active session; this implementation does not claim sender-constrained replay protection. Full Studio transport/session/cancellation interoperability is still an external qualification requirement. Do not advertise hosted-harness certification from these tests.

## Authenticated target qualification

`scripts/container-mcp-qualify.mjs` is an explicit operator-only live probe, never automatically invoked by CI or startup. Run it inside each approved Linux target with `ALZ_SOURCE_COMMIT` bound to the image. Its config contains `endpoint` (private HTTPS `/mcp`), `image`, `sourceCommit`, `targetHardwareId` and token **file paths** under `tokens`: `valid`, `expired`, `wrongIssuer`, `wrongAudience`, `wrongTenant`, `wrongStage`, `revoked`, `insufficientScope`. Supply real dedicated test identities/session fixtures from the trusted authority; files must be private (0600 or stricter). Never paste tokens into command arguments or reports.

```sh
node scripts/container-mcp-qualify.mjs /secure/mcp-qualification.json /evidence/mcp-result.json
```

The probe requires private resolved IPs, pins DNS for TLS connections, preserves certificate/hostname validation, refuses redirects, bounds response/time and writes a new private report without bearer values or response bodies. It checks exact initialize/discovery responses, a nonempty read-only operation catalog, real negative credentials, forged signature and structured mutation denial. A matching string in an arbitrary response cannot satisfy a gate. It records source/image/target/architecture and response hashes. The image/target fields are operator-supplied and must be corroborated by authenticated runner/container inventory; they are not self-authenticating. This probe does not certify Studio UI routing, cancellation or inference egress. Retain those separate authenticated harness/network traces and independent review.

## Evidence and remaining gates

Local type-checks, focused negative tests and loopback HTTP/JWT tests passed during implementation. Loopback tests use generated test keys and synthetic sessions; they do not establish live SSO. The local Docker daemon is not running, so native container execution must be assessed from CI. CI performs ARM64/AMD64 builds, explicit profile enforcement, SQLite writes to a disposable evidence volume, CLI/Node-child positives, shell/kernel/root/undeclared-write denials and final-image scans. No live signing, profile installation on operator hosts, external SSO/provider/model call or infrastructure execution was performed during implementation.

Before production: collect exact-head CI, real target confinement and resource measurements, authenticated private Studio/SSO and network qualification, approved signing workflow output, clean vulnerability disposition, all existing model/provider/recovery gates and independent release approval. Retain source/image/profile hashes, signer identity, kernel/Docker versions and reviewer decisions. Roll back only to a previously approved signed digest with compatible profiles, preserving encrypted evidence volumes.

Run the disconnected base check with `node scripts/container-bases.mjs`. Update a base by retrieving the publisher index and required child manifests over the trusted registry channel, verifying their hashes, and updating the lock, exact index bytes and all affected FROM stages together. Preserve the publisher revision and date; never reformat the retained index JSON. Rollbacks restore the complete reviewed set.
