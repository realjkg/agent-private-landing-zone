# Pilot apply: operator runbook

Status: implemented and tested **with a fake engine only**. It has never been run against a real Terraform engine or a real Azure subscription, and the qualification and identity separation it depends on are only attested, by a person, once they complete the real-engine run below (G2); nothing in the code proves them. A fake-engine test pins logic, not behavior. Live apply stays blocked until the owner supplies the values at the end of this page and that evidence exists.

The pilot plan is in PR #117 and is not merged: until it merges there is no `docs/act-pilot-plan.md` on this branch, and the plan references in code comments point at that PR. The preview driver this builds on is `docs/destroy-preview-driver.md`.

## Authority

The operator authorizes, the driver enforces, and agents never initiate. ACT stays DISABLED globally. It is enabled for the pilot only while `config/act-pilot-contract.json` is valid, has `enabled: true`, and hashes to the committed pin (see "The contract and its pin"). The console shows the command (`./alz apply`) as a handoff and never runs it. `test/apply-boundary.test.ts` pins that nothing the broker, agents, orchestration or the console can reach imports the apply path.

An apply runs exactly the sealed plan file that was previewed and approved (`terraform apply <planfile>`). Nothing is regenerated between approval and apply. There is no `-auto-approve`, `-target`, `-replace`, `-refresh=false` or `-lock=false`, and locking stays on. Production is a separate production-target sealed plan with its own approvals. It is bound to the qualified release through `releaseIdentity` (project files, lock file, engine and provider versions, shared inputs), and it needs a successful DEV apply record with the same `releaseIdentity`. It does not need the DEV manifest hash, because manifests are target-bound.

## What a person, a terminal and a signature each prove

A terminal is not authentication. Every subcommand needs a terminal on stdin and stdout, and that only means a person, or a script holding a pseudo-terminal, is typing; it proves nobody. Typed confirmations prevent mistakes (the wrong target, the wrong plan). They are not identity.

Signatures are the authentication. An approval is an Ed25519 signature, by a key in the contract's `approvers` list, over the artifact hash, environment, exact target, expiry and a one-time nonce. A typed name is never proof. The key is a file you name (mode 0600), never read from the environment. Whoever holds an approver's private key is that approver, so approver key custody is an operational control, not something the code enforces: each approver should keep their key on their own device, and the contract's allowlist is reviewed in the commit that changes it. The code cannot tell whether one person holds two keys.

An approver does not need the operator's evidence key, the vault or the sealed plan. They need the review bundle (below), the contract, and their own key file.

Production's two-person rule means two distinct allowlisted approvers with two distinct keys, both signing the same artifact. It is not a check on who runs `apply`: the operator's account name has no bearing, and the same person holding both keys defeats it. Approvals are consumed once, before the engine runs.

## Who is inside the trust boundary

The operator who runs the commands is the same user ID as the process, and holds the evidence key, the working tree, the contract and the pin file, and sets the identity variables. For key material that operator is inside the trust boundary. The pin, the encryption and the ledger make a change reviewable and tampering detectable by anyone who does not hold the key; they do not stop the operator, who could re-encrypt evidence, forge qualification evidence, edit the ledger, or edit the contract and its pin together. The pin is reviewable, not enforced, against a writer with that user ID. The identity checks below catch mistakes and crafted environments, not the operator. Independence comes from the second approver, the contract reviewed in version control, and the cloud-side role assignments, not from this code. The encrypted recovery files and evidence protect against other accounts and backups, not against the operator.

## Commands

Every subcommand refuses before reading any file unless it has a terminal on stdin and stdout. There are no flags that force, skip or pre-answer anything; an unknown flag is an error.

| Step | Command | Who |
| --- | --- | --- |
| Qualify | `./alz apply qualify --request REQUEST.json --manifest MANIFEST.json` | Operator, once per adapter or engine version, DEV only. See "Qualifying against a real engine". |
| Seal | `./alz apply seal --request REQUEST.json --manifest MANIFEST.json` | Operator. Types the target, then `RUN PROJECT CODE`. Prints the artifact hash, the sealed plan path, the review bundle path and the redacted change list (address, type, action). |
| Approve | `./alz apply approve --bundle REVIEW_BUNDLE.json --key APPROVER_KEY.pem --approver ID` | Each approver, separately, with no evidence key. Reviews the changes, types `APPROVE <DEV, QA or PROD> <first 12 characters of the artifact hash>`. Prints a signed approval; no secret. |
| Apply | `./alz apply apply --request REQUEST.json --manifest MANIFEST.json --sealed SEALED_PLAN --approval A.json [--approval B.json]` | Operator, with the evidence key (it loads the sealed plan from the vault). Types one line: `APPLY <DEV, QA or PROD> <first 12 characters of the artifact hash> <account> \| <backend> \| <workspace>`. Prints redacted evidence. |
| Status | `./alz apply status [--sealed SEALED_PLAN]` | Anyone at a terminal. Read-only: contract state, kill switch, and whether an artifact was applied. |

