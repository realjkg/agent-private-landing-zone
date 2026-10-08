# Docker operator experience — guided acceptance review

This document specifies an operator-facing workflow for the hardened local Docker runtime.
It does not claim that all steps are automated today. Infrastructure ACT remains disabled.

## Current entry points

- Source checkout: `./alz bootstrap` uses npm internally, then `./alz doctor`, `./alz demo`, and `./alz prompts`.
- Docker: `docker compose build alz` and `docker compose run --rm alz <command>`.
- Docker configuration requires external `alz-runtime-data` and `alz-evidence-keys` volumes and a committed source SHA supplied through `ALZ_SOURCE_COMMIT`.
- The evidence key is persisted separately from application state. The runtime remains non-root and read-only.
- In a source checkout, `./alz scan` reports incomplete local coverage when Trivy is missing. The Docker bundle includes pinned Trivy and a mandatory code/dependency scan gate. The mandatory CI scan of the final image remains a separate release gate.
- Ordinary conversation checkpoints remain in-memory pending a separately approved encrypted persistence design.

## Proposed operator journey (UX acceptance criteria)

1. **Install:** An operator starts from an artifact and short setup guide without learning npm or TypeScript. Required Docker availability, architecture, storage initialization, and release source identity are checked with specific, actionable errors.
2. **Prepare:** The workflow creates or locates separate state and key storage, checks UID/GID write access and key permissions, and never prints secrets. Existing volumes are preserved; do not silently delete or replace a key.
3. **Explore:** A clearly labelled synthetic/demo mode is available without cloud credentials or local model weights. The interface says whether findings are synthetic or observed.
4. **Operate:** Read-only discovery/assessment is distinct from a preview-only design. Missing cloud grants, local model runtime, or live target evidence are explained plainly; no operation changes infrastructure.
5. **Review:** The operator sees a concise health summary: release-manifest integrity, encryption-key status, storage status, local inference readiness, vulnerability scan coverage and last verified release gate. A missing or stale scan is explicitly UNKNOWN/NOT VERIFIED, never PASS.
6. **Help/recovery:** Every error includes what failed, why it matters, and a safe next action. No stack traces or developer filenames by default.

## Scenarios to validate with a first-time operator

- Fresh Docker Desktop installation, no Node/npm installed on host.
- Reuse of existing named Docker volumes and an existing evidence key.
- Missing named volume; non-root cannot write; read-only filesystem errors.
- Invalid/missing `ALZ_SOURCE_COMMIT` and release manifest tampering.
- Missing Ollama or model weights, without falsely claiming live inference works.
- Missing Trivy in a source checkout versus bundled Docker scanning and the mandatory CI Trivy image scan.
- Preview/demo completes without cloud credentials or infrastructure mutations.
- Session restart explicitly reports memory-only conversation state.
- Trivy HIGH/CRITICAL finding blocks release approval.
- Operator can finish a guided demo and find its evidence and next safe action without npm commands.

## Release acceptance

Usability requires observing the operator journeys above, not merely passing developer tests. Do not rerun broad CI during iterative UX review. Run a single consolidated release qualification when authorized. Preserve the existing `AGENTS.md` coordination and active file claims. Changes to `src/cli/operator.ts` or `alz` require a separate ownership check and explicit claim before implementation.

## Build and validation reference

The runtime is a non-root, preview-only operator. ACT remains disabled. Live
model runtimes and cloud/IaC transports are external prerequisites; the test
image runs deterministic fixtures without cloud credentials or model weights.

Build from a clean committed checkout. The source revision is required and is
recorded in both the OCI label and the installed release manifest:

```bash
export ALZ_SOURCE_COMMIT="$(git rev-parse HEAD)"
docker build --build-arg SOURCE_COMMIT="$ALZ_SOURCE_COMMIT" \
  --target runtime -t agent-private-landing-zone:local .
docker build --target test -t agent-private-landing-zone:test .
docker run --rm agent-private-landing-zone:test
```

On a network with an HTTPS inspection proxy, pass the platform proxy build
arguments and its trusted CA as a BuildKit secret. The certificate is used only
for dependency installation and is not stored in image layers. Do not disable
TLS, package signature checks, or lockfile integrity verification:

