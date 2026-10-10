# Teardown readers: known tool divergences

What the readers in `src/teardown/` assume about each tool's output, and how much of it has been checked against a **real capture** (`test/fixtures/live/`). Documentation tends to show the ideal JSON shape; real CLIs add wrappers, pagination, casing differences and omitted fields. Every unverified item below is a hypothesis to confirm with a capture, and each one is written to fail closed (BLOCKED, never "traceable") if it turns out wrong.

## Verified against real output

Captured with Terraform 1.16.5 and `hashicorp/aws` 6.68.0, offline with dummy credentials (see `MANIFEST.json`).

| Finding | Why it matters |
| --- | --- |
| A replace is `actions: ["delete","create"]` (delete first), with `action_reason: "replace_because_cannot_update"` and `replace_paths`. | The normalizer treats it as REPLACE; the reader ignores replaces, and a unit can never be recorded from one. |
| Unchanged resources appear in `resource_changes` as `["no-op"]`. | They map to SAME and are neither creates nor deletes. |
| On a create, `after` omits computed attributes and lists them in `after_unknown` (`id`, `arn`, ...). `before` is `null`. | |
| For `aws_cloudwatch_log_group`, `tags` **and** `tags_all` are both in `after` and fully known at plan time. `tags_all` merges provider `default_tags`. `after_unknown` does **not** list either. | Confirms "`tags_all` wins over `tags`", and that the create gate can prove tags from a plan instead of waiting for apply. |
| A type with no tags attribute (`terraform_data`) has neither key in `after`. | Read as UNTAGGABLE for Terraform, which is accurate there because plans list every attribute. |
| A destroy plan has `["delete"]` and `after: null`; `prior_state` exists only when there is state. | |
| `terraform fmt -check` accepts the renderer's aligned tag block with quoted hyphenated keys, and `validate` passes. | The alignment is now verified by the real tool, not just asserted. |
| Plans need real or `skip_*` provider credentials at plan time; the candidate has no skip flags. | Real private builds plan against real read-only credentials, as `docs/private-model-build.md` says. The captures used an override file with dummy keys. |

### More Terraform, from real plans (modules, `for_each`, null tags, deferred reads)

| Finding | Why it matters |
| --- | --- |
| Resources inside modules have addresses like `module.tagged.aws_cloudwatch_log_group.this`; `for_each` adds a key, `aws_cloudwatch_log_group.each["a"]`. | Unit `plannedCreates` and the gates compare these exact strings. They work unchanged. |
| A module given no tags (variable default `{}`) and a resource with `tags = null` both get **only the provider's `default_tags`** in `tags_all`. | An untagged module cannot pass the create gate by inheriting someone else's default tags. Tags given through a module merge with `default_tags` as expected. |
| A data source whose read is deferred to apply appears in `resource_changes` with `mode: "data"` and `["read"]`. | Mapped to READ, never a create: it is not read for tags and not in a unit's `plannedCreates`. |
| With `create_before_destroy`, a replace is `["create","delete"]` (reversed from the default). | The set-based mapping treats both orders as REPLACE, so a unit still cannot be recorded from one. |

### AWS CDK, from real `cdk synth` output

Synthesized with `aws-cdk-lib` 2.273.0 and the `aws-cdk` CLI 2.1145.0 (`test/fixtures/live/aws/cdk/`). **These are CloudFormation templates, not change sets.** The Tags shapes are real; the `AfterContext` wrapper the reader consumes is still unverified (below).

| Finding | Why it matters |
| --- | --- |
| The **CDK CLI adds a `CDKMetadata` resource of type `AWS::CDK::Metadata`** to every stack. It is region-conditional (`Condition: CDKMetadataAvailable`), has only an `Analytics` property, and cannot be tagged. Programmatic `app.synth()` does not add it. | In a change set it is an `Add` with no tags. Before this was checked it would have been blocked as untagged. `AWS::CDK::Metadata` is now a built-in untaggable type. |
| `AWS::IAM::Policy` has no `Tags` property **even when its stack is tagged**. | Also a built-in untaggable type (verified, minimal; extend per call with `--untaggable-types`). |
| Most types store `Tags` as a sorted `[{Key,Value}]` list; **`AWS::SSM::Parameter` stores a map**. | The reader handles both and yields the same tags. |
| `Tags.of(stack).add(...)` writes tags onto every taggable resource **and** records them as stack-level tags in `manifest.json`. | Only the per-resource tags are provable in a change set; stack-level tags are deliberately ignored (see the CloudFormation notes below). |
| Because `CDKMetadata` is conditional on the region, a change set for a region outside its list omits it. | A unit recorded in one region and checked in another blocks with `PLANNED_CREATE_ABSENT: CDKMetadata`: fail-closed, and it names the node. |
| A CDK unit's plan is a CloudFormation change set. | `AWS_CDK` units are now checked against CloudFormation plans (and only those); `./alz teardown --engine AWS_CDK` selects it. |

