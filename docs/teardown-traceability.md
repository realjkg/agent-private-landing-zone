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
- **Slice 2:** stamp the unit's tags into generated IaC (for example AWS provider `default_tags`) and record the unit with every build run. This changes the qualified private-model Terraform candidate, so it is qualification-sensitive and runs the model qualification gate before release.
- **Slice 3:**
  - tag readers for Pulumi, CloudFormation and Bicep previews;
  - discovery reads `alz-*` tags into the orphan report;
  - a governed runner for the destroy *preview* (`plan -destroy`, `pulumi preview --destroy`). That runner needs an explicit tool-broker review, because the broker classifies `destroy` as a mutation token by design, and that control is not to be worked around.

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
