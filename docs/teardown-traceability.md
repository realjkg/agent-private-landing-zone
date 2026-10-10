# Traceable teardown

**Status:** accepted. Phase 1, slice 1 is implemented (`src/teardown/`, `./alz teardown`). Phase 2 (executing a destroy) is **not** authorized. ACT remains DISABLED.

## Context

ALZ is a builder. Anything it builds in a cloud account costs money until it is removed, so ALZ must be able to undo what it planned and created: precisely, provably, and without help from a separate cleanup utility.

ALZ mostly works in brownfield accounts. Customer resources, Control Tower and other IaC estates sit next to anything ALZ adds. Discovery classifies them as read-only, and `DELETE_ALLOWED` is forbidden at every gate. A cleanup that enumerates an account and deletes by filter (an "account nuke") is therefore the wrong tool: one bad filter or forged tag destroys customer infrastructure.

Before this decision, nothing ALZ generated recorded what it created:

- the only tag was a static `ManagedBy = "ALZ-preview-candidate"` on one template;
- no type recorded the engine state location (Terraform backend, Pulumi stack, CloudFormation stack, Azure deployment);
- the normalized ChangeSet counted deletes, but no gate read them.

## Decision

**Never nuke an account. Undo exactly what ALZ built, through the engine that built it.**

1. **One deletion unit per build.** Every build creates into exactly one engine-native state container, recorded as a `DeletionUnit`. Teardown is that engine's own destroy of that container. The engine already knows dependency order, so no extra utility is involved.

   | Engine | Deletion unit (`stateRef`) | Teardown is |
   | --- | --- | --- |
   | Terraform / OpenTofu | remote backend + key + workspace | `destroy` of that state |
   | Pulumi | backend URL + stack | `pulumi destroy` of that stack |
   | CloudFormation / AWS CDK | region + stack name | `delete-stack` of that stack |
   | Bicep | Azure **Deployment Stack** (scope + name) | delete the stack with `actionOnUnmanage=deleteAll` |
   | Crossplane | one composite resource | delete that composite |
   | Ansible | none: it configures existing hosts | not a deletion unit (refused) |

2. **Three records must agree.** A unit is traceable when all three of these name the same set of resources:
   - **the unit record**: planned creates, state reference, design and ChangeSet hashes, hash-sealed;
   - **the engine state**, which the destroy plan reads;
   - **provenance tags** on every taggable resource: `alz-managed-by=alz`, `alz-unit`, `alz-build`, and optional `alz-expires`. Keys and values are valid as AWS tags, Azure tags and Kubernetes labels.

   Tags are a **pointer to the record, never authority.** Anyone with tag permissions can write them, so a tag alone never makes a resource deletable.

3. **Create gate (traceability at build time).** The create plan must:
   - create exactly the unit's recorded resources;
   - change nothing else (no UPDATE, DELETE, REPLACE or UNKNOWN);
   - prove every taggable create carries this unit's tags (tags computed only at apply time are refused);
   - use durable state (a `local` backend is refused, because losing the file orphans everything it tracks).

   Untaggable resource types are listed as *state-only*. They are still covered by the unit's state.

4. **Destroy preview before any destroy.** The engine's destroy plan is evaluated against the unit:
   - it must DELETE only;
   - every delete must be a recorded create;
   - anything else in the state blocks the **whole** teardown. A customer resource imported into the unit's state is a stop signal, not collateral.

   The result is `READY_FOR_AUTHORIZATION`, `NOTHING_TO_DESTROY` or `BLOCKED`, with `executionMode: PREVIEW_ONLY` and `infrastructureAct: DISABLED`.

5. **Orphans are reported, never auto-deleted.** Resources tagged by ALZ that no recorded unit accounts for are reported:
   - unattributed;
   - unknown unit (its state may be lost);
   - tag conflict (forged or stale tags).

   Expired builds are also reported for cost follow-up. To remove an orphan, import it into a unit and destroy that unit through the same preview and authorization path.

6. **Isolation for short-lived builds.** Sandbox or ephemeral builds should get their own account, subscription or resource group, with `alz-expires` and budget alerts. Closing that container is the cleanest teardown of all, and it never touches a shared account.

### Cleaner-path comparison

| Approach | Precision | Brownfield-safe | Extra tooling | Verdict |
| --- | --- | --- | --- | --- |
| Account nuke (enumerate and delete by filter) | filter-dependent | **no** | yes | rejected |
| Delete by tag | tag-dependent (tags are forgeable) | weak | no | report only (orphans) |
| **Engine-native destroy of one recorded unit** | exact (state + record + tags agree) | yes | no | **chosen** |
| Dedicated account/subscription per ephemeral build | exact (container boundary) | yes | no | recommended for sandboxes |

## Phases

**Phase 1 (no ACT): traceability and preview.**
- **Slice 1 (this change):**
  - `src/teardown/`: tag contract, `DeletionUnit` record and verification, create gate with a Terraform/OpenTofu plan tag reader, destroy-preview evaluator, orphan report;
  - `./alz teardown record | check-plan | destroy-preview | orphans`, read-only over plan and resource JSON your own engine run produced.
