# Destroy-preview driver: the core contract

**Status:** core implemented (step 4 of the build order in `docs/teardown-broker-review.md`). This document covers the contract, the check order and the evidence (`src/teardown/driver/`). The Terraform, OpenTofu and Pulumi adapters (`src/teardown/driver/adapters/`) and the command line (`src/cli/teardown-driver.ts`) code against this contract and are described below. Pulumi ships disabled. Nothing here adds a tool, a broker entry, a capability or any authority to change infrastructure. ACT stays DISABLED.

The governing statement: *the operator authorizes the preview, the driver enforces the contract, and no preview capability grants authority to change infrastructure.*

## What it is

A human-invoked, preview-only driver. A person selects the exact target and asks for the operation; the driver validates, runs one engine adapter on a private snapshot, and returns redacted evidence. Destroy preview (`runDestroyPreview`) is a separate operation from ordinary preview (`runPreview`); neither is a mode of the other.

It is **not** reachable by an agent. It is not in the tool broker (`src/tools/broker.ts`, `SAFE_TOOLS`, `ToolName` are untouched, the 39-tool allowlist snapshot still passes, and a test checks that nothing under `src/tools` refers to the driver). The invocation record below is how a caller claims a person is at the keyboard; the CLI builds it from a terminal prompt. That is a reduction of risk, not proof of a human: see Limits, "The human record".

## The contract