There is no `--allowlist` and no `--qualifications` file. The approver allowlist is part of the pinned contract, and qualification records are read from the encrypted evidence vault (`.runs/apply/qualification`), where a record exists only if valid, decryptable evidence does.

Request files carry only `environment`, `target` (`account`, `backend`, `workspace`) and `projectRoot` (seal and qualify also `policyVersion` and `resolved`). The command supplies the invocation, manifest and approvals; a file that carries them is refused.

### The review bundle

`seal` also writes a review bundle beside the sealed plan, at `<sealed plan path>.review.json` (mode 0600), and prints its path. It holds `artifactSha256`, `planSha256`, `manifestHash`, `releaseIdentity`, `environment`, `target`, `engineVersion`, `policyVersion`, `createdAt`, `changes` and `changesSha256`. It holds no plan bytes and no plan, state or variable values, so it is not secret and the operator can send it to approvers on any channel.

`approve` reads only that file. It checks the exact field set, recomputes `changesSha256` and the artifact hash from the bundle's fields with the same function the sealer uses (`computeArtifactSha256`), and refuses on any mismatch (`ARTIFACT_TAMPERED`) or malformed field (`ARTIFACT_INVALID`) before it asks anything. It then shows the changes and the target, and the approver types the environment and the first 12 hex characters of the artifact hash. A bundle that was edited cannot get a signature for another plan, because the change list and target are inside the hash. What the check does not prove is that the vault holds a plan with that hash; if it does not, `apply` refuses (`ARTIFACT_INVALID`) and the approval is wasted, not misused. The approver reads a change list, not the plan; the apply re-derives the list from the plan bytes (see "Plaintext on disk").

### What the change list shows

One list, derived in one place from `terraform show -json` and bound by `changesSha256` into the artifact hash, so the seal, the review bundle, `approve` and `apply` all show and hash the same thing. Each line has an action, an address and a type. It also says when a resource is being **imported** (`importing`), **moved** (`previousAddress`, a plan that renames state), or **forgotten** (action `FORGET`: dropped from state while the real resource is left running). Each output whose value changes is a line with address `output.<name>` and type `output` (its name and action only, never its value). Bidi and zero-width control characters (U+200B-200F, U+202A-202E, U+2060-2064, U+2066-2069, U+FEFF) are stripped from addresses and types when the list is derived, so what is hashed is what is shown; a stored list that still has one is `ARTIFACT_INVALID`, and every display strips them again.

### Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Done. | |
| 1 | Error, and nothing was spent: bad input, no terminal, a wrong confirmation, a stop signal before the engine started, or the engine could not start (`APPLY_FAILED` with "no approval was consumed"). | Fix the cause and run again. |
| 2 | BLOCKED: the contract refused before any action (disabled or unpinned contract, kill switch, wrong target, unverified or insufficient approvals, artifact already applied, engine not qualified, identities, missing promotion evidence, a bundle or sealed plan that does not verify). | Read the code in the message. |
| 3 | SPENT, in two cases. The engine ran and the sealed plan and its approvals are used up, whatever happened (failed, partial, killed, stale, or evidence that could not be written). Or the approvals were consumed and the engine did not start: `KILL_SWITCH_AFTER_APPROVALS` (the switch appeared) or `APPROVALS_SPENT` (the plan file could not be written, or the engine could not be spawned, for example a full disk). Nothing ran, the approvals are gone and the sealed plan is available again. | Read "When an apply fails". After an engine run, never rerun the same files. After either refusal, fix the cause (lift the switch, free the disk) and collect new approvals for the same sealed plan. |

`test/apply-cli.test.ts` pins this mapping.

## The contract and its pin