## Not yet verified (capture needed)

These engines could not be installed in the sandbox the readers were written in. See `stillNeeded` in `MANIFEST.json`.

**Pulumi (`pulumi preview --json`)**
- Assumed: `steps[].op`, `steps[].urn`, and `newState.{type,inputs,outputs}`; tags in `inputs.tags`, merged tags in `outputs.tagsAll`; computed values shown as the marker `04da6b54-80e4-46f7-96ec-b56ff0331ba9`.
- Suspected: `normalizePulumiPreview` (older code) reads `step.type` at the top level, but the type is likely under `newState`/`oldState`, which would leave `ResourceChange.type` empty. Addresses (URNs) are unaffected. The tag reader uses `newState.type` first.
- To check: whether `--json` prints anything besides the JSON document; which `op` values appear for the stack resource and providers (the `Stack` and `__provider` steps).

**CloudFormation (`describe-change-set`)**
- Assumed: `Changes[].ResourceChange.AfterContext` exists only for change sets created with `--include-property-values`, holds JSON as a string, and `Properties` may itself be a string. The reader accepts both and reports **not reported** when it is absent.
- Assumed: tags are `[{Key,Value}]` for most types and a map for a few (SSM). Both are read.
- To check: **pagination.** If the CLI returns only the first page of `Changes`, creates are missing and the gate blocks with `PLANNED_CREATE_ABSENT`. That fails closed, but would be confusing; confirm the CLI merges pages by default.
- To check: stack-level tags (`Tags` on the stack) propagate to resources but do not appear per resource in a change set. The reader deliberately ignores them, so such a build is blocked rather than assumed tagged.
- To check: the **`AfterContext` wrapper itself.** The CDK captures give real `Properties` and real `Tags` shapes, but no real change set has been captured, so how `AfterContext` encodes them (string, nesting, intrinsics resolved or not) is still assumed.

**Azure (`what-if --no-pretty-print`)**
- Assumed: `changes[].{resourceId,changeType,after}` with `after.tags` and `after.type`.
- To check: `changeType` values such as `Unsupported` (the normalizer maps unknown values to UNKNOWN, so the gate blocks).
- **Case:** Azure resource ids are case-insensitive, and the same resource may appear with different casing in what-if output and in `az resource list`. The gates compare exact strings, so a casing difference blocks (fails closed) rather than mismatching silently. If real captures show it, normalize case for Azure ids.

**AWS tag inventory (`resourcegroupstaggingapi get-resources`)**
- Found while writing these notes: with `--max-items N` the CLI adds a top-level **`NextToken`** (its own marker), separate from the service's `PaginationToken`. The parser now treats either as incomplete.
- To check: that default auto-pagination yields a single merged `ResourceTagMappingList` with neither token.
- To check: the Tagging API lists only resources that are, or once were, tagged, and not every resource type supports it. An inventory therefore cannot prove that **no** ALZ-created resource exists; it only finds tagged ones. The unit's state remains the authority.

**Azure `az resource list`**
- Assumed: a JSON array with `id`, `name`, `type`, `location`, `resourceGroup`, `tags` (possibly `null`).

## Reference material that is *not* a substitute

Template and example repositories (CloudFormation samples, CDK examples, Pulumi examples, Azure/ALZ modules) show what people write, not what the tools print. They are useful as **inputs** for producing captures, not as expected outputs. Resource specifications and provider schemas say which resource types *have* tags (a good source for the `--untaggable-types` list), but not how a preview renders them.
