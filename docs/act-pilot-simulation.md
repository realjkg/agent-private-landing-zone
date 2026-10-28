# Pilot apply: emulated-backend simulation

Status: run on 2026-10-11, and again on 2026-10-27 (same Terraform 1.16.4 binary, Azurite 3.37.0, all seven scenarios passing after the test's fixture and proxy-helper fixes recorded in `docs/act-pilot-simulation-aws.md`, the AWS counterpart for gate G1b), in a Linux sandbox. It runs the **real Terraform engine** against an **emulated Azure Storage backend (Azurite)** with Terraform's built-in `terraform_data` resource only. No Azure account, no real cloud resource and no registry access was used. It answers part of the open G2 questions in `docs/act-pilot-apply.md` and exercises the apply driver (`src/apply`) with the real binary. It does not replace the supervised DEV qualification.

**Gate G1b for Azure Terraform DEV: SYNTHETIC/EMULATED evidence** (owner decision of 2026-10-27, issue #39, comment 6442856302, and the test-only emulator allowance, comment 6432984515). Rerun on 2026-10-27 on top of backend pinning (`docs/act-pilot-backend-pinning.md`) and Entra-only state authentication. The product writes its own `zzzz_alz_backend_override.tf` with an empty `backend "azurerm" {}` block and supplies every backend setting itself, including `use_azuread_auth = true` (see "G1b on the Entra-only backend" below). The project's own backend block therefore no longer carries the emulator's settings. All ten real-engine scenarios pass, and so do the seven default-CI guard tests (below). This is **emulated evidence, labeled as such**: it is not live provider qualification and not release approval. **Entra ID authentication to the state backend is proven only in the supervised DEV qualification (G2)**, never here.

## What was run

| Item | Value |
| --- | --- |
| Terraform | 1.16.4, `linux_amd64`, from `https://releases.hashicorp.com/terraform/1.16.4/` |
| Zip sha256 | `dc94af0eef1147718ad7c8daea792ed199e3e0492eec180d0adafa2a65a879df` (matches `terraform_1.16.4_SHA256SUMS` from the same host) |
| Extracted binary sha256 | `44d3683c2ac9d72b6ca8ad880a2df8dd956dd5e019b1d111cb6a5d914d576b73` |
| Azurite | 3.37.0 (blob service only), installed from the npm registry |
| Node | 22.22.0 (2026-10-11); 26.11.1 (2026-10-27 Entra-only rerun) |

The checksum file's GPG signature was not verified (uncertain: only the sha256 match against the file fetched from the same host was checked).

## How to run it

The test is skipped unless both variables are set, so default CI is unaffected. Everything below is **DEV MODE ONLY**: npm and npx are developer tools, never operator steps. Operators use `./alz`.

1. DEV MODE ONLY: install Azurite outside the repository (no global install, no change to `package.json` or the lockfile):
   `mkdir -p <scratch>/azurite && npm install --prefix <scratch>/azurite azurite`
   (`--prefix` needs the directory to exist.)
2. Download the Terraform zip and `SHA256SUMS` from releases.hashicorp.com, check the zip with `sha256sum -c`, unzip it in its own directory.
3. DEV MODE ONLY: run the test:
   `ALZ_SIM_TERRAFORM=<dir>/terraform ALZ_SIM_AZURITE=<scratch>/azurite/node_modules/.bin/azurite-blob npx tsx --test test/apply-emulated.test.ts`
   Optional: `ALZ_SIM_TERRAFORM_SHA256=<binary sha256>` makes it refuse any other binary. It needs `openssl` on the path. It needs no root, no hosts-file change and no system trust change.

How the emulator is reached (no operator or system change): Azurite runs over TLS with a throwaway self-signed certificate. The test-only harness (below) tells the azurerm backend `ARM_METADATA_HOSTNAME=alz-sim.test:8443`; a small local metadata endpoint returns `alz-sim.test` as the storage suffix. A local CONNECT proxy, handed to Terraform through `ALZ_NETWORK_HTTPS_PROXY`, sends exactly two hostnames to loopback and answers 403 to everything else. The certificate is handed over as `ALZ_NETWORK_SSL_CERT_FILE`. The test records every host Terraform tried to reach and asserts that nothing beyond those two and Terraform's own version check was attempted.

Authentication to the emulator is a container SAS token signed with Azurite's published development key, supplied by the **test-only Azurite SAS harness** (`installAzuriteSasHarness` in the test). The harness is a small wrapper that the test installs as `terraform` in the tool directory it gives the driver. The wrapper sets Terraform's own `ARM_SAS_TOKEN` and `ARM_METADATA_HOSTNAME` in its own process and then runs the real binary. No product code path, flag, environment variable or contract field can select it:
- the project's backend block carries neither setting;
- the product's backend configuration never writes them;
- the runner never injects them.

Because the driver binds the engine binary's hash, the harness is also a different engine. A production qualification attests the real binary, so it refuses the harness (`ENGINE_NOT_QUALIFIED`). A plan the harness sealed cannot be applied by the real binary either (`ENGINE_BINARY_CHANGED`).

## What the test covers

`test/apply-emulated.test.ts` drives the real driver (`sealPreview`, `runApply`) through: seal with the real engine; an Ed25519 test approval over a fixture contract with fake GUIDs; apply (state lands in the emulator, lease released, evidence and ledger written, no secret in any result); a second apply of the same artifact refused (`ARTIFACT_ALREADY_APPLIED`); a stale plan refused (`PLAN_STALE`, outcome `FAILED_NO_CHANGE`, state unchanged); a held state lease (`FAILED_NO_CHANGE`, the other holder's lease untouched); the kill switch before the engine; and the kill switch while Terraform runs (`KILLED`, lease released). All seven pass. The qualification attestation is forged in the test (labeled as such) because no person can attest an emulator.

Two more real-engine scenarios prove that the emulator's settings cannot enter a production path:
- **A production seal is refused.** The seal uses the real binary without the harness, with the SAS token and metadata host in the project's backend block and in the operator's environment. It is refused at init (`ARTIFACT_INVALID`), and neither the emulator's storage host nor its metadata host is contacted.
- **A production apply is refused.** The harness's settings are passed as any one identity's variables (`ENVIRONMENT_REFUSED`), through the harness binary under a qualification of the real binary (`ENGINE_NOT_QUALIFIED`), or by the real binary on a plan the harness sealed (`ENGINE_BINARY_CHANGED`). In each case the state is unchanged and the lease is free.

The default-CI guard block (no emulator, fake engine) proves the same boundary everywhere a value could come from:
- the contract refuses a SAS token, metadata host or access key as a field or inside the backend string;
- the product's backend configuration contains only its own settings;
- `ARM_SAS_TOKEN`, `ARM_METADATA_HOSTNAME` and `ARM_ACCESS_KEY` are refused as identity or network variables for every identity, and are never inherited from the operator;
- a seal with them as identity variables is refused (`ENVIRONMENT_REFUSED`);
- an override file carrying them is refused by name (`BACKEND_OVERRIDE_NOT_ALLOWED`);
- a project block carrying them is replaced by the product's pinned empty block before init;
- the harness and the emulator's markers appear in no file outside this test and its documentation.

No defect was found in `src/apply` by the backend-pinning rerun: argv, init flags, backend-config handling, profile environment, `show -json` shape and stderr classification all worked against the real binary. No source file was changed. The Entra-only rerun below changed `src/apply/providers/azure.ts`.

## G1b on the Entra-only backend (SYNTHETIC/EMULATED, 2026-10-27)

**The change.** `src/apply/providers/azure.ts` adds `use_azuread_auth = true` to the backend file the product writes for every init. That includes the seal's location-only file, because the STATE identity's init also has to reach a key-disabled account. Init saves the setting, and the sealed plan embeds it. `savedBackendMatches` now requires it to be `true`, and requires every setting the product did not write to be absent or `null`. Issues #287 and #289 proposed this before backend pinning; this change supersedes both.

**Why the backend setting, not an environment variable.**
- Under backend pinning, the product's `-backend-config` file is already the only source of backend settings.
- A setting in that file is saved by init, so the product can check it before planning and again at apply. An environment default is not saved (finding (a)), so nothing could check it.
- In the Terraform 1.16.4 binary, the backend's environment default for this setting is `ARM_USE_AZUREAD`. `ARM_STORAGE_USE_AZUREAD`, which #289 put on the runner profile, does not occur in the binary at all; it is the azurerm provider's variable.
- `ARM_USE_AZUREAD` on an identity is already refused as a fallback (`ARM_USE_*` other than `ARM_USE_OIDC`), and no Terraform profile injects it. No profile change is needed.

**Why no `resource_group_name`.** The 1.16.4 backend's own messages are: "One of `access_key`, `sas_token`, `use_azuread_auth` and `resource_group_name` must be specified", and "`resource_group_name` is required when `lookup_blob_endpoint` is set". A resource group is therefore needed only to list the account's shared keys through ARM, which `bootstrap/azure` disables, or to look up the blob endpoint. With Entra ID authorization, the contract's `<storage-account>/<container>/<key>` is the whole location. No contract field is added, nothing is defaulted, and a saved `resource_group_name` or `lookup_blob_endpoint` is refused.

**Empirical results (Terraform 1.16.4 over Azurite, through the test-only harness unless noted):**
- **What real init saves from the product's file.** `use_azuread_auth` is saved as `true`. `sas_token`, `access_key`, `resource_group_name`, `lookup_blob_endpoint`, `metadata_host`, `endpoint`, `client_secret`, `use_msi` and `use_cli` are all `null`. The harness's `ARM_SAS_TOKEN` and `ARM_METADATA_HOSTNAME` reached init through its environment only and were not saved. The product accepts this saved backend.
- **A SAS token or resource group in the file is saved and refused.** When the file also sets `sas_token` or `resource_group_name`, init saves it, and the product refuses that saved backend.
- **A shared key in the file was not probed.** With `access_key` in the file, init used the key ahead of the harness's environment SAS and got 403 from Azurite behind the custom host, so it saved nothing. The default-CI test refuses a saved `access_key`.
- **Precedence with both set.** With `use_azuread_auth = true` saved and `ARM_SAS_TOKEN` in the environment, the backend authenticated with the SAS token: seal, apply, stale plan, lock and kill all passed, and `login.microsoftonline.com` was never contacted. This is how the harness reaches the emulator, and it is why `ARM_SAS_TOKEN` and `ARM_ACCESS_KEY` must never reach a child (they do not; see below).
- **The production path.** A production seal used the real binary without the harness, with the emulator's SAS and metadata host in the project's block and in the operator's environment. Init asked `login.microsoftonline.com` for an Entra ID token, which the proxy refused, and retried for about 15 seconds. The seal was then refused (`ARTIFACT_INVALID`). The emulator's storage and metadata hosts were never contacted, and the state was unchanged.

**Test-harness defect fixed (test code only).** The test's own Azurite client used Node's keep-alive agent. After the 15-second production seal, it reused a socket that Azurite had already closed, and failed with `ECONNRESET`. It now opens a fresh connection per call. Before this change the seal failed in under a second, which hid the race.

**Default CI.** `test/apply-azure-state-auth.test.ts` (fake engine) proves the switch and the refusals on every product path:
- both backend files carry `use_azuread_auth = true` once, and nothing else that authenticates;
- the saved-backend check refuses a missing, `null`, `false` or non-boolean switch, and any shared key, SAS token, resource group, lookup, endpoint, cloud, credential or unknown attribute;
- no Terraform profile injects `ARM_ACCESS_KEY`, `ARM_SAS_TOKEN`, `ARM_USE_AZUREAD` or `ARM_STORAGE_USE_AZUREAD`, and every identity's copy of them is refused;
- `ARM_USE_AZUREAD` on any identity is refused before a child runs;
- a seal whose init saves a SAS token, a shared key, a resource group or no switch is refused before planning.

The SAS allowance stays in `test/apply-emulated.test.ts` only. Its last guard test fails if any other file names the harness or the emulator's settings.

## What it proves, and what it does not

Proves, for Terraform 1.16.4 and the azurerm **backend** only: the allowlisted argument lists run; the stale-plan and lock-refusal text matches in `classifyApply` match the real engine's first `Error:` line; `terraform show -json` has the shape `engines/terraform.ts` reads; a graceful stop releases the lease; the driver's ordering, ledger and evidence work with a real process.

Does **not** prove:

- **Entra ID or OIDC.** Azurite does not emulate them. Token exchange, `client_id` / `tenant_id` handling and which principal Azure sees were not exercised. The OIDC token file was a dummy file.
- **The azurerm provider.** The registry is blocked; no azurerm resource was planned or applied. Provider-block checks (`subscription_id`, `tenant_id`) were not exercised against a real provider.
- **Real Azure RBAC**, role scoping, blob versioning or soft delete.
- **Real latency, throttling or retry behavior** of Azure Storage.
- **Identity separation between STATE_WRITE and APPLY.** Findings (a) and (b) show why the current design may not achieve it; only a real-Azure run can settle it.

## Empirical answers

All with Terraform 1.16.4 and the azurerm backend over Azurite. Exit codes are from the real process.

**(a) Are `-backend-config` values persisted, and does `apply <planfile>` run without them?**
Yes to both. A `sas_token` passed at `init` is written in plaintext to `.terraform/terraform.tfstate` (file mode follows the umask; 0644 here). Attributes not set are saved as `null`; `client_id`, `use_oidc` and `oidc_token_file_path`, when given, are saved as given. `plan` and `apply <planfile>` in the same directory then ran with no credential in env or arguments (exit 0). Credentials supplied only through the environment at `init` (`ARM_SAS_TOKEN`) are not saved (`sas_token: null`).

**(b) Does the saved plan embed backend settings, and what if apply runs with different backend env?**
- The plan file (a zip) embeds the full backend configuration inside `tfplan`, including `sas_token` in plaintext. A sealed plan is therefore secret-bearing when the backend block or `-backend-config` carries a secret. The vault encrypts it; `terraform show -json` does not expose it.
- `apply <planfile>` uses the **plan's embedded backend**, not the one saved by an `init` in the apply directory. Test: plan for key `d1`, directory initialized for key `d2`, apply wrote to `d1` and left `d2` untouched. Apply also worked in a directory with no `.terraform` at all.
- Attributes the plan embeds as `null` are filled from the apply process's environment. Same-named env does not override an embedded value (bogus `ARM_SAS_TOKEN` with an embedded SAS: apply succeeded). A different auth method in env does take effect (bogus `ARM_ACCESS_KEY` with an embedded SAS: apply failed with 403, exit 1). Applying a plan whose backend embedded no credential, with none in env, gave `Error: One of access_key, sas_token, use_azuread_auth and resource_group_name must be specified` (exit 1).
- Consequence for G2 (inferred for Entra attributes, not tested with Entra): the partial backend configuration the driver gives `init` as STATE_WRITE at apply time is **not used** by `terraform apply <planfile>`. State access during apply would come from the seal-time embedded settings plus the APPLY process's own `ARM_*` variables, i.e. APPLY's identity. The design in `docs/act-pilot-apply.md` assumes the opposite possibility; this result makes the separation unlikely as built. A real-Azure confirmation is still needed.
- The test also showed that with `use_oidc = true` and a token file path, `init` reads the file even when a SAS token is set, and fails with `Error: reading OIDC Token from file ...` if it does not exist.

**(c) Stale plan.** Plan A, plan B, apply B, apply A: exit 1, stderr begins `Error: Saved plan is stale`, then "The given plan file can no longer be applied because the state was changed by another operation after the plan was created." State unchanged (serial did not move). The `STALE` match in `classifyApply` works against this text.

**(d) Locking.** Terraform locks by acquiring an infinite lease on the state blob. While one apply ran, a concurrent `plan` and a concurrent `apply <planfile>` each exited 1 at once with `Error: Error acquiring the state lock`, then `Error message: state blob is already locked` and a `Lock Info` block (ID, path, operation, who, version, created). The text goes to stderr. A lease taken directly through the blob API (not by Terraform) gives the same first line with `blob metadata "terraformlockid" was empty`. `state pull` takes no lock, so the driver's reads work while a lease is held. The `LOCK_REFUSED` match works against the real first `Error:` line.

**(e) Kill or stop mid-apply.**
- SIGKILL to Terraform during a provisioner: exit 137 (signal). No `errored.tfstate`, no `crash.log`. The lease stays held; the next `plan` is refused with the lock error until `terraform force-unlock`. The provisioner's child process survived as an orphan.
- SIGINT (the driver's graceful stop): exit 1, first error `Error: execution halted`, then the provisioner error. The lease was released and the interrupted resource was recorded in state (serial moved). No recovery files. The driver's kill-switch test ended `KILLED` in about one second with the lease released. (Uncertain: a provisioner's grandchild process, here `sleep`, was left running after a graceful stop; the driver's later group kill is cancelled once Terraform exits. Not relevant to azurerm resources, relevant if a project ever uses a provisioner.)
- Azurite stopped mid-apply: after the provisioner finished, Terraform failed at once (connection refused, no long retry) with exit 1, first error `Error: Failed to save state`, and wrote `errored.tfstate` (mode 0644, holds state values) in the working directory. The remote state was unchanged and the lease stayed held. The driver would record `PARTIAL_REQUIRES_REVIEW` and keep `errored.tfstate`. `crash.log` was never produced in these runs (not tested: a provider crash).
- **Secret exposure:** that `Failed to save state` message quotes the full request URL, including the SAS token and signature. This is why the driver's withholding of engine output is load-bearing. Whether the same happens with Entra auth is not known (no token is in the URL there).
- Uncertain: with the sandbox's blocking egress proxy and no custom endpoint, the backend retried a 403 for the real `blob.core.windows.net` host essentially forever (hundreds of thousands of retries listed). Retry limits against real Azure were not observed.

**(f) `terraform show -json <plan>`.** Top-level keys: `format_version` ("1.2"), `terraform_version`, `variables`, `planned_values`, `resource_changes`, `output_changes`, `prior_state`, `configuration`, `timestamp`, `applyable`, `complete`, `errored`. The key `engines/terraform.ts` reads is `configuration.provider_config` (singular), which exists (here only `terraform` / `terraform.io/builtin/terraform`); `resource_changes[].address`, `.type` and `.change.actions` and `output_changes` match what `engines/terraform.ts` expects. The backend block and `sas_token` do **not** appear in the JSON. The test's change list was `terraform_data.pilot`, `terraform_data`, create.

## Other observations

- Terraform contacts `checkpoint-api.hashicorp.com` on every run (version check). The runner profile does not set `CHECKPOINT_DISABLE`; in the simulation the proxy refused it. On an operator host this is an outbound call outside the approved-host list (that list governs URL variables only). Not changed here.
- A real run needs the OIDC token file to exist before `init` when the STATE_WRITE configuration sets it.
- The apply identity variables never carry `ARM_SAS_TOKEN`, `ARM_METADATA_HOSTNAME` or `ARM_ACCESS_KEY`: the runner refuses them. Only the test-only harness supplies the emulator's SAS and metadata host, inside its own process.

## Re-run with the provisioner-free kill fixture (EMULATED, 2026-10-27, #327)

EMULATED, not live provider evidence. Real Terraform 1.16.4, Azurite. `test/apply-emulated.test.ts` passed **17 of 17**. The judge now refuses every provisioner (RB1, `src/apply/terraform-constructs.ts`), so the kill-during-apply fixture plans `count = 2000` built-in `terraform_data` values instead of a `local-exec` `sleep`. The test waits until Terraform holds the state lease, which only the apply takes, and then raises the kill switch. It still asserts `KILLED`, the lease released and the serial moved. It also asserts that the state records fewer values than were planned, which proves the interrupt landed part-way. The SIGKILL, SIGINT and Azurite-stopped observations under "Empirical answers" were made with the earlier `local-exec` fixture and are kept as recorded.

## Cleanup after a run

The test removes its temporary directory and stops Azurite and its helper. Nothing is written to the repository. A manual run in a scratch directory should delete it. If you edited the hosts file for a manual experiment, remove that line; the test itself needs no hosts entry.