The contract (`config/act-pilot-contract.json`, shape in `config/act-pilot-contract.example.json`) names the tenant, subscription and backend for DEV, QA and PROD (different pairwise in subscription and backend, compared case-insensitively), the required approvals (DEV at least 1, QA at least 1, PROD at least 2), the approval lifetime, the kill switch path, and the approver allowlist (id, Ed25519 public key, environments). It loads only if its canonical SHA-256 equals the hash in `config/act-pilot-contract.sha256`. An empty or absent pin means ACT is disabled, which is how the repository ships. A pin that does not match is `CONTRACT_INVALID`. Release admission checks the same pin.

To enable the pilot, or to change a target or an approver:

1. Edit `config/act-pilot-contract.json`.
2. Compute its hash with `./alz apply pin`. It prints the SHA-256 and whether the contract is valid, and writes nothing.
3. Write that hash to `config/act-pilot-contract.sha256`.
4. Commit both in one reviewed change. Reviewers check the targets and each approver's key against what the owner supplied.

Paths are anchored to the repository root found from the module, never to the working directory. The pin makes a change reviewable; it does not stop the operator described above.

## Promotion: DEV, then QA, then PROD

Each stage has its own sealed plan, artifact hash and approvals, and an approval signed for one environment is `APPROVAL_MISBOUND` for another. DEV needs no earlier evidence. QA needs a successful, encrypted DEV apply record for the same release identity. PROD needs a successful QA apply record for the same release identity, and DEV evidence alone is refused (`PROMOTION_EVIDENCE_MISSING`). Identity checks are per environment: the DEV, QA and PROD credentials must differ and each must match its own contract target. `qualify` runs only against the DEV target; QA and PROD are not qualified separately and are refused.

## Identities

Four separate principals, set as `ALZ_<IDENTITY>_<VAR>` in the environment of the person running the command. None inherits the operator's credentials and none falls back to another (APPLY is never a state fallback). The driver refuses if one is missing; if two share a principal-like value (client id, secret, client certificate or config directory) even under different variable names; if any carries a variable that would let a child fall back to the az CLI, a managed identity or a certificate (`AZURE_*`, `ARM_USE_*` other than `ARM_USE_OIDC`, `ARM_MSI_*`, `ARM_CLIENT_CERTIFICATE*`); if a principal-like value equals the operator's own ambient `AZURE_*` or `ARM_*` value; or if any names a tenant or subscription other than the contract's for that environment (`APPLY` and `STATE_WRITE` must set both). Apply children receive no `AZURE_*` variable at all.

