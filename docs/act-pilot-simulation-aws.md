# Pilot apply: AWS emulated-backend simulation

Status: run on 2026-10-27, in a Linux sandbox, as gate **G1b** of `docs/act-pilot-plan.md` for the first live ACT path, AWS Terraform (owner decision, issue #39, comment 6431744115). It runs the **real Terraform engine** against an **emulated S3 state backend (moto)** with Terraform's built-in `terraform_data` resource only, and the backend's native lock file (`use_lockfile`, the locking mode `src/apply/providers/aws.ts` pins; no DynamoDB). No AWS account, no real bucket, role, token or cloud resource and no registry access was used. It mirrors the Azure precedent in `docs/act-pilot-simulation.md` and exercises the apply driver (`src/apply`) with the real binary. It is **emulated evidence, labeled as such**: it does not replace the supervised DEV qualification (G2), and it is not live provider qualification.

## What was run

| Item | Value |
| --- | --- |
| Terraform | 1.16.4, `linux_amd64`, from `https://releases.hashicorp.com/terraform/1.16.4/` (the version `config/tool-pins.json` pins) |
| Zip sha256 | `dc94af0eef1147718ad7c8daea792ed199e3e0492eec180d0adafa2a65a879df` (matches `terraform_1.16.4_SHA256SUMS` from the same host) |
| Extracted binary sha256 | `44d3683c2ac9d72b6ca8ad880a2df8dd956dd5e019b1d111cb6a5d914d576b73` |
| moto | 5.2.4 (`moto[server]`, with Werkzeug 3.1.9, Flask 3.1.3, cryptography 50.0.2, boto3 1.43.119), installed from PyPI into a scratch virtual environment |
| Python | 3.13.16 |
| Node | 26.11.1 |

The checksum file's GPG signature was not verified (uncertain: only the sha256 match against the file fetched from the same host was checked).

## How to run it

The test is skipped unless both variables are set, so default CI is unaffected. Everything below is **DEV MODE ONLY**: pip, venv and npx are developer tools, never operator steps. Operators use `./alz`.

1. DEV MODE ONLY: install moto outside the repository (no root, no global install, no change to `package.json` or the lockfile):
   `python3 -m venv <scratch>/moto && <scratch>/moto/bin/pip install "moto[server]"`
2. Download the Terraform zip and `SHA256SUMS` from releases.hashicorp.com, check the zip with `sha256sum -c`, unzip it in its own directory.
3. DEV MODE ONLY: run the test:
   `ALZ_SIM_TERRAFORM=<dir>/terraform ALZ_SIM_MOTO=<scratch>/moto/bin/moto_server npx tsx --test test/apply-emulated-aws.test.ts`
   Optional: `ALZ_SIM_TERRAFORM_SHA256=<binary sha256>` makes it refuse any other binary. It needs `openssl` on the path. It needs no root, no hosts-file change and no system trust change.

How the emulator is reached (no operator or product change): moto serves TLS with a throwaway self-signed certificate whose names are the two hosts the S3 backend builds for the fixture, `examplefake-dev-state.s3.us-east-1.amazonaws.com` and `sts.us-east-1.amazonaws.com`. A local CONNECT proxy, handed to Terraform through `ALZ_NETWORK_HTTPS_PROXY`, sends exactly those two hostnames to loopback and answers 403 to everything else; the certificate is handed over as `ALZ_NETWORK_SSL_CERT_FILE`. Both reach the child through the runner's existing `ALZ_NETWORK_*` path (loopback is always an approved host), so the driver, the profiles and every identity rule are the product's own. The test records every host Terraform tried to reach and asserts that nothing beyond those two and Terraform's own version check was attempted.

How the backend authenticates: through the product's own identity path and nothing else. The four identities are configured as `ALZ_<IDENTITY>_AWS_ROLE_ARN`, `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` and `ALZ_<IDENTITY>_AWS_REGION` with the fixture's fake role ARNs (account `111111111111`) and four distinct dummy token files. The driver writes the STATE_WRITE role into the partial backend configuration at apply-time init, and each child's SDK exchanges its own token at `sts.us-east-1.amazonaws.com` (`AssumeRoleWithWebIdentity`); moto accepts any token and issues throwaway credentials. No static key, session token, profile, endpoint override or trust-store variable was added, and no identity was given anything the product does not already inject. The test's own direct reads of the emulator (state, lock object) carry a fixture `Authorization` header that is not a credential of anything: moto checks that an object request is signed, not the signature.

## What the test covers

`test/apply-emulated-aws.test.ts` drives the real driver (`sealPreview`, `runApply`) through: seal with the real engine (the review bundle verifies; the built-in resource is listed as untagged by the deletion unit, not refused); an Ed25519 test approval over a fixture AWS contract with fake 12-digit account ids; apply (state lands in the emulator, the lock file is gone, evidence and ledger written, no secret in any result); a second apply of the same artifact refused (`ARTIFACT_ALREADY_APPLIED`); a stale plan refused (`PLAN_STALE`, outcome `FAILED_NO_CHANGE`, state unchanged, no lock left behind); a held native lock (`FAILED_NO_CHANGE`, the other holder's lock object and its content untouched); the kill switch before the engine; and the kill switch while Terraform runs (`KILLED`, lock released, the interrupted resource recorded in state). All seven pass. The qualification attestation is forged in the test (labeled as such) because no person can attest an emulator.

## Defects the real binary exposed

- **`src/apply/providers/aws.ts`: the provider allowlist refused Terraform's built-in provider.** `terraform show -json` lists `terraform.io/builtin/terraform` under `configuration.provider_config` whenever a project uses `terraform_data` (or `terraform_remote_state`), and `assertProviderConfig` refused it (`PROVIDER_CONFIG_NOT_IN_CONTRACT`), so the AWS path could not seal the built-in-only fixture G1b calls for. The Azure spec skips non-azurerm providers and never hit this. Fixed in this change by adding that one name to `ALLOWED_PROVIDERS`, with a regression case in `test/apply-aws.test.ts` using the exact `provider_config` entry Terraform 1.16.4 emits. This is a change to which providers a plan may declare, not to what any identity may do; a reviewer should weigh that the built-in provider's `terraform_remote_state` data source can read another backend with the running identity's credentials, as any allowed provider's data source can.
- **`test/apply-emulated.test.ts` (the Azure simulation) had bit-rotted:** it never passed `sourceCommit`, which the driver has required since the observe/cleanup slice (`SOURCE_UNVERIFIED` at every seal); its fixture contract named no QA target, which the contract loader now requires (`CONTRACT_INVALID`); and its CONNECT proxy helper attached the client socket's error handler only after the upstream connected, so an early reset ended the helper and every later engine run. All three are fixed here (the helper fix in both tests; the AWS run hit it first, as a `read ECONNRESET` after the first seal). The Azure test was then re-run against Azurite 3.37.0 with the same Terraform binary: all seven scenarios pass again.

## What it proves, and what it does not

Proves, for Terraform 1.16.4 and the S3 **backend** with `use_lockfile` only: the allowlisted argument lists run; the project's backend block with exactly `bucket`, `key`, `region` and `use_lockfile` passes the pre-init block check and `init` with the partial `-backend-config` file (the STATE_WRITE role and token file) succeeds; the stale-plan and lock-refusal text matches in `classifyApply` match the real engine's first `Error:` line for this backend too; `terraform show -json` has the shape `engines/terraform.ts` and the AWS spec read (`configuration.provider_config` with the built-in provider only); a graceful stop releases the native lock; the driver's ordering, ledger and evidence work with a real process.

Does **not** prove:

- **Real STS or IAM.** moto's `AssumeRoleWithWebIdentity` accepts any token for any role and evaluates no trust policy; the token files were dummies. Which principal AWS would see, and whether the four roles' trust and permissions are right, were not exercised.
- **The aws provider.** The registry is blocked; no aws resource was planned or applied. Provider-block checks (`allowed_account_ids`, `assume_role`, the denied attributes) were not exercised against a real provider.
- **Real bucket policies, S3 versioning, encryption or object lock**, and whether the DEV bucket's policy lets the STATE role read while refusing it the lock file.
- **Real latency, throttling or retry behavior** of S3 and STS.
- **Identity separation between STATE_WRITE and APPLY.** Finding (b) shows the plan embeds the STATE_WRITE role; which role AWS would actually see on the state write during `apply <planfile>` is settled only by a real-AWS run with CloudTrail.

## Empirical answers

All with Terraform 1.16.4 and the S3 backend over moto. Exit codes are from the real process.

**(a) Which hosts, and which locking mode.** With `use_lockfile = true` the backend contacted only `examplefake-dev-state.s3.us-east-1.amazonaws.com:443` (virtual-hosted-style, never path-style) and `sts.us-east-1.amazonaws.com:443` (the regional endpoint, never the global `sts.amazonaws.com`), plus `checkpoint-api.hashicorp.com:443`, which the proxy refused. No DynamoDB host was ever named. The lock is the object `<key>.tflock`, written with `If-None-Match: *` (a conditional create) and deleted on release; moto 5.2.4 honors the condition.

**(b) What `init` saves, and what `apply <planfile>` uses.** The partial `-backend-config` file is persisted: `.terraform/terraform.tfstate` holds `assume_role_with_web_identity.role_arn` (the STATE_WRITE role) and `web_identity_token_file` (its path) in plaintext, with `bucket`, `key`, `region` and `use_lockfile: true`; every other backend attribute is saved as `null` (among them `access_key`, `secret_key`, `token`, `endpoints`, `dynamodb_table`, `sts_endpoint`, `skip_credentials_validation`). Neither value is a secret. The same embedding into the plan file and the same "apply uses the plan's embedded backend" behavior seen on Azure is assumed and consistent with what ran, but was not separately re-tested with two differently initialized directories here. `plan` and `apply <planfile>` then ran with no credential in arguments; the credentials in play came from each child's own `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` through STS.

**(c) Stale plan.** Plan A, plan B, apply B, apply A: exit 1, first error `Error: Saved plan is stale`; state unchanged (serial did not move), and no lock object was left behind. The `STALE` match in `classifyApply` works against this backend's text.

**(d) Locking.** A lock object written by another party (a lock-info document, as Terraform writes it) made `apply <planfile>` exit 1 with first error `Error: Error acquiring the state lock`; the driver classified it `FAILED_NO_CHANGE`, the state serial did not move, and the other party's object and its content were untouched. `state pull` takes no lock, so the driver's serial reads work while a lock is held. The `LOCK_REFUSED` match works against the real first `Error:` line.

**(e) Kill mid-apply.** SIGINT (the driver's graceful stop) during a `local-exec` provisioner: Terraform exited non-zero, the driver recorded `KILLED` in about a second, the lock object was deleted, and the interrupted resource was recorded in state (serial moved). No `errored.tfstate` or `crash.log`. The orphaned provisioner grandchild noted in the Azure run applies here too (not relevant to aws resources).

**(f) `terraform show -json <plan>`.** Top-level keys: `format_version`, `terraform_version`, `planned_values`, `resource_changes`, `configuration`, `timestamp`, `applyable`, `complete`, `errored`. `configuration.provider_config` is `{ terraform: { name: "terraform", full_name: "terraform.io/builtin/terraform" } }` for this project (no `expressions` key), `resource_changes[].address`, `.type` and `.change.actions` match what `engines/terraform.ts` expects, and the backend block does not appear. The test's change list was `terraform_data.pilot`, `terraform_data`, create.

## Other observations

- Terraform contacts `checkpoint-api.hashicorp.com` on every run (version check). The runner profile does not set `CHECKPOINT_DISABLE`; in the simulation the proxy refused it. Unchanged from the Azure run.
- With the proxy variables handed to the child, the AWS SDK honored `HTTPS_PROXY` and `SSL_CERT_FILE` as the runner delivers them; no `AWS_CA_BUNDLE` or endpoint override was needed, and none is injectable in the apply profile.
- moto treats an unsigned object request as anonymous and refuses it, and files every unregistered or STS-issued access key under its default account, so Terraform's signed requests and the test's direct reads see one bucket.

## Cleanup after a run

The test removes its temporary directory and stops moto and its helper. Nothing is written to the repository. A manual run in a scratch directory should delete it; the virtual environment is only a developer convenience and is never needed by an operator.