- **Slice 2 (implemented, opt-in):** the private-model Terraform build stamps the unit's tags into the generated candidate and returns the recorded unit with the build run.
  - Opt in by supplying the engine state reference (`deps.deletionUnitState`; for the real-build CLI, `ALZ_DELETION_UNIT_STATE=<state-ref.json>` and optionally `ALZ_DELETION_UNIT_EXPIRES=YYYY-MM-DD`). Without it, the candidate, its content hash and the result are byte-for-byte unchanged, so existing model-qualification evidence stays valid.
  - The create gate runs on the **real plan's** tags (`plannedTags`, read from `show -json`). A driver that cannot report them fails the build closed.
  - The unit is carried on `BuildLoopResult` / `BuildRunRecord` and in the preview summary (`deletionUnitId`, `deletionUnitHash`).
  - The opt-in tagged candidate is a different artifact from the qualified one, so it needs the model qualification gate before it is used in a release. This slice runs no heavyweight qualification.
  - The preview itself still runs with `init -backend=false`. The unit declares where an authorized apply would write state; a `local` backend is refused.
- **Slice 3 (implemented for files you produce; live wiring deferred):**
  - per-resource tag readers for **Pulumi** (`preview --json`), **CloudFormation** (`describe-change-set`) and **Bicep** (`what-if`), so the create gate and destroy preview work for every engine that has a plan; `./alz teardown --engine` selects one;
  - orphan inventory from `aws resourcegroupstaggingapi get-resources` and `az resource list` output (`orphans --aws-tagged` / `--azure-tagged`). Inventoried resources stay `UNKNOWN` / `READ_ONLY`: a tag never grants ownership or delete authority. A paginated AWS listing is reported incomplete and never exits clean.
  - **Deferred, on purpose:** a governed runner for the destroy *preview* (`plan -destroy`, `pulumi preview --destroy`) and a *live* tag-inventory read inside discovery. Both mean new entries in the tool broker's allowlist, and the broker classifies `destroy` as a mutation token by design, so they need an explicit broker review rather than a workaround. AWS CDK now uses the CloudFormation reader (a CDK unit is checked against CloudFormation change sets); Crossplane (render only; no plan) has no reader.

### Producing the inputs (you run these; ALZ only reads the files)

| Engine | Create plan (`check-plan`, `record`) | Destroy preview (`destroy-preview`) |
| --- | --- | --- |
| Terraform / OpenTofu | `terraform show -json PLAN` | `terraform plan -destroy -out=P` then `show -json P` |
| Pulumi | `pulumi preview --json` | `pulumi preview --destroy --json` |
| CloudFormation | `aws cloudformation describe-change-set ...` for a change set created with `--include-property-values` | no native stack-deletion preview; supply a Remove-only change set if you can produce one |
| Bicep | `az deployment <scope> what-if --no-pretty-print` | supply a Delete-only what-if if you can produce one |

Reader behavior is checked against **real captured output** in `test/fixtures/live/` (Terraform so far; Pulumi, CloudFormation and Azure captures are still needed and are smoke-tested automatically when added). What is verified and what is still an assumption is listed in `docs/teardown-cli-quirks.md`.

How each preview shows tags decides what a reader can prove:

- **Terraform/OpenTofu** plans list every attribute, so a missing `tags` is a real signal.
- **Pulumi, CloudFormation and Bicep** previews show only what the template set. A create that **omits tags is read as an empty tag set and BLOCKED** as untagged, not guessed as fine. Types that genuinely have no tags (IAM attachments, role assignments) go in a reviewed `--untaggable-types` allowlist, so they are listed as *state-only* instead.
- A CloudFormation change set created **without** property values has no `AfterContext`, so tags are *not reported* and the gate blocks. Tags computed only at apply time (Pulumi unknown marker, unresolved intrinsics) block too.

**Phase 2 (requires explicit authorization; not approved): governed destroy execution.** A narrow ACT exception for destroy only:
- a single-use external lease bound to the destroy preview's ChangeSet hash and unit hash;
- a second approver (the repo has no two-person approval today; destroy should require it);
- snapshot, or explicit keep-by-choice, for data stores;
- the hash-chained change ledger records REQUESTED → STARTED → OUTCOME;
- verification afterwards: an empty state, and a tag search that finds nothing.

Until that is decided, `DELETE_ALLOWED` stays forbidden and nothing in ALZ can delete.

## Consequences

- Teardown precision equals state precision, so state must be durable and remote. Local state is refused at the create gate.
- Every engine needs a dedicated container per build. That is natural for stacks, Deployment Stacks and composites, and means one backend key or workspace per build for Terraform/OpenTofu and Pulumi.
- Untaggable resources rely on state alone; the create gate lists them so reviewers can see them.
- Resources created outside ALZ, or by ALZ before this change, have no unit. They appear as orphans (if tagged) or stay invisible to teardown (if not), which is the safe default.
