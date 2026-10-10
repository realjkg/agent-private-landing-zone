# Artifact binding and immutable inputs

**Status:** implemented as a library and contract (step 3 of the destroy-preview build order in `docs/teardown-broker-review.md`, Decision 6). Nothing here runs a preview, adds a tool, a CLI command, an allowlist entry or a capability. The driver that uses it is step 4.

The governing statement: *the operator authorizes the preview, the driver enforces the contract, and no preview capability grants authority to change infrastructure.* This step makes "the driver enforces the contract" concrete for the inputs.

## What a governed destroy preview is bound to

A sealed **manifest** (`src/teardown/manifest.ts`) of the inputs that actually run:

| Manifest field | What it pins |
| --- | --- |
| `engine`, `engineVersion` | Terraform, OpenTofu or Pulumi, and the exact version |
| `providers` | Provider source and version, one entry per provider |
| `lockFileSha256` | Terraform and OpenTofu, project mode: the dependency lock file |
| `files` | Project mode: every configuration or program file, with its SHA-256 |
| `dependencies` | Project mode: resolved modules and language dependencies, by integrity hash |
| `inputs` | Variable and configuration input **identities** (a hash of a non-secret descriptor), never values |
| `target` | Account or subscription, backend, and workspace or stack |
| `unitHash` | The recorded deletion unit this preview is for |
| `policyVersion` | The policy version in force |
| `executionManifestSha256` | State-derived mode only: the approved state-derived execution manifest |
| `manifestHash` | Seal over all of the above (canonical JSON, sorted, so equal inputs hash equally) |

Two modes, and the difference is stated, not implied:

- **PROJECT:** the project's own files run (Terraform, OpenTofu, or a Pulumi program). The manifest must list files, and for Terraform and OpenTofu the lock file.
- **STATE_DERIVED:** a Pulumi destroy preview that reads state and does not run the project. The manifest binds the approved execution manifest and **must not** carry project files, dependencies or a project hash, because a project hash would imply it proves what ran. A validated result says what it proves: *"the approved state-derived execution manifest and target; the project is not run, so no project hash is implied."*

## Rules, each enforced in code and pinned by test

1. **Validated before execution.** `validateManifestForRequest(approved, request)` compares every field with what the driver resolved for this request. An extra file, provider, dependency or input blocks as surely as a changed one.
2. **Fail closed, no override.** A mismatch returns `REVIEW_REQUIRED` with the differing fields and the message *"A newly reviewed manifest is required; there is no override."* The function accepts no `force`, `skip` or `ignore` of any spelling: a request carrying a field it does not know is **refused**, not ignored, and a test scans the source for bypass-shaped names.
3. **Run from an immutable snapshot.** `createImmutableSnapshot` copies exactly the manifest's files into a fresh `0700` private directory, makes the files and directories read-only, and verifies the copy. The hash is taken from the bytes that were read for the copy, so a source that changed since approval is refused, and changing the source afterward cannot change what runs. `snapshot.verify()` re-checks the snapshot (content, missing files, and **unlisted** files, including a planted cache-named directory) and is meant to be called again immediately before running.
4. **The current state version is recorded separately.** `recordStateVersion` and `bindPreview` store the state version observed at preview time beside the manifest hash. State fields (`state`, `serial`, `lineage`, `etag`, `versionId`) are rejected anywhere in a manifest, so live state is never required to match a historical hash. Two previews of the same manifest at different state versions share a `manifestHash`.
5. **Inventory-only is never labeled validated.** `assessmentLabel` returns `ARTIFACT_VALIDATED_DESTROY_PREVIEW` only for a binding made from a successful validation; anything else, including a forged or hashless binding, is `INVENTORY_ONLY_NOT_ARTIFACT_VALIDATED`. A mismatch cannot be bound (`bindPreview` throws).
6. **State and plan files are never inputs.** `captureProjectFiles` refuses a project that contains `*.tfstate`, `*.tfstate.backup`, `*.tfplan` or `.agentic-preview.tfplan` (they can hold secrets in plaintext, `docs/teardown-broker-review.md` G4), refuses symbolic links and non-regular files, and caps file size (the manifest caps the file count). It skips only `.git`, `.terraform`, `.pulumi`, `node_modules` and `.agentic-private`, which are caches and metadata; dependencies in `node_modules` are bound through `dependencies` and the lock file instead.

## What it does not do

- **It does not run anything.** There is no preview, no process, no network or cloud call. Step 4 wires it into the driver.
- **Identities, not values.** A variable identity is a hash of a non-secret descriptor (a file hash, a reference id). Do not hash a low-entropy secret value and call it an identity: it can be guessed offline. The manifest never holds a secret value.
- **It does not prove a provider binary's contents.** Provider versions come from the lock file and the engine's report; verifying the binary itself belongs to qualification.
- **Read-only copies are not a sandbox.** The snapshot stops accidental or hostile edits by an unprivileged process; a process running as root, or the owner calling `chmod`, can still change it, which is why `verify()` runs again right before execution. Project code still runs with the privileges it is given (`docs/runner-hardening.md`), which is why `terraform_plan` needs `PROJECT_CODE_EXECUTION` (`docs/identity-and-execution-contracts.md`).
- **A reviewer's judgment is not automated.** A new manifest is created by a person reviewing a changed artifact; `compareProject` only reports what moved and repairs nothing.

## Tests

`test/teardown-artifact-binding.test.ts` (18): seal, order independence and tamper evidence; mode rules; state fields refused; unsafe paths and non-hash identities refused; an identical request validates; each of sixteen differences fails closed and names its field; unknown and bypass-shaped fields refused and absent from the source; state version recorded separately and not part of validation; mismatches cannot be bound and inventory-only is never validated; capture uses standard SHA-256 (compared against an independent hash) and refuses links, state and plan files; the snapshot is private, read-only and exact; a changed, removed or link-replaced source is refused with nothing left behind; later source changes do not reach the snapshot; verification catches a changed, added, removed or planted file; state-derived manifests have nothing to snapshot.