A per-identity `ARM_CLIENT_SECRET` is accepted (it is that identity's own explicit credential), so "OIDC token file only" is the recommended setup and is not enforced for secrets.

| Identity | Used for |
| --- | --- |
| `DISCOVERY` | Plan, during seal and qualify |
| `STATE` | Reading state and its serial |
| `STATE_WRITE` | `init` and workspace selection (blob write and lease) |
| `APPLY` | The provider writes in `terraform apply` |

Azure variables are `ARM_CLIENT_ID`, `ARM_TENANT_ID`, `ARM_SUBSCRIPTION_ID`, `ARM_USE_OIDC` and `ARM_OIDC_TOKEN_FILE`, for example `ALZ_APPLY_ARM_CLIENT_ID`.

## Azure state prerequisites (owner supplies)

A storage account and container per environment, with blob versioning and soft delete on, Entra ID authorization for the backend (`use_azuread_auth` or `ARM_STORAGE_USE_AZUREAD`; it is not yet on the runner profile), and role assignments scoped to that container for STATE and STATE_WRITE and to the target subscription for APPLY. Exact roles are the owner's least-privilege decision. The backend in the contract is `<storage-account>/<container>/<key>`.

## Open item that blocks live apply (G2)

For `terraform apply <planfile>`, Terraform configures the backend from the plan, and unset backend attributes fall back to the apply process's `ARM_*` variables, which are APPLY's. If so, the state write would authenticate as APPLY, collapsing the two identities. A fake engine cannot detect this and it is **not asserted anywhere in the code**.

What the code does to give separation a chance: `init` runs as STATE_WRITE with a partial backend configuration (`-backend-config=../alz-backend.tfbackend`: `use_oidc`, client id, tenant, subscription and OIDC token file path from the `ALZ_STATE_WRITE_ARM_*` variables, never a secret value, strict patterns before anything is written, mode 0600, deleted as soon as `init` ends), so the backend settings Terraform saves name STATE_WRITE; `terraform apply` then runs with the APPLY identity only. `state pull` runs as STATE, but if Terraform prefers the saved backend settings it authenticates as STATE_WRITE; that is also unproven. The apply adapter's argument lists, and so its argument digest, include that `init`. Every step (including sealing and the qualification plan) uses a Terraform profile that drops `TF_CLI_CONFIG_FILE`, `TF_PLUGIN_CACHE_DIR` and `AZURE_*`: a variable that would redirect where providers are installed from is refused (`ENVIRONMENT_REFUSED`), and the step does not run. The `Saved plan is stale` text match is likewise unverified.

The only gate is attested qualification evidence: `verifyApplyQualification` requires an encrypted vault file, named by the record's hash, for exactly this adapter version, argument digest and engine version, whose tenant and subscription equal the contract's DEV target, dated in the past and at most 30 days old. Until it exists, `ENGINE_NOT_QUALIFIED` blocks every apply. Evidence written before the tenant and subscription fields existed is rejected; run `./alz apply qualify` again.

What the fields are: `realEngine` and `backendIdentitySeparated` are **human attestations**, not machine proof. The code checks neither; nothing stops an operator with the evidence key from writing them without a run. The only machine-checked prerequisite is that `qualify` refuses to reach the attestation prompt unless the pinned steps (version, init, workspace, throwaway plan, state read) succeeded behind the usual gates; it cannot tell a real Terraform from an executable of that name on the tool path, so the real engine is the person's responsibility. **The qualification does not exercise `terraform apply`, so the first supervised DEV apply is the qualifying apply**: it is the first time the separation is observable for the write, and the owner should watch the Azure logs during it.

### Qualifying against a real engine

`./alz apply qualify` is how that evidence is produced. **It must be run by a person against the real Terraform engine, on a DEV target the owner supplied. It has not been run: this work tested it with the fake engine only.** It applies nothing and stores no plan. It runs the pilot's own steps in order: `terraform version`, `init` and workspace selection with the STATE_WRITE backend configuration, a throwaway plan of the pinned project as DISCOVERY (never stored, so it cannot be approved or applied), and the state serial read as STATE. It refuses outside DEV and with any of the usual gates unmet (contract, pin, kill switch, identities).

The code cannot see which principal Azure authenticated for state and which for resources. So after the run the command asks the person to check the Azure sign-in and storage logs for it, and to type `SEPARATED <STATE_WRITE client id> <APPLY client id>` only if the logs show state access by STATE_WRITE, provider access by APPLY, and no state access by APPLY. Anything else writes nothing. That attestation is an operator control, not machine proof. It then writes encrypted evidence for the apply adapter and for the preview adapter, and prints each adapter version, argument digest, engine version and evidence hash. `seal` and `apply` read those records from the vault.

The evidence also records the Terraform binary's sha256, the attested STATE_WRITE and APPLY client ids, and the DEV backend and workspace; `apply` refuses with `ENGINE_NOT_QUALIFIED` if any differ, so a changed binary or different principals need a new qualification. The binary hash is read once at apply time; a same-user operator who swaps the binary after that read is inside the trust boundary.

Rerun it when the engine version or either adapter's argument list changes (the digest changes with it). The `terraform apply` step itself is not exercised by qualification, since that would change infrastructure; its behavior is covered only by the first supervised DEV apply, which the owner should watch.

### Backend and identity ordering at apply (G2): partly answered by the simulation

The real Terraform 1.16.4 against the Azurite emulator (`docs/act-pilot-simulation.md`, DEV MODE ONLY) showed: `terraform apply <planfile>` uses the backend settings **embedded in the plan**, not the settings that `init` saved in the apply directory. Attributes embedded as null are filled from the apply process's own `ARM_*` variables, and an environment variable with the same name does not override an embedded value. The plan file also embeds a `-backend-config` `sas_token` in plaintext, so a sealed plan is secret-bearing (it is encrypted at rest). Tested with SAS and access-key auth only; Entra and OIDC are inferred, not run.

Consequences for this design, still to be settled with a real Azure run:

- The STATE_WRITE partial backend configuration passed to `init` at apply time is probably not what authenticates the state write. Which principal writes state follows from the seal-time settings plus the apply process's `ARM_*` variables (APPLY's).
- Keeping STATE_WRITE and APPLY distinct for the state write would therefore need the seal-time `init` to embed STATE_WRITE's non-secret settings (client id, tenant, token file path), which makes the seal-time state access write-capable. That is a trade-off for the owner, not something the code decides.
- Until a real azurerm run shows which principal wrote state, `qualify` records an attestation and not proof, and the first supervised DEV apply is where it becomes observable. Do not rely on the separation before then.