```bash
docker build --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg NO_PROXY \
  --secret id=npm_ca,src="$NODE_EXTRA_CA_CERTS" \
  --build-arg SOURCE_COMMIT="$ALZ_SOURCE_COMMIT" \
  --target runtime -t agent-private-landing-zone:local .
```

If the build worker cannot resolve the platform proxy hostname, supply a
verified address with Docker's `--add-host` option. This is a worker networking
setting, not a reason to weaken verification.

The runtime packages the production dependency inventory as `sbom.cdx.json`
(CycloneDX), plus `release-manifest.json` with SHA-256 evidence for staged
release files and the SBOM. Generation immediately verifies the artifact.
Build-time security preflight runs as the runtime user using a temporary key
that is removed in the same layer. It never uses or ships the production key.
Without Git, runtime preflight validates the release contract, provenance,
lockfile, binary-safe file hashes, SBOM consistency, and complete `dist`/`config`
coverage. Missing, malformed, altered, omitted, or symbolic artifacts fail
closed. This local attestation does not sign the image; use a trusted immutable
image digest and deployment signing policy to authenticate the manifest and
the dependency binaries excluded from its file inventory.

Trivy 0.75.0 is included in the runtime from its pinned multi-platform upstream
image. A mandatory build stage scans the locked dependencies, source tree,
Dockerfile, Compose definition, and configuration for vulnerabilities and
misconfigurations. HIGH/CRITICAL findings or scanner errors stop the build.
Its JSON results are packaged as `security-scan.json` and included in release
integrity evidence. The CA secret also supplies the scanner's verified HTTPS
trust when operating through the platform proxy.

Run `docker compose run --rm alz scan` before deployment to repeat the existing
operator's dependency audit and Trivy filesystem/misconfiguration checks.
This requires access to the npm advisory service and Trivy's trusted database
registries, plus writable ephemeral cache space. The scanner is included;
fresh vulnerability data is fetched through the configured outbound policy.

### Production state and key provisioning

Compose uses the existing external volumes `alz-runtime-data` and
`alz-evidence-keys`. The key volume is mounted read-only at `/run/alz-keys`.
Provision a 32-byte base64 evidence key securely as `evidence.key`, owned by
UID 1000, mode 0600, with its parent directory mode 0700. The runtime-state
volume must be writable by UID 1000. Use encrypted backing storage and retain
the key securely for decrypting existing evidence. Provision these volumes
through the deployment's secure storage process before starting Compose;
do not overwrite an existing key or recreate existing volumes.

The onboarding development key at `/workspace/.alz-state/evidence.key` is
separate. Never mount it into the production key volume or bake it into an
image. Compose does not inherit the development key-file setting.

```bash
docker compose run --rm alz doctor
docker compose run --rm alz demo aws terraform brownfield
```

The container root is read-only, capabilities are dropped, privilege escalation
is disabled, and `/tmp` is ephemeral. `.runs` contains encrypted durable
evidence. Conversation checkpoints are memory-only; `ALZ_CHECKPOINT_DB` is not
honored and the session graph refuses file-backed SQLite. No unencrypted
persistent conversation database is supported.

### Linux ARM64 validation

Use a native ARM64 worker or correctly configured QEMU binfmt emulation. Build
and run the full test image, then build the runtime for the same platform:

```bash
docker build --platform linux/arm64 --target test -t alz:test-arm64 .
docker run --rm --platform linux/arm64 alz:test-arm64
docker build --platform linux/arm64 --target runtime \
  --build-arg SOURCE_COMMIT="$ALZ_SOURCE_COMMIT" -t alz:runtime-arm64 .
```

Pass the platform CA/proxy options above when needed. Verify that the runtime
reports `arm64`, its release verification passes, and security preflight passes
with a separately provisioned validation key. Emulated test results establish
functional ARM64 coverage, not native performance measurements.

Dedicated `test/docker-runtime*.test.ts` tests cover installed release
attestation without Git, malformed contracts, tampered executables and SBOMs,
missing locks, omitted/injected executable entries, symlinks, binary hashes,
the production key-volume boundary, and checkpoint refusal. Run them with
`node_modules/.bin/tsx --test test/docker-runtime*.test.ts` for targeted feedback.