| Piece | File | Role |
| --- | --- | --- |
| `PreviewRequest` | `types.ts` | Engine, mode, human invocation, resolved target, sealed manifest, deletion unit, project root, granted capabilities, policy version, resolved inputs. Closed: no other field is accepted. |
| `EngineAdapter` | `types.ts` | `preview(request, context)` and `destroyPreview(request, context)`, each returning `PreviewEvidence`, plus `engine`, `adapterVersion` and `argvDigest`. |
| `AdapterContext` | `types.ts` | `snapshotPath` (null in STATE_DERIVED mode), `scratchDir` (fresh, `0700`), the two identity names, and the environment. |
| `PreviewEvidence` | `types.ts` | See [Evidence](#evidence). |
| `QualificationRecord`, `enabledEngines`, `argvDigest` | `qualification.ts` | Engine activation. |
| `runDestroyPreview`, `runPreview` | `driver.ts` | The orchestration. Both return `DriverResult`: `{ ok: true, evidence, preview? }` or `{ ok: false, code, message, fields? }`. |
| `buildEvidence`, `assertNoRawPayload`, `evidenceProblems` | `evidence.ts` | Building evidence, and proving it holds no raw plan or state. |

### What an adapter does and does not do

An adapter receives a request that is **already validated and already snapshotted**. It never validates a manifest, never chooses an identity, never decides a verdict, and never runs apply, destroy or a shell. It:

1. runs its pinned argument lists through `runBoundedProcess`, in `context.snapshotPath`, with `identity: context.identities.stateReads` for state reads and `context.identities.providerReads` for provider reads, and `env: context.env`;
2. writes any plan file only under `context.scratchDir` (the driver deletes the directory afterwards);
3. normalizes the engine's output into resources (address, type, operation) and calls `buildEvidence`, then discards the raw output;
4. reports the state version it observed and the engine version it saw running;
5. computes its `argvDigest` from its constant argument lists with `argvDigest([...])`, so qualification is tied to exactly what it runs.

No `-lock=false` or any other lock bypass, no `-target`, `-replace`, `-var` pass-through, and no `apply` or `destroy` subcommand. The adapter lane pins these by test as `test/destroy-preview-boundary.test.ts` does.

## Order of checks

`run()` in `driver.ts` performs these in order. Each refusal stops the run; the adapter is called only after all of them pass. Each has its own test, and each of those tests asserts the adapter was not called and that nothing is left on disk.

| # | Check | Refusal code |
| --- | --- | --- |
| 1 | A human invocation record: operator id, `interactiveSession: true`, a confirmation time, and a `confirmedTarget` equal to the request's target in account, backend and workspace or stack | `HUMAN_INVOCATION_REQUIRED`, `HUMAN_CONFIRMATION_MISMATCH` |
| 2 | No field outside the known set, at the top level or in `invocation`, `confirmedTarget`, `target`, `capabilities` or `resolved`. Any spelling of force, skip or ignore is simply an unknown field | `UNKNOWN_REQUEST_FIELD` |
| 3 | The engine is qualified: a record matches the adapter's version, its pinned argv digest and the request's engine version | `ENGINE_NOT_QUALIFIED` |
| 4 | `PROJECT_CODE_EXECUTION` granted, for PROJECT mode, then `cloudRead` granted (every preview reads state and provider resources). Neither is mutation authority. The CLI derives both from what the person confirmed; a request file cannot carry them | `PROJECT_CODE_EXECUTION_REQUIRED`, `CLOUD_READ_REQUIRED` |
| 5 | Identities: both `ALZ_DISCOVERY_*` and `ALZ_STATE_*` configured; `collapsedIdentityVariables` empty; `forbiddenIdentityVariables` empty | `IDENTITY_NOT_CONFIGURED`, `IDENTITY_COLLAPSED`, `IDENTITY_FORBIDDEN` |
| 6 | The unit verifies (`verifyDeletionUnit`); the request names the unit's engine, backend (`location` or `backendUrl`) and workspace or stack; an ordinary preview is PROJECT mode; the project is captured; `validateManifestForRequest` passes | `UNIT_INVALID`, `UNIT_TARGET_MISMATCH`, `MODE_NOT_SUPPORTED`, `SNAPSHOT_REFUSED`, `MANIFEST_INVALID`, `REVIEW_REQUIRED` |
| 7 | `createImmutableSnapshot` (PROJECT mode), then `snapshot.verify()` again immediately before running | `SNAPSHOT_REFUSED`, `SNAPSHOT_CHANGED` |
| 8 | The adapter runs. Any exception is reported as a fixed message; its text is never forwarded. Afterwards `snapshot.verify()` runs again, because project code ran with the DISCOVERY identity as the same user that owns the snapshot | `ADAPTER_FAILED`, `SNAPSHOT_CHANGED` |
| 9 | The returned evidence is checked: closed shape, no raw payload, and identity of the run (operation, engine, mode, adapter digest, manifest hash, unit hash, target, policy version, `invokedBy` equals the invocation record, engine version observed equals the validated one, change set equals the normalization of its own resources) | `EVIDENCE_REJECTED` |
| 10 | `evaluateDestroyPreview` decides the verdict (destroy preview only); `bindPreview` records the state version beside the manifest hash | |
| 11 | In a `finally`: the snapshot and the scratch directory are removed, on success, refusal and failure alike. A `finally` does not run when the process is killed by a signal, so both are also registered for the CLI's signal handlers; see Cleanup | |

Order notes. The qualification check (3) uses the engine version the request resolved, so a version that is not qualified is refused before the manifest is compared. A verdict of `BLOCKED` from step 10 is a successful run with a negative result (`ok: true`, `preview.verdict: "BLOCKED"`), because the existing gate decides it, not the driver.

The driver adds no verdict logic. The result stays `executionMode: PREVIEW_ONLY`, `infrastructureAct: DISABLED`.

## Qualification

An engine runs only when a supplied `QualificationRecord` (engine, adapter version, engine version, argv digest, qualified-at, evidence hash) matches that adapter's `adapterVersion` and `argvDigest` **and** the engine version in the request. `enabledEngines(records, adapters, engineVersions)` decides each engine alone:

- a qualified engine is never held back by an unqualified one, and one engine's malformed or stale record disables only that engine;
- a record for one engine never enables another;
- a denial names what is missing: no adapter, no record (with the digest and versions to qualify), or which of argv digest (the adapter's argument list changed since qualification), adapter version and engine version no record carries.

**Pulumi ships disabled.** There is no Pulumi CLI in this sandbox, so no Pulumi adapter has been qualified here, and without a record the driver refuses it. The Pulumi adapter lane must say exactly which flags are unverified (the decision cites `destroy --preview-only` and `--run-program`; neither could be checked) and supply a record only after confirming them on the pinned version.

## Evidence

`PreviewEvidence` carries: operation (`PREVIEW` or `DESTROY_PREVIEW`), engine and mode; the adapter's identity and argv digest; engine and adapter versions; the normalized change set (address, type, operation, counts, hash); `manifestHash`, `unitHash` and `changeSetHash`; the **state version, separate from the manifest**; the label from `assessmentLabel` (`ARTIFACT_VALIDATED_DESTROY_PREVIEW` only after the manifest validated; the adapter's own evidence always starts as `INVENTORY_ONLY_NOT_ARTIFACT_VALIDATED`); the verdict; target and policy version; who invoked it and when they confirmed; start and finish times; and the authority statement `{ infrastructureAct: "DISABLED", mutation: "NONE", executionMode: "PREVIEW_ONLY", agentInitiated: false }`.

The driver overwrites label, verdict, state binding, timestamps and authority with its own values, so an adapter cannot award itself a label or a different authority.

**Redaction is structural.** Plan, state and raw `show -json` output hold secrets in plaintext (`docs/teardown-broker-review.md`, G4). Evidence is checked against a closed shape (any unknown key is rejected, and raw-document keys such as `resource_changes`, `prior_state`, `before` and `after` are named in the problem), every address and type must match a restricted character set, no string may be oversized or parse as a JSON document, and tests also plant canary secrets and check they are absent. `assertNoRawPayload(evidence, canaries?)` throws if any rule fails; the driver runs it on what the adapter returned and again on what it returns.

## What is and is not enforced

Enforced in code, with a test each: everything in the check order; cleanup in all outcomes; no adapter exception text in a result; no bypass-shaped name, no lock switch, no process execution and no apply, destroy or target literal in the core's source; the driver is not referenced from `src/tools`.

Enforced by the pieces the driver calls, not re-tested here: the manifest comparison and snapshot (`docs/artifact-binding.md`), the child environment and executable resolution (`docs/runner-hardening.md`), the identity separation and project-code gate (`docs/identity-and-execution-contracts.md`).

## Limits

Be exact about these.

- **The human record is a claim by the caller.** The driver checks that the record is complete and that the typed target equals the request. It cannot tell a real terminal from code that fills the record in. Keeping an agent from reaching the driver rests on it not being in the broker and on the agent having no shell. A process that can import this module can call it.
- **A pseudo-terminal defeats the CLI prompt.** The prompt defeats pipes, here-documents and CI, which have no TTY. It does not defeat a process that allocates a pty (`script`, `expect`, a python `pty`, `tmux send-keys`, node-pty): that process reads the target printed on screen and types it back, and the evidence then says `authority.agentInitiated: false` and names the operating-system account as `invokedBy`. That field records what the driver checked (an interactive TTY, the target typed), not that no program drove the terminal. This was reproduced. The real controls are that the command is not a broker tool and that agents are deployed without a shell or a pty; run the CLI only where that holds. Printing the target for the person to retype also means the prompt carries no secret.
- **Qualification records are self-asserted.** `--qualifications` is a JSON file; `qualifiedAt` and `evidenceHash` are never checked against any qualification evidence or signature, and the refusal message prints the adapter version and argv digest a record needs. Whoever can write that file can enable an engine, including the never-run Pulumi adapter. A record is a statement by the operator that the qualification was done.
- **Capabilities are the person's answers, not a policy decision.** The CLI sets `cloudRead` from the prompt's statement and `projectCodeExecution` from the typed `RUN PROJECT CODE`. The compromise-state policy for `CLOUD_READ` and `PROJECT_CODE_EXECUTION` and the explicit environment opt-ins (control 4 of `docs/teardown-broker-review.md`) are **not implemented**: a preview is allowed in any compromise state.
- **The target account is never resolved.** `target.account` is compared as a string with the request, the typed confirmation and the manifest. No `sts`/`az` identity call confirms the configured credentials belong to it. For Terraform, the backend `init` selected is not compared with the unit's `stateRef.location` either; only `workspace show` is checked. A project whose backend block was edited, or that falls back to an empty local backend, can produce `NOTHING_TO_DESTROY` or a plan of another copy of the state under the typed target and the validated label.
- **Dependencies, inputs and providers are the caller's assertion.** `resolved.dependencies`, `resolved.inputs` and `resolved.providers` come from the request file and are compared with the manifest, not with what ran. The Terraform adapter binds the project files, the lock file (which covers providers) and module sources (it refuses any module that is not a directory inside the project); it does not hash `.terraform`, and `TF_VAR_*` values are not compared with `resolved.inputs`. The Pulumi adapter binds program files only. `executionManifestSha256` is any 64-hex string the caller puts in both the manifest and the request; nothing in the repository defines or recomputes that manifest.
- **The ordinary preview carries the destroy-preview label.** `finalizeEvidence` labels from the binding, so a `PREVIEW` run is stamped `ARTIFACT_VALIDATED_DESTROY_PREVIEW` with `verdict: null`. A consumer must read `operation` as well as `label`. (Pinned by a test; a distinct label is a later change.)
- **`configured` is weak.** An identity counts as configured when any non-empty `ALZ_<IDENTITY>_*` variable exists, including one the profile never injects or one the runner refuses. The Terraform adapter now fails on any variable the runner refuses; the Pulumi adapter fails only on its backend URL. Nothing sets `AWS_EC2_METADATA_DISABLED`, so on a cloud host the SDK's default chain could fall back to the host's role.
- **The collapse check misses non-secret identifiers.** Identical `AWS_ROLE_ARN`, `AWS_PROFILE`, `ARM_CLIENT_ID` and similar values in both identities are not flagged (it compares only secret-looking names).
- **The command reads more than the two identities.** Besides `ALZ_DISCOVERY_*` and `ALZ_STATE_*`, the runner reads `ALZ_NETWORK_*`, `ALZ_APPROVED_HOSTS` (approves extra hosts for URL variables such as `PULUMI_BACKEND_URL`), `ALZ_TOOL_DIRS` (which executable runs) and locale and time zone variables. Do not leave `ALZ_APPROVED_HOSTS` or `ALZ_TOOL_DIRS` set in a shell you do not control. In PROJECT mode project code (Terraform providers, modules and `external` data sources, the Pulumi program) holds the DISCOVERY credentials, and for Pulumi that includes backend access and `PULUMI_CONFIG_PASSPHRASE`.
- **A killed plan can leave the backend locked.** The runner ends a timed-out child with SIGKILL, so an engine cannot release its lock. The driver never offers `force-unlock`. If a preview times out or is killed, check the backend lock and release it with the engine's own tooling as the state owner, not through this driver.
- **Engine error text is only partly kept out of diagnostics.** On a failed step the shared runner puts a sanitized excerpt of stderr into its debug diagnostic `detail`, regardless of the profile's `suppressExcerpts`. The command opens no debug context, so those events are dropped today; running the driver under `src/debug/run.ts` would record them.
- **`target.backend` and `target.account` accept a URL with credentials in it** (the character class allows `:` and `@`). Such a value would be copied into the manifest, the prompt and the evidence. Give credentials only through `ALZ_<IDENTITY>_*` variables, never in the target.
- **The core tests use fake adapters.** The adapters have their own tests (below). The core checks that the request's target equals the unit's recorded backend and workspace or stack as strings; it does not inspect a backend.
- **Identity checks look at configuration, not at cloud permissions.** "Configured" means a non-empty `ALZ_<IDENTITY>_*` variable exists. The driver cannot prove the credentials are short-lived, read-only or scoped to the right state object; that is cloud-side policy and qualification.
- **The collapse check compares values of secret-looking variable names** (`collapsedIdentityVariables`). Two different keys for the same principal are not detected.
- **Evidence redaction cannot recognize an arbitrary secret.** The shape, character-set and size rules stop raw documents and most smuggling. A secret that fits inside an address or version string the rules allow would pass. Canary tests prove the planted cases only.
- **Restrictive addresses fail closed.** A resource address containing a character outside the allowed set (for example a `for_each` key with a comma) makes the evidence get rejected rather than being recorded.
- **The ordinary preview shares the sealed manifest.** The manifest's `operation` field is `DESTROY_PREVIEW`, so an ordinary preview is bound to the same approved inputs and unit; it is not a separately approved artifact.
- **The state version is the adapter's report.** The driver validates its format and records it; it does not read state itself, so it cannot confirm the adapter read the version it says.
- **A process-level race remains.** The snapshot is read-only and verified immediately before the run and again after it, but root or the owner can still change it in between (`docs/artifact-binding.md`). Neither adapter runs in the snapshot: each runs in a writable copy and compares the copy with the manifest after every process.
- **Cleanup failure is loud, not silent.** If removing the snapshot or scratch directory throws, the exception propagates and the result is lost; the driver does not report success over leftover plan files. The scratch tree is made writable before it is removed, so a read-only directory left by project code does not stop it. (The sandbox these tests ran in is root, which can remove a read-only tree anyway, so that test cannot tell the two removals apart here.)
- **Signals are handled late, and SIGKILL not at all.** See Cleanup.
- **Environment minimization is not isolation** for executable project code, and the network is not confined by this layer (`docs/runner-hardening.md`).
- **Not done:** no ledger entry or observability event is written (control 9 of the review); no compromise-state or environment opt-in check (control 4); operator console wiring; Pulumi qualification; account and backend resolution.

## Cleanup

Plan files, work copies and snapshots are plaintext material, so they are removed three ways. (1) The `finally` in `run()` and in each adapter. (2) `src/teardown/driver/cleanup.ts` keeps a registry of removers; the driver registers its scratch directory and snapshot, and `runDriverCommand` installs SIGINT, SIGTERM and SIGHUP handlers around the run that call `runCleanups()` and exit `128 + signal`. Without a handler Node ends the process at once on those signals and no `finally` runs (reproduced); with one, the signal is held until the current step ends. (3) At startup the command removes `alz-preview-*`, `alz-snapshot-*` and `alz-child-*` directories of the same account in the scratch parent (or the system temp directory) that are over an hour old, never following a link.

Limits, exact: the engine runs under a blocking call (`spawnSync` in the shared runner), and Node cannot run a signal handler while the thread is blocked in it. A Ctrl-C from the terminal also reaches the engine, so the step ends and the handler then runs. A signal sent to the node process alone (a supervisor's SIGTERM) is handled when the current step ends, which can be up to the 120 s timeout later, and the engine keeps running (and holding its lock) until then. The handler cannot kill the engine's process group, because it cannot run while the engine does. SIGKILL cannot be handled; the next run's sweep removes what it left once it is over an hour old. Making the steps asynchronous so a signal is handled at once would change `src/tools/process.ts`, which this change does not touch.

## Tests

`test/teardown-cleanup.test.ts`: the registry, read-only trees, links, the stale sweep and a real SIGTERM sent to a child process during a blocking step.

`test/teardown-driver.test.ts`: one test per refusal in the check order, each asserting the adapter was not called and nothing was left behind (including all three confirmation fields, eight spellings of an unknown field and nested unknown fields, the qualification cases, each manifest field, a planted state file and link, and a snapshot altered after it was made); the destroy-preview and ordinary-preview happy paths with a fake adapter that inspects the snapshot and scratch modes; the state version recorded apart from an unchanged manifest hash; a `BLOCKED` verdict from the existing gate; a state-derived run with no snapshot; cleanup when the adapter throws and when the evidence is rejected; eight kinds of mismatched evidence; canary secrets absent from evidence and result; the proof catching eight ways of smuggling raw content; qualification independence between engines; and the source and broker boundary scans.

## Pulumi adapter (TypeScript programs)

**Status: implemented and DISABLED.** `src/teardown/driver/adapters/pulumi.ts` (`createPulumiAdapter`, `pulumiAdapter`). No Pulumi CLI exists in the build sandbox, so no flag below has been run against a real binary. No qualification record is bundled, and none is exported from the module; the driver refuses the engine (`ENGINE_NOT_QUALIFIED`) until a record for this adapter version, this argv digest and the pinned Pulumi version is supplied. A qualified Terraform or OpenTofu adapter is not held back by it.

### Pinned argument lists

All of them are `PULUMI_ARGV` in one place; `PULUMI_ARGV_DIGEST` is `argvDigest(Object.values(PULUMI_ARGV))`, so changing any list stops an existing record from matching. `<stack>` is the only value filled in at run time (the request's stack, validated as one to three segments of `[A-Za-z0-9._-]`, none starting with a dash or being `.`/`..`).

| Name | Argument list | Used for |
| --- | --- | --- |
| `VERSION` | `pulumi version` | Engine version observed (compared with the validated one by the driver) |
| `STATE_EXPORT` | `pulumi stack export --stack <stack> --non-interactive` | State version, read before and after the preview |
| `DESTROY_PREVIEW_PROJECT` | `pulumi destroy --preview-only --non-interactive --stack <stack> --json --run-program` | Destroy preview, PROJECT mode (the program runs) |
| `DESTROY_PREVIEW_STATE_DERIVED` | `pulumi destroy --preview-only --non-interactive --stack <stack> --json --run-program=false` | Destroy preview, STATE_DERIVED mode (no program) |
| `PREVIEW_PROJECT` | `pulumi preview --non-interactive --stack <stack> --json` | Ordinary preview, PROJECT mode |

`isAllowedPulumiArgv` is an exact match against these lists, checked again before every run. A `destroy` subcommand matches only with `--preview-only`. `up`, `refresh`, `cancel`, `stack rm`, `stack import`, `state` edits, `--yes`, `--show-secrets`, any extra flag and any other stack value are not matches, and a test lists each. No lock flag exists in any list: locking stays on. A destroy preview asks the CLI for a plan; it never calls a real destroy and relies on a prompt or a cancellation.

### Modes

- **PROJECT.** The TypeScript program runs in a writable copy of the immutable snapshot (`scratch/work`), never in the snapshot itself, which the program's own account could rewrite. The copy is compared with the manifest before and after the program (`PROJECT_CHANGED` fails the run), and the driver verifies the snapshot again afterwards. Needs `PROJECT_CODE_EXECUTION` (checked by the driver, and again by the adapter). The manifest is bound by program files, dependencies, providers, inputs and target.
- **STATE_DERIVED.** A destroy preview that reads state and runs no project (`--run-program=false`, no snapshot, run in the private scratch directory). Needs no `PROJECT_CODE_EXECUTION`, and still needs the approved execution manifest: `resolved.executionManifestSha256` must equal the manifest's, otherwise `REVIEW_REQUIRED`. No project hash is implied. An ordinary preview is not offered in this mode (the driver returns `MODE_NOT_SUPPORTED`).

### Identities

Run through `runBoundedProcess` with `options.identity`, never the operator's environment. `PULUMI_CONFIG_PASSPHRASE`, `PULUMI_ACCESS_TOKEN` and cloud keys reach a child only as `ALZ_STATE_*` or `ALZ_DISCOVERY_*` variables (the shared `pulumi` profile lists what is injectable).

- `STATE`: `version`, both `stack export` reads (run in an empty directory, `scratch/state-steps`, never where the project is; each is refused if that directory, or the scratch directory beside the work copy, gained a file), and the state-derived destroy preview (it reads state, runs no program and refreshes nothing, so it needs no provider reads).
- `DISCOVERY`: the PROJECT-mode preview and destroy preview. The program runs there, so it gets provider-read credentials and never the state identity.

**Documented exception.** `pulumi destroy`/`preview` read the backend and run the program in one process, so in PROJECT mode the DISCOVERY identity must also be able to reach the backend (`ALZ_DISCOVERY_PULUMI_BACKEND_URL` is required). This is the case `docs/teardown-broker-review.md` Decision 3 says must be documented and qualified: the cloud-side policy for DISCOVERY has to be read-only on the backend object, and the lock must remain takeable. The adapter requires, before running anything, that each identity it uses names the exact backend the person typed (`ALZ_<ID>_PULUMI_BACKEND_URL` equals `target.backend`), and fails if the runner refused that variable (an unapproved host needs `ALZ_APPROVED_HOSTS`). There is no fallback from one identity to the other.

### State version and evidence

The state version is `PULUMI_CHECKPOINT_VERSION` with the value `<checkpoint version>:<sha256 of the stack export>`, read before the preview and again after it; if they differ the run fails ("state changed while the preview ran"). The export is hashed and dropped; its content is never kept. The preview JSON is reduced by the existing `normalizePulumiPreview` to address (URN), type and operation, and the raw output is discarded. Plan, export and stderr are never logged (the profile suppresses excerpts) or put in evidence; an adapter failure carries only a fixed message and the driver forwards none of it. The adapter writes no plan file, so there is nothing to delete beyond the scratch directory the driver removes. A preview document without a `steps` list is a failure, not "nothing to destroy".

The runner profile for these runs is `PULUMI_PREVIEW_PROFILE`: the shared `pulumi` profile with the output cap raised from 1 MiB to 8 MiB for large stacks. The 120 s timeout is unchanged.

### Flags not verified (qualification must confirm each on the pinned Pulumi version)

`PULUMI_UNVERIFIED` lists these in code.

1. `destroy --preview-only` exists, takes the backend lock the way a destroy does, and changes nothing. The decision cites it; it could not be checked.
2. `--run-program` (project run) and `--run-program=false` (no program) on `destroy`: the spelling, and that `false` really runs no program. Cited by the decision; unchecked.
3. `destroy --preview-only --json` prints one JSON document whose `steps` list has the shape of `preview --json` (`op`, `urn`, `type`). The normalizer is the one used for `preview --json`.
4. `destroy --preview-only --non-interactive` needs no confirmation flag and exits 0 on success.
5. `preview --json` and `--stack` on both commands.
6. `stack export --stack` prints `{ version, deployment }` on stdout with secrets left encrypted (no `--show-secrets` is ever passed).
7. `version` prints `v<major>.<minor>.<patch>`. The adapter requires it to equal `resolved.engineVersion` before any export, preview or program runs.
8. The state steps work from an empty directory with the stack name as recorded in the deletion unit; the CLI may need a project file or a fully qualified `org/project/stack` name there. In PROJECT mode this now applies too, because the state steps no longer run in the project.
9. A writable work copy is enough for a PROJECT run (`pulumi` finds `Pulumi.yaml` and the program there).
10. A `Pulumi.yaml` in a parent directory of the scratch directory (for example a planted `/tmp/Pulumi.yaml`) is not picked up by a run that has no project. Not checked; the scratch parent should be a private directory.

A record is supplied only after the above pass; it carries the adapter version, the argv digest and the Pulumi version, and `evidenceHash` of the qualification evidence.

### Limits specific to this adapter

- **No Pulumi was run.** Tests use a fake `pulumi` (a node script) that records argv, cwd and environment and prints canned JSON holding canary secrets. They prove the adapter's behavior around the CLI, not that the CLI accepts the flags.
- **The snapshot omits `node_modules`** (`src/teardown/snapshot.ts` never copies it), and a TypeScript program needs its dependencies. How PROJECT mode gets them installed, and that they match the manifest's `dependencies`, is not solved here and is part of qualification. Pulumi also needs `node` reachable through `ALZ_TOOL_DIRS` (`docs/runner-hardening.md`); the PATH is the approved directories, never the inherited one.
- **Component URNs fail closed.** A child of a component resource has `$` in its URN, which is outside the evidence address character set, so evidence is rejected rather than recorded. The restriction belongs to the core evidence rules, not this adapter.
- **No refresh.** Neither destroy preview passes `--refresh`, so it plans from recorded state, not from live resources. Live drift is out of scope for this preview.
- **Diagnostics label.** The runner's `tool` label must be a broker `ToolName`; these runs use `pulumi_version` and `pulumi_preview` as labels only. The adapter is not a broker tool and is not reachable from `src/tools`.
- **The backend check compares configuration, not a connection.** It confirms what the identity is configured to use; it cannot see which backend the CLI actually contacted.
- **Wired in, disabled.** `src/cli/teardown-driver.ts` registers this adapter, and it still refuses to run without a matching qualification record. None ships. The adapter is not exported from `src/teardown/driver/index.ts`.

Tests: `test/teardown-adapter-pulumi.test.ts` (exact argv per mode and per identity, no export or program on an unqualified engine version, a program that rewrites a project file or plants one beside its work copy, read-only leftovers, `--preview-only` on every destroy path, the allowlist rejections, no program in STATE_DERIVED, canaries absent, denial with no matching record, denial without `PROJECT_CODE_EXECUTION`, state-derived needing the execution manifest, fail-closed cases, the output cap, and a source scan).

## Terraform and OpenTofu adapter

`src/teardown/driver/adapters/terraform.ts` is one adapter for both engines (`createTerraformAdapter("TERRAFORM" | "OPENTOFU", { toolDirs? })`). They share every argument list and differ only by executable (`terraform`, `tofu`), each under its own existing profile in `src/tools/profiles.ts`. The adapter is reachable only through the driver; it is not in the broker.

### What it runs

Inside the driver's private scratch directory, never in the read-only snapshot. The snapshot is copied to `scratch/work` (fresh modes, no links), and the plan file is `scratch/alz-preview.tfplan`, a sibling of the work directory.

| # | Argument list (exported constant) | Identity |
| --- | --- | --- |
| 1 | `version -json` (`VERSION_ARGV`) | none |
| 2 | `init -input=false -no-color -lockfile=readonly` (`INIT_ARGV`) | STATE |
| 3 | `workspace select <name>` (only when the target workspace is not `default`), then `workspace show` | STATE |
| 4 | `state pull` (`STATE_PULL_ARGV`), read in memory for its `serial` only | STATE |
| 5 | destroy preview: `plan -destroy -input=false -no-color -out=../alz-preview.tfplan` (`DESTROY_PREVIEW_PLAN_ARGV`); ordinary preview: the same without `-destroy` (`PREVIEW_PLAN_ARGV`) | DISCOVERY |
| 6 | `show -json ../alz-preview.tfplan` (`SHOW_ARGV`), read into memory | none |
| 7 | `state pull` again; the serial must equal step 4's, otherwise `STATE_CHANGED` | STATE |

"None" means the step is run with the `ALZ_DISCOVERY_*` and `ALZ_STATE_*` variables removed from the environment it is given, so it receives no credentials at all (the runner still requires an identity name, and it finds nothing to inject). Neither identity inherits the operator's credentials or falls back to the other.

Modules: after `init` and again before the plan, `.terraform/modules/modules.json` is read and the run fails (`MODULE_SOURCE_NOT_LOCAL`, `MODULE_OUTSIDE_PROJECT`, `MODULES_UNREADABLE`) unless every module is a directory inside the project, whose files the manifest hashes. A registry version range or a git ref can resolve to different code after review, and that code would run in the plan with the DISCOVERY identity. A `.terraform` directory that arrives with the snapshot is refused (`PRE_EXISTING_TERRAFORM_DIRECTORY`). A credential variable the runner refuses fails the step (`ENVIRONMENT_REFUSED`) instead of running with no identity.

Before and after: the work copy is checked against the manifest's file list before anything runs, again right after `init`, again before the plan and after it. Any added, missing or changed file (including the lock file, whose bytes must hash to the manifest's `lockFileSha256`) fails closed. The engine version `version -json` reports must equal the validated `resolved.engineVersion` before `init` runs. After `show`, only address, type and operation of each change are kept (the repository's own `normalizeTerraformPlan` / `normalizeOpenTofuPlan`), the raw JSON is dropped, and the plan file and work directory are removed in a `finally`. The state version is recorded as `TERRAFORM_SERIAL` from the pulled state's `serial`; nothing else from the state is kept.

### Pinned and allowlisted

`isAllowedArgv(engine, executable, args)` is an exact match against the lists above (the workspace name is the one parameter and must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,89}$`), and every process goes through it before the runner sees it. `isAllowedDestroyPreviewArgv` is the exact match for the single destroy list. A test pins that the only `"-destroy` literal in `src/` is in this file, once, and runs about fifty mutation-shaped argument lists (apply, destroy, `-lock=false` in several positions, `-target`, `-replace`, `-var`, `-refresh=false`, `state rm|push|mv`, `force-unlock`, `import`, `taint`, `workspace delete|new`, a different `-out`, reordered flags, `-DESTROY`, the other engine's executable) against both functions. There is no `-lock` flag in any list. `dangerousPreviewCommand` in `src/qualification/provider-production.ts` is unchanged and still flags the destroy list, which is what keeps the destroy path from ever being mistaken for an ordinary preview.

`adapter.argvDigest` is `argvDigest()` over every list with the executable first (the workspace name as `<workspace>`), so a Terraform record never qualifies OpenTofu. The adapter version is `1.0.0`.

### Output cap

The runner's default 1 MiB cap is too small for a large `show -json`. `show` and `state pull` run under a profile derived from the engine's own with `maxOutputBytes` of 32 MiB (`LARGE_OUTPUT_BYTES`). The output is held in memory only, never logged (excerpts stay suppressed) and never put in evidence. Output past the cap fails closed instead of being parsed. The timeout is unchanged (120 s).

### Not verified or not covered

Be exact about these.

- **No real Terraform or OpenTofu was available.** Neither binary is installed in this sandbox, and nothing was downloaded. Every test above runs a fake executable, so the real CLI's acceptance of these flags is unverified here: `-lockfile=readonly`, `-out=../alz-preview.tfplan` (a relative path above the working directory), `show -json` of that file, `workspace select`/`show`, `state pull`, and the field names `terraform_version` (also assumed for `tofu version -json`), `serial` and `format_version`. One test runs the same constants against a real `terraform` if one is in the approved tool directories (an empty project using only the built-in `terraform_data` resource and a local backend) and is skipped with a message otherwise. It was written without being run.
- **The plan step needs both kinds of access in one process.** `terraform plan` reads the state through the backend and refreshes provider resources in a single process, which can carry only one identity. The adapter gives it DISCOVERY, so the DISCOVERY principal must be able to read the selected state object and take and release the lock for the plan to work. That is the backend exception decision 3 asks to document: it must be reviewed and qualified before the engine is enabled, and it is not hidden by turning locking off. STATE is used for everything that reads state outside the plan (init, workspace, state pull).
- **The backend location and the account are not checked against the unit.** The adapter verifies the workspace the backend reports (`workspace show`) equals the target. It cannot render the configured backend as the unit's `location` string, so backend identity rests on the project files, which the manifest binds, and on the core's string comparison of target and unit.
- **Provider versions are the caller's report.** The adapter checks the engine version and the lock file hash; it does not compare `resolved.providers` with what `init` installed. The lock file hash is what binds them.
- **`init` runs provider installation** under STATE credentials, with network access limited only as the runner limits it (`docs/runner-hardening.md`). It can download providers; it does not verify provider binaries.
- **The manifest check does not hash `.terraform`.** File hashing skips `.terraform`, `.git`, `.pulumi`, `node_modules` and `.agentic-private`; module sources are checked as above, but provider binaries and anything else under `.terraform` are not hashed (the lock file covers provider versions). `resolved.inputs` is not compared with the `TF_VAR_*` values the plan receives. Anything `init` or the plan writes elsewhere is outside the check (the runner's per-process `HOME` and `TMPDIR` are removed afterwards).
- **Executable plans run provider code** (and any `external` data source) with the DISCOVERY credentials; environment minimization is not isolation. That is why the driver requires `PROJECT_CODE_EXECUTION`, which never grants mutation.
- **A resource address with a character outside the evidence rules** (for example a `for_each` key containing a comma) makes the driver reject the evidence rather than record it.
- **The 120 s timeout may be short for a large refresh.** It was not raised. A timed-out run fails closed with an adapter failure, and the runner's SIGKILL leaves the backend locked (see Limits). The driver never force-unlocks.
- **No qualification record ships.** A record needs a real run of this adapter against a pinned engine version; supply one only then.

### Tests

`test/teardown-adapter-terraform.test.ts` (fake `terraform` and `tofu`, canary secrets in the canned plan, state and stderr): exact argv per operation and order, including the workspace path and the ordinary preview; no lock, refresh, target, replace, var or auto-approve flag in any call; identities delivered as injected per step with the operator's environment, the other identity and every `ALZ_` name absent, and no fallback when an identity is missing; the plan file only inside the private directory, present at `show`, nothing left afterwards (also after each step fails) and nothing run in the snapshot; evidence free of every canary; failure messages carry only a code; `init` editing a file, adding a file, rewriting the lock file or writing local state is refused with no plan run; a wrong lock hash, engine version, engine or workspace is refused before the step that depends on it; OpenTofu identical except for the executable and digest; the exact-match allowlist against the mutation-shaped list; the unchanged `dangerousPreviewCommand`; the source scan for the single `-destroy` literal; the output cap; both engines end to end through `runDestroyPreview`, a qualified engine running while an unqualified one is refused, and an ordinary preview through `runPreview`; and the optional real-binary test.

## Human invocation

`./alz teardown destroy-preview-run` (destroy preview) and `./alz teardown preview-run` (ordinary preview) are the only entry to the driver. They are separate operations, as in the core. The code is `src/cli/teardown-driver.ts`; `src/cli/teardown.ts` dispatches to it. It is not a broker tool, and the console server, `src/operator-ui/**`, `src/agent/**` and `src/tools/**` do not import or mention it (a test scans them, and the 39-tool allowlist is unchanged).

```
./alz teardown destroy-preview-run --request REQUEST.json --manifest MANIFEST.json \
    --unit UNIT.json --qualifications QUALIFICATIONS.json
```

Those four flags are the whole interface. Anything else is refused with exit 1 before a prompt, a file read or an engine run: `--force`, `--yes`, `-y`, `--assume-yes`, `--auto-approve`, `--skip-*`, `--ignore-*`, `--override` and every other spelling, with or without a value, and positional arguments. A flag given twice, or without a value, is also an error.

| Input | Content |
| --- | --- |
| `--request` | JSON: `engine`, `mode`, `target` (`account`, `backend`, `workspace` or stack), `projectRoot`, `policyVersion`, `resolved`. It must **not** carry `invocation`, `manifest`, `unit` or `capabilities` (exit 1): the command supplies them. Capabilities are what the person confirms at the prompts, never a field in a file. Any other unknown field reaches the driver and is refused as `UNKNOWN_REQUEST_FIELD`. |
| `--manifest` | The approved, sealed manifest. Re-verified (shape and seal) before anything is shown. |
| `--unit` | The recorded deletion unit. |
| `--qualifications` | A JSON array of `QualificationRecord`. An engine with no matching record does not run; Pulumi ships with none (see above and the Pulumi adapter's `PULUMI_UNVERIFIED` list), so it is refused until one is supplied. |

The two identities come from `ALZ_DISCOVERY_*` and `ALZ_STATE_*` in the environment and nowhere else, and the command takes no credential from a file. The environment is passed to the runner whole, which also reads `ALZ_NETWORK_*`, `ALZ_APPROVED_HOSTS`, `ALZ_TOOL_DIRS` and locale variables (see Limits).

### The prompt

1. **A terminal is required on stdin and stdout.** If either is not a TTY the command exits 1 with `HUMAN_TERMINAL_REQUIRED`, before reading any input file, with no prompt. No flag, file or variable waives this, so piped input, `yes |`, here-documents and CI cannot start a preview.
2. It shows the operation, account, backend, workspace or stack, engine and mode, the manifest hash and that it reads cloud state and resources with the read-only identities, then the exact target string `account | backend | workspace`.
3. The operator types that string. Comparison is exact (no trimming, no case folding). Anything else exits 1 with `HUMAN_CONFIRMATION_MISMATCH` and nothing runs. A target containing control characters is refused before the prompt, so the display cannot be spoofed.
3a. In PROJECT mode a second prompt states that the preview runs project code (providers, modules, the program) with the DISCOVERY identity, shows the project root and the number of bound files, and asks for `RUN PROJECT CODE`. Anything else exits 1 with `PROJECT_CODE_CONFIRMATION_MISMATCH` and nothing runs. This is the only source of `projectCodeExecution`; STATE_DERIVED mode runs no project code and has no second prompt.
4. Only then does the command build the driver's `HumanInvocation` (operator account name, `interactiveSession: true`, the typed target, the time) and call `runDestroyPreview` or `runPreview`.

**Test-only seam.** `runDriverCommand(command, args, deps)` takes `deps.terminal`, a `HumanTerminal` (`stdinIsTTY`, `stdoutIsTTY`, `write`, `ask`), so tests can drive the prompt without a TTY, and `deps.adapters` so they can use a fake adapter. These are function parameters: nothing on the command line, in the environment or in a file reaches them, and `teardown.ts` passes neither. This prompt keeps out pipes and CI, not a pseudo-terminal (see Limits). Tests still check that the TTY requirement and the exact-match rule apply to the injected terminal.

### Output and exit codes

Stdout carries only the redacted evidence JSON (`PreviewEvidence`), after `assertNoRawPayload` runs once more on it. Refusals print one line to stderr (code, fixed message, and for `REVIEW_REQUIRED` the names of the differing fields). Input errors use fixed text and never quote a file, because a JSON error can quote its content.

| Exit | Meaning |
| --- | --- |
| 0 PASS | Evidence printed; for a destroy preview the verdict is not `BLOCKED` (`READY_FOR_AUTHORIZATION` or `NOTHING_TO_DESTROY`). |
| 2 BLOCKED | The contract said no: a `BLOCKED` verdict (evidence is printed), `REVIEW_REQUIRED` and every other driver refusal (unqualified engine, missing capability or identity, unit or target mismatch, snapshot changed, unknown request field, invalid manifest). |
| 1 error | Nothing was decided: bad flags or input, no terminal, wrong typed target, adapter failure, evidence rejected or withheld. |

A `READY_FOR_AUTHORIZATION` verdict authorizes nothing. ACT stays DISABLED, and the command has no apply, destroy or shell path.

### Not verified

- The real terminal prompt (`processTerminal`, `readline` on a TTY) was not exercised by a test, because the test environment has no TTY. Tests cover the TTY refusal with a real piped child process and the prompt logic through the injected terminal. Run the command once at a real terminal before relying on it.
- The shipped adapters were not run end to end through this command, as no Terraform, OpenTofu or Pulumi binary exists in the sandbox; the command's tests use a fake adapter.