Known, not changed: Terraform contacts the HashiCorp checkpoint service on every run (the runner profile does not set `CHECKPOINT_DISABLE`; production network policy should block it), and a failed state save writes `errored.tfstate` with mode 0644 and quotes the full backend URL in its error text, which is why engine output is withheld from messages.

### The backend and provider binding

The contract's `backend` (`<storage-account>/<container>/<key>`), `tenantId` and `subscriptionId` are checked against what the project itself configures, because a project can name any backend or provider:

- **Backend.** After `init` as STATE_WRITE (`apply` and `qualify`), the driver reads `.terraform/terraform.tfstate` in the work directory and requires its backend to be `azurerm` with `storage_account_name`, `container_name` and `key` equal to the contract's DEV, QA or PROD target. Anything else, including a value that is not a string, is `TARGET_NOT_IN_CONTRACT` before the approvals are consumed. A file that cannot be read is `APPLY_FAILED` ("no approval was consumed"), not a pass.
- **Provider.** From the plan's `terraform show -json` `configuration` (at `seal`, and again at `apply` when the list is re-derived), any azurerm provider block, in any module or alias, whose `subscription_id` or `tenant_id` is a **constant** must equal the contract's for that environment (`PROVIDER_SUBSCRIPTION_NOT_IN_CONTRACT`, `PROVIDER_TENANT_NOT_IN_CONTRACT`). **Limit:** a value that is an expression (a variable, a data source, a local) is *not checkable* from the plan and is not judged, not silently accepted as safe. For those, the only controls are the identity checks (each credential must name the contract's tenant and subscription, and the provider runs as APPLY only) and the cloud-side role assignments. Owners should keep the provider's subscription out of expressions in the pilot project.

## Kill switch

Create the file named by `killSwitchPath` (example: `.runs/apply/KILL`). A switch that cannot be read counts as on. It is read at exactly these points:

1. At the start of `seal`, `qualify` and `apply` (the shared admission step, before any file or engine).
2. In `apply`, again after the engine is prepared and the change list re-derived, together with the contract, pin, target and approval re-checks, and before the approvals are consumed. A switch seen here is `KILL_SWITCH_ACTIVE`: nothing is consumed (exit 2).
3. Immediately before the `terraform apply` process is spawned. A switch seen here, after the approvals were consumed, is `KILL_SWITCH_AFTER_APPROVALS` (exit 3, nothing ran, the artifact is given back).
4. Every second while `terraform apply` runs. Terraform is sent SIGINT (its graceful stop), then SIGKILL to its process group after a grace period (60 seconds).
5. `status` reports it; it enforces nothing.

It is not read between `init`, `workspace` and the state reads. The same stop (SIGINT, then SIGKILL) happens at the 30 minute limit and when this command receives SIGINT, SIGTERM, SIGHUP or SIGQUIT while the apply is held: the signal is intercepted, the engine is stopped gracefully and the evidence is written, so the CLI does not exit mid-run. A stopped apply ends as `KILLED` whatever exit code Terraform reports. A signal before the engine starts ends the run as `APPLY_FAILED` ("interrupted", exit 1) without consuming approvals; after they are consumed, any failure before the engine starts is `APPROVALS_SPENT` (exit 3). The owner removes the file; the code never does.

## When an apply fails

Engine output is withheld everywhere because it can hold secrets. Every outcome closes the artifact: a retry needs a new preview and new approvals. These end with exit code 3. (`APPROVALS_SPENT` and `KILL_SWITCH_AFTER_APPROVALS` are not outcomes: nothing ran, the artifact is given back, the approvals are spent.)

| Outcome | Meaning | Action |
| --- | --- | --- |
| `FAILED_NO_CHANGE` | Only for a state-lock refusal (`Error acquiring the state lock`) with the state serial unmoved | Fix the cause, seal a new preview, get new approvals. |
| `PLAN_STALE` | `Saved plan is stale`, with the serial unmoved; nothing applied | Seal a new preview. |
| `PARTIAL_REQUIRES_REVIEW` | Any other non-zero exit once the apply began, or a moved serial. Terraform exits 1 for every apply error, so the exit code cannot tell a refusal from a failure halfway through | **Do not retry.** A person reviews state and resources by hand first. |
| `KILLED` | Stopped mid-apply; the state lease may still be held | **Do not retry.** Review state, the lease and resources by hand. |

The artifact is reserved in the ledger (an exclusive-create entry in state `RESERVED`) after the gates pass and before any engine step, and the evidence replaces the reservation when the run ends, so two runs holding different approval sets cannot both proceed. A reservation is given back only if the engine never started. If the process dies after the engine started (SIGKILL, power loss, an evidence write that fails), the entry stays `RESERVED`: `status` and every later apply report the artifact as already applied, and an owner reviews the state, the lease and the resources by hand, then seals a new preview. Nothing ever makes a reserved artifact applicable again.

The two text matches above (`Saved plan is stale`, `Error acquiring the state lock`) are read only from the **first** `Error:` diagnostic in Terraform's output, never from a later line, because a provider error body can quote either phrase; a run whose first error is anything else, however it ends, is `PARTIAL_REQUIRES_REVIEW`. They come from documented Terraform output and the fake engine; they are not verified against a real engine, and anything else fails safe to `PARTIAL_REQUIRES_REVIEW`.

**Recovery attachment.** After any non-success outcome the driver looks for `errored.tfstate` and `crash.log` in the engine's work directory, before the scratch directory is deleted. Found files go into the encrypted evidence vault under purpose `apply-recovery`, and the apply evidence carries `recovery: { files, sha256 }` (a count and a hash only, never contents). If the vault write fails, the result message says the files were lost with the scratch directory. That location is Terraform's documented behavior and is not verified against a real engine. The files are encrypted at rest under the same evidence key the operator holds, so this protects them from other accounts and backups, not from the operator.

## Plaintext on disk

The decrypted plan and the backend configuration exist only in a private scratch directory, are removed by their own cleanup on every normal exit and on SIGINT, SIGTERM, SIGHUP and SIGQUIT (and the plan the moment a stop is requested), and are deleted as soon as they have been used. A SIGKILL or a crash cannot run a handler. `qualify`, `seal` and `apply` therefore start with the same stale-directory sweep as the teardown CLI (`status` and `approve` never sweep, and make no scratch): directories of the running account in the system temporary directory named `alz-preview-*`, `alz-snapshot-*` or `alz-child-*` and older than one hour are removed. Younger directories (a run in another terminal) and other accounts' directories are left alone. **The sweep is skipped, with a printed notice and nothing removed, whenever the apply ledger holds a `RESERVED` entry (or an entry that cannot be read), or any `alz-preview-*` directory holds `errored.tfstate` or `crash.log`:** those may be the only record of what an apply did, and an owner reviews them by hand first. Remove the cause (finish the review, then seal a new preview, and clear the directory) and the sweep resumes. The change list approvers read is bound into the artifact hash; `runApply` re-verifies a sealed plan it is handed rather than trusting the caller's earlier check, and after `init` it re-derives the change list from the decrypted plan bytes with the pinned `terraform show -json` (no identity in the environment). A difference from the sealed list is `ARTIFACT_TAMPERED` and nothing is consumed.

## What the tests control, and what they do not

The driver trusts what the CLI hands it only as far as it re-verifies it, but the process boundary is not a security boundary: **in-process callers can forge a terminal.** Any code that runs in the same process can build a `HumanInvocation`, an `ApplyRequest` or a terminal object that says it is interactive. `checkHumanInvocation` catches mistakes and an agent that does not know the contract, not a caller that does. The control is that nothing an agent can reach imports the apply path; `test/apply-boundary.test.ts` pins that, and it is the control, so a change that weakens it is a change to the authority and needs the owner.

## Cleanup

Actual destroy is out of scope. The named cleanup owner removes pilot resources by an approved manual procedure and records it; nothing in this path automates it. The pilot change is a tagged resource group plus a Log Analytics workspace.

## What the owner supplies

Tenant and DEV, QA and PROD subscription IDs, the Azure region, tags, retention, budget and least-privilege scope, the provisioned state storage accounts (one per environment) and the federated identities, the approver public keys (and the second production approver), the execution host, the pilot scope, the cleanup owner, and a person to run `./alz apply qualify` and attest from the Azure logs. Their absence blocks live apply only; tests use explicit fixtures.
