# Docker operator experience — guided acceptance review

This document specifies an operator-facing workflow for the hardened local Docker runtime.
It does not claim that all steps are automated today. Infrastructure ACT remains disabled.

## Current entry points

- Source checkout: `./alz bootstrap` uses npm internally, then `./alz doctor`, `./alz demo`, and `./alz prompts`.
- Docker: `docker compose build alz` and `docker compose run --rm alz <command>`.
- Docker configuration requires external `alz-runtime-data` and `alz-evidence-keys` volumes and a committed source SHA supplied through `ALZ_SOURCE_COMMIT`.
- The evidence key is persisted separately from application state. The runtime remains non-root and read-only.
- `./alz scan` runs npm audit; when a local Trivy binary is missing, it reports that full Trivy scanning must happen in CI. Do not describe this as a complete local vulnerability scan.
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
- Missing Trivy locally versus passing the mandatory CI Trivy image scan.
- Preview/demo completes without cloud credentials or infrastructure mutations.
- Session restart explicitly reports memory-only conversation state.
- Trivy HIGH/CRITICAL finding blocks release approval.
- Operator can finish a guided demo and find its evidence and next safe action without npm commands.

## Release acceptance

Usability requires observing the operator journeys above, not merely passing developer tests. Do not rerun broad CI during iterative UX review. Run a single consolidated release qualification when authorized. Preserve the existing `AGENTS.md` coordination and active file claims. Changes to `src/cli/operator.ts` or `alz` require a separate ownership check and explicit claim before implementation.
