# Pilot apply: emulated-backend simulation

Status: run once, on 2026-10-11, in a Linux sandbox. It runs the **real Terraform engine** against an **emulated Azure Storage backend (Azurite)** with Terraform's built-in `terraform_data` resource only. No Azure account, no real cloud resource and no registry access was used. It answers part of the open G2 questions in `docs/act-pilot-apply.md` and exercises the apply driver (`src/apply`) with the real binary. It does not replace the supervised DEV qualification.

## What was run

| Item | Value |
| --- | --- |
| Terraform | 1.16.4, `linux_amd64`, from `https://releases.hashicorp.com/terraform/1.16.4/` |
| Zip sha256 | `dc94af0eef1147718ad7c8daea792ed199e3e0492eec180d0adafa2a65a879df` (matches `terraform_1.16.4_SHA256SUMS` from the same host) |
| Extracted binary sha256 | `44d3683c2ac9d72b6ca8ad880a2df8dd956dd5e019b1d111cb6a5d914d576b73` |
| Azurite | 3.37.0 (blob service only), installed from the npm registry |
| Node | 22.22.0 |

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

How the emulator is reached (no operator or system change): Azurite runs over TLS with a throwaway self-signed certificate. The azurerm backend is told `metadata_host = alz-sim.test:8443`; a small local metadata endpoint returns `alz-sim.test` as the storage suffix. A local CONNECT proxy, handed to Terraform through `ALZ_NETWORK_HTTPS_PROXY`, sends exactly two hostnames to loopback and answers 403 to everything else. The certificate is handed over as `ALZ_NETWORK_SSL_CERT_FILE`. The test records every host Terraform tried to reach and asserts that nothing beyond those two and Terraform's own version check was attempted.

Authentication to the emulator is a container SAS token signed with Azurite's published development key. The test project's backend block carries it (see finding (a)).

## What the test covers

`test/apply-emulated.test.ts` drives the real driver (`sealPreview`, `runApply`) through: seal with the real engine; an Ed25519 test approval over a fixture contract with fake GUIDs; apply (state lands in the emulator, lease released, evidence and ledger written, no secret in any result); a second apply of the same artifact refused (`ARTIFACT_ALREADY_APPLIED`); a stale plan refused (`PLAN_STALE`, outcome `FAILED_NO_CHANGE`, state unchanged); a held state lease (`FAILED_NO_CHANGE`, the other holder's lease untouched); the kill switch before the engine; and the kill switch while Terraform runs (`KILLED`, lease released). All seven pass. The qualification attestation is forged in the test (labeled as such) because no person can attest an emulator.

No defect was found in `src/apply` by this run: argv, init flags, backend-config handling, profile environment, `show -json` shape and stderr classification all worked against the real binary. No source file was changed.

## What it proves, and what it does not

Proves, for Terraform 1.16.4 and the azurerm **backend** only: the allowlisted argument lists run; the stale-plan and lock-refusal text matches in `classifyApply` match the real engine's first `Error:` line; `terraform show -json` has the shape `seal.ts` reads; a graceful stop releases the lease; the driver's ordering, ledger and evidence work with a real process.

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

**(f) `terraform show -json <plan>`.** Top-level keys: `format_version` ("1.2"), `terraform_version`, `variables`, `planned_values`, `resource_changes`, `output_changes`, `prior_state`, `configuration`, `timestamp`, `applyable`, `complete`, `errored`. The key `seal.ts` reads is `configuration.provider_config` (singular), which exists (here only `terraform` / `terraform.io/builtin/terraform`); `resource_changes[].address`, `.type` and `.change.actions` and `output_changes` match what `seal.ts` expects. The backend block and `sas_token` do **not** appear in the JSON. The test's change list was `terraform_data.pilot`, `terraform_data`, create.

## Other observations

- Terraform contacts `checkpoint-api.hashicorp.com` on every run (version check). The runner profile does not set `CHECKPOINT_DISABLE`; in the simulation the proxy refused it. On an operator host this is an outbound call outside the approved-host list (that list governs URL variables only). Not changed here.
- A real run needs the OIDC token file to exist before `init` when the STATE_WRITE configuration sets it.
- The apply identity variables did not need any `ARM_SAS_TOKEN`: the runner does not inject it, so the simulation puts the (emulator-only) SAS in the project's backend block.

## Cleanup after a run

The test removes its temporary directory and stops Azurite and its helper. Nothing is written to the repository. A manual run in a scratch directory should delete it. If you edited the hosts file for a manual experiment, remove that line; the test itself needs no hosts entry.
