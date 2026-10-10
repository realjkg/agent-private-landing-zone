# Identity and execution-permission contracts

**Status:** implemented (step 2 of the destroy-preview build order in `docs/teardown-broker-review.md`). It contains one **compatibility change**: `terraform_plan` and `opentofu_plan` now need the `PROJECT_CODE_EXECUTION` capability. Read [What changes for operators](#what-changes-for-operators).

The governing statement: *the operator authorizes the preview, the driver enforces the contract, and no preview capability grants authority to change infrastructure.*

## Execution permission

A Terraform or OpenTofu plan is not static inspection. It loads provider binaries, evaluates `external` data sources and module code, and reads cloud state. Before this change the broker treated it like a cloud read; the adapters also passed `-lock=false`. Now:

| Tool | Needs |
| --- | --- |
| `terraform_version`, `terraform_fmt_check`, `terraform_validate`, and the OpenTofu equivalents | nothing (static inspection path, unchanged) |
| `terraform_plan`, `opentofu_plan` | `CLOUD_READ` **and** `PROJECT_CODE_EXECUTION` |
| `pulumi_preview`, `cdk_synth`, `cdk_preview`, `ansible_*`, `crossplane_preview` | `PROJECT_CODE_EXECUTION` (already required) |

- The set of tools that run project code is one list, `PROJECT_CODE_TOOLS` in `src/tools/execution-permission.ts`, and a test pins it exactly.
- The broker checks it, and the Terraform and OpenTofu adapters check it again, so calling an adapter directly does not skip the gate. No process starts when the check fails.
- The denial says what to do: it names the capability, says it is a separate approval from cloud read, says it **never** permits changing infrastructure, and points at the static checks that need nothing.
- Approving project code changes nothing about the allowlist. `apply`, `destroy` and every mutation tool stay unavailable with the capability granted, and `allowMutation` must still be `false`. Tests pin both.
- No ungated path is kept for backward compatibility. The one in-repo caller of an adapter plan, `qualify-aws-terraform-agent --plan`, now passes the capability explicitly, for that call only, because the operator already opted in with `--plan`.

## Identities

Exactly two identities exist (`src/tools/identity.ts`):

| Identity | Used for | Variables |
| --- | --- | --- |
| `DISCOVERY` (default) | provider reads for discovery and previews | `ALZ_DISCOVERY_<VAR>` |
| `STATE` | reading the state container for a destroy preview | `ALZ_STATE_<VAR>` |

Rules, each enforced in code:

1. **Neither inherits the operator's credentials.** The child starts with an empty environment and a private `HOME` (`docs/runner-hardening.md`).
2. **Neither falls back to the deployment identity, or to each other.** The runner accepts only `DISCOVERY` and `STATE`; any other name (`DEPLOY`, `OPERATOR`, a typo) is refused before a process starts. A variable set for one identity is never delivered under the other.
3. **Separate principals.** `collapsedIdentityVariables` reports, by name and never by value, any secret configured identically for both. The driver (step 4) must refuse to run when it is non-empty; step 2 supplies the check. `forbiddenIdentityVariables` reports `ALZ_DEPLOY_*`, `ALZ_OPERATOR_*` and similar, which nothing reads, so a mistaken export is visible instead of silently ignored.
4. **Locking stays on.** No adapter passes `-lock=false` or any other lock bypass; a test pins this for the Terraform, OpenTofu and Pulumi adapters and the broker, and the argv pins in `test/destroy-preview-boundary.test.ts` no longer contain it. The state identity needs the access to take the lock. It is never given a way around it.
5. **State is sensitive material.** The engine profiles still log no output excerpts, and plan or state JSON is not diagnostic output.

## What changes for operators

1. Any caller of `terraform_plan` or `opentofu_plan` (the broker or `adapter.preview`) must set `allowProjectCodeExecution: true`, or it is denied with the message above.
2. A plan now takes the state lock. With a remote backend, the identity must be allowed to lock, and a concurrent run waits or fails instead of racing. With the local backend, a lock file appears in the workspace while it runs.
3. `terraform plan` no longer passes `-lock=false` in the adapters.

## What this does not do

- It does not run a destroy preview. The driver and engine adapters are step 4.
- The profiles list the same variable names for both identities. The separation is that they are different principals with different values, enforced by non-fallback and the collapse check, not by different variable allowlists. Per-identity allowlists can be added when the driver defines which backend variables the state reader needs.
- `src/cli/real-private-build.ts` is a human-invoked qualification driver that still starts `terraform plan -lock=false` itself, with the full inherited environment, in a throwaway folder with no backend. It is outside the broker and unchanged here. It must not be copied for the destroy-preview driver, and moves onto the runner in step 4.
- Capability grants remain a caller decision. This change makes the grant explicit and required; it does not decide who may grant it.

## Tests

`test/identity-contracts.test.ts`: plans denied without the capability (and not unlocked by cloud-read, preview-write or managed-access), actionable denial text, capability is not mutation authority and unlocks no new tool, static path unblocked, adapters refuse direct calls without starting a process, the project-code tool set pinned, exactly two identities, forbidden and collapsed identity variables reported by name only, no lock bypass in source. The runner test for unknown identities now asserts a block instead of an exception.
