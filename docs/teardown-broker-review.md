# Tool-broker review: a destroy-preview runner

**Status:** review for a decision. Nothing in this change adds authority. It tightens one guard, pins the current boundary with tests, and sets out what a destroy-preview runner would have to satisfy if you decide to build one. ACT remains DISABLED, and `DELETE_ALLOWED` remains forbidden.

Context: `docs/teardown-traceability.md`. Phase 1 can already *evaluate* a destroy plan against a recorded deletion unit (`./alz teardown destroy-preview`), but the plan must be produced by the operator's own engine run. This review asks whether ALZ should ever produce that plan itself, and under what controls.

## Recommendation

1. **Do not add an agent-callable destroy-preview tool to the broker.** The broker is what a model can ask for. A destroy preview reads real state, which holds secrets, and reveals the account's inventory. The operator, not the agent, needs it, at teardown time.
2. **Stay on option A for now** (the operator runs the engine; ALZ reads the file). This is what exists today and adds zero authority.
3. **If you want ALZ to produce the plan, build option B**: a human-invoked, trusted-host driver, in the same pattern as `src/cli/real-private-build.ts`, outside the broker, bound to a recorded deletion unit, one engine at a time, starting with Terraform/OpenTofu. The required controls are in [Required controls](#required-controls-for-option-b).
4. **Offer nothing for CloudFormation or Bicep.** They have no native destroy preview, and the workarounds write to the control plane.

## How the boundary works today

Verified by reading the code (references are to `main` at the time of writing).

- **Allowlist by tool name.** `SAFE_TOOLS` (`src/tools/broker.ts:25`) lists every tool an agent can request. `executeTool` (`:107`) rejects anything else with "Tool is not on the allowlist."
- **Fixed arguments per tool.** Each name maps to a fixed argument list inside its adapter (for example `src/iac/terraform.ts` runs exactly `plan -input=false -lock=false -refresh=false -out=.agentic-preview.tfplan`). The caller supplies no arguments. `runAllowlistedProcess` (`src/tools/process.ts`) runs with `shell: false` and a 120-second timeout.
- **Capability gates.** Four capabilities exist: `CLOUD_READ`, `PROJECT_CODE_EXECUTION`, `PREVIEW_WRITE`, `MANAGED_ACCESS`. Previews need `CLOUD_READ` (`cloudReadTools`, `:211`); `pulumi_preview`, `cdk_*`, Ansible and Crossplane tools also need `PROJECT_CODE_EXECUTION` (`:249`). A compromise-state policy (`kind: "CAPABILITY"`, `:161`) can deny any of them, an OPA mode requires a precomputed decision (`:126`), and `allowMutation` must be `false` (`:181`).
- **Workspace containment.** The working directory may not escape the allowed root (`:201`).
- **Boundary claims that depend on this.** `getToolSecurityPosture` (`:667`) reports `mutationTools`, tools whose *name* contains a token such as `destroy` or `apply`. That list must be empty for `src/security/session.ts:64`, for the adversarial gate (`src/qualification/private-model-adversarial.ts:281`) and for the debug report (`src/debug/report.ts:804`). The red-team suite forbids `terraform_destroy` and `pulumi_destroy` by name (`src/qualification/private-security-redteam.ts:61`). `README.md:309` states that no destroy is exposed through the broker.

## Findings

| # | Finding | Status |
| --- | --- | --- |
| G1 | The provider-qualification guard `dangerousPreviewCommand` matched the **exact word** `destroy`. `terraform plan -destroy` and `pulumi preview --destroy` pass `-destroy` and `--destroy`, which it never saw. | **Fixed in this change**: flag forms and `-destroy=true` now match, plus `-auto-approve` and `--yes`. Tested. |
| G2 | Mutation classification looks at the tool *name*. A destroy tool called anything without the token (for example `teardown_preview`) would not appear in `mutationTools` and would leave every posture claim above silently untrue. | Open. A destroy tool must never be renamed to avoid this. Pinned: the allowlist is snapshot-tested, so adding any tool fails a test and points here. |
| G3 | `runAllowlistedProcess` passes the **entire** process environment to the child (`...process.env`) and emits 160-character stdout excerpts to debug diagnostics (`process.ts`, `stdoutExcerpt`). | Open. Safe for today's tools; wrong for a runner whose output contains state values. See control 6. |
| G4 | **`terraform show -json` of a destroy plan contains sensitive values in plaintext**, in `change.before` and in `prior_state`; `before_sensitive` only flags them. The saved plan file contains them too. The human-readable plan masks them as `(sensitive value)`. | **Verified empirically** with Terraform 1.16.5 (`test/fixtures/live/terraform/destroy-sensitive-values.plan.json`, a fake secret). The normalized change set keeps none of it (tested). |
| G5 | The existing trusted driver `src/cli/real-private-build.ts` writes `.agentic-preview.tfplan` into its run folder (mode `0700`) and leaves it. For a create plan that is low risk; for a destroy plan it would hold the account's state. | Open. See control 5. |
| G6 | `terraform_plan` is gated by `CLOUD_READ` only, not `PROJECT_CODE_EXECUTION`. Terraform plans load provider plugins and evaluate configuration, and the `external` data source runs a program at plan time. | Open, **pre-existing** and not specific to destroy. Behavior is from Terraform's documentation; I did not test it here. Reclassifying would change existing flows and needs its own decision. |
| G7 | `-lock=false` (used today) tells Terraform not to take the state lock. On a remote backend, taking the lock writes to the backend, so omitting it is the right choice for a preview. I only saw that no lock file was left on a **local** backend, which is weak evidence; a remote backend was not tested. | The right choice for a preview, with a cost: the preview is a **point in time** and can be stale by authorization. See control 8. |

## What a destroy preview is, and is not

`terraform plan -destroy` is not `terraform destroy`; the difference is one word. A plan writes nothing to state or the cloud. It still needs: read access to the state backend, provider configuration (and so credentials, which the AWS provider validates at configure time), and evaluation of the project's code. Any of those can have effects a plan is not supposed to (G6), so "preview" is a property to enforce, not assume.

## Options

| | A. Operator runs the engine (today) | B. Trusted-host driver | C. Broker tool |
| --- | --- | --- | --- |
| Reachable by the agent/model | no | **no** | **yes** |
| New process execution in the repo | none | yes, fixed argv | yes, fixed argv |
| Posture claims (`mutationTools` empty, "no destroy exposed to the agent") | unchanged | unchanged | **at risk (G2)** or renamed around |
| Plan provenance | operator's word | recorded by ALZ, bound to the unit | recorded, bound |
| Secret exposure | operator's machine | contained by controls 5 to 7 | in the agent's tool path |
| Verdict | adequate now | **recommended if ALZ should produce it** | **not recommended** |

C is rejected because it widens what the *model* can request, and the repository rules say not to broaden model, tool or approval authority. B keeps the destroy preview a human act, exactly as the real private build is.

## Required controls for option B

Each is testable. A future PR should carry a test for each, and the review of that PR should check them.

1. **Fixed argument list, from constants.** Terraform/OpenTofu: `plan -destroy -input=false -lock=false -refresh=false -out=<fresh private path>`, then `show -json <that path>`. No caller-supplied arguments, no `-target`, `-replace`, `-var` or `-var-file` pass-through (`-target` would narrow a destroy and make a "READY" verdict misleading). Never the subcommands `destroy` or `apply`. Pin the exact list by test, as `test/destroy-preview-boundary.test.ts` now does for the existing previews.
2. **Bound to a recorded, verified deletion unit.** The input is a `DeletionUnit` that passes `verifyDeletionUnit`, not free-form paths. The driver must prove the directory it plans is the unit's state container: workspace equals `stateRef.workspace` and the initialized backend matches `stateRef.location`. A mismatch is BLOCKED, never "previewed anyway".
3. **Same code as the build.** The configuration hash must equal the build artifact's content hash, or the preview describes different code from what created the resources.
4. **Opt-in and gated like the existing driver.** Explicit environment opt-ins (a pair like `ALZ_ALLOW_REAL_PRIVATE_BUILD` / `ALZ_ALLOW_TERRAFORM_PLAN`), a clean commit, and the compromise-state policy evaluated for `CLOUD_READ` **and** `PROJECT_CODE_EXECUTION` (G6). Refused in any non-NORMAL compromise state.
5. **Secret handling for the artifacts.** Run in a fresh `0700` directory; write the plan file only there; **delete the plan file and the raw JSON after normalization**; keep only the normalized change set, its hash and tool versions. Never print or log raw `show -json` (G4, G5).
6. **Minimal environment and no output excerpts.** Build the child environment from an explicit allowlist (`PATH`, `HOME`, the provider's credential variables, `TF_*`), as the operator console already does for its jobs, instead of inheriting everything (G3). Do not route the child's stdout through the debug excerpt path. Pass any text that is logged through `sanitizeDiagnosticText`.
7. **Read-only credentials.** A dedicated identity that can read the state backend and the provider configuration reads, and nothing else. A preview that needs write access is a sign something is wrong.
8. **Point-in-time, and re-verified before any use.** The evidence records the unit hash, the destroy change-set hash, the tool version and the time. Because there is no lock (G7), a later authorization step must re-check, not trust, an old preview.
9. **Recorded.** One ledger entry per preview (`authorityClass: ADVISE`, `actionType: DESTROY_PREVIEW`), plus an observability event. Note the ledger's `maxTargets` limit of 100 (`src/change-ledger/local.ts:67`): units with more resources need a reference or batching.
10. **Verdict only through the existing gate.** The driver emits a normalized change set and `evaluateDestroyPreview` decides. The result stays `executionMode: PREVIEW_ONLY`, `infrastructureAct: DISABLED`.

### Per engine

| Engine | Position |
| --- | --- |
| Terraform / OpenTofu | Feasible under controls 1 to 10. Start here. |
| Pulumi | Feasible but heavier: `pulumi preview --destroy` runs the project program (needs `PROJECT_CODE_EXECUTION`), must pin `--stack` to `stateRef.stack`, use `--non-interactive` and `--json`, and has its own secrets provider. **I could not run the Pulumi CLI here**, so confirm the flag and the JSON shape on the pinned version first. |
| CloudFormation | **No native stack-deletion preview.** A change-set trick is a write to the control plane (`PREVIEW_WRITE`) and cannot express "delete everything". Do not build it. A read-only `describe-stack-resources` compared with the unit's `plannedCreates` is a possible alternative, but it is a new broker tool and needs its own review. |
| Azure (Bicep) | No equivalent destroy preview is used here. Keep to supplying a Delete-only what-if file. |
| AWS CDK | Same as CloudFormation. |
| Crossplane, Ansible | Not applicable. |

## What this change does

- **Tightens** `dangerousPreviewCommand` (G1). It only flags more; it cannot block anything that passed before except a command containing a destroy or auto-approve flag.
- **Pins** the boundary in `test/destroy-preview-boundary.test.ts`: the exact argument list of the Terraform, OpenTofu and Pulumi previews; no destroy, apply, deploy, target or replace literal in any adapter source; the broker allowlist snapshot, with the destroy and apply names rejected; and the plaintext-secret finding with the property that normalization drops it.
- **Does not touch** `src/tools/**`, the allowlist, any capability, ACT, or policy.

## Hardening I am not doing here (each needs its own decision)

- Passing a minimal environment from `runAllowlistedProcess`. Cloud-read tools need credentials in the environment, so a careless change breaks live discovery; it needs a reviewed per-tool list.
- Suppressing stdout excerpts for specific tools.
- Adding `terraform_plan` to the `PROJECT_CODE_EXECUTION` set (G6).

## Decisions I need from you

1. Is option B (a human-invoked trusted-host driver) the direction, or should destroy previews stay with the operator (option A)?
2. If B: Terraform/OpenTofu only first, or Pulumi too?
3. Which identity and credentials should the state-read use, and is a dedicated read-only role available?
4. May I take on the environment-minimization hardening for `runAllowlistedProcess` as a separate change?
5. Should `terraform_plan` require `PROJECT_CODE_EXECUTION` (G6)? It changes existing behavior.
6. Should a destroy preview refuse unless the configuration hash equals the build artifact hash (control 3)?

## Not proposed

An agent-callable destroy tool; executing a destroy (Phase 2 needs your separate, explicit approval); any change to the broker, its allowlist or its capabilities; renaming anything to avoid the mutation-token check.
