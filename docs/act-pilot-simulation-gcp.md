# GCP pilot: the G-7 emulator spike (SYNTHETIC, emulated)

**Everything on this page is SYNTHETIC.** The spike ran the real Terraform engine against an emulated Cloud Storage server (fake-gcs-server) on loopback. No GCP project, credential, token or network access to Google was used: every outbound host was pointed at a closed local port. It is not live evidence, not provider qualification, and not a release gate result. It answers one design question from the GCP release-path PLAN (issue #39, owner approval 6433121154): which G1b gate the GCP path can have.

Run once, on 2026-10-27, in a Linux sandbox, outside the repository. DEV MODE ONLY: Go, the emulator and raw `terraform` commands are developer tools, never operator steps. Operators use `./alz`.

## Answer

**Yes. Terraform 1.16.4's `gcs` backend honors `STORAGE_EMULATOR_HOST` against fake-gcs-server.**

- With `STORAGE_EMULATOR_HOST=http://127.0.0.1:4443` and no Google credential at all, these all succeeded against the emulator:
  - `init`, `plan -out`, `apply <planfile>`;
  - locking, and lock contention;
  - stale-plan refusal;
  - SIGINT and SIGKILL mid-apply.
- Without the variable, the same `init` failed at once: `Error: storage.NewClient() failed: dialing: credentials: could not find default credentials`.

The G1b fallback order the owner approved (`STORAGE_EMULATOR_HOST`, then the proxy variant, then `NOT_EMULATABLE` with G2 as the evidence) therefore stops at its first step. The proxy variant is not needed, and the GCP G1b gate is not `NOT_EMULATABLE`.

The backend's `storage_custom_endpoint` attribute also reaches the emulator, with no environment variable (finding H). It is a backend attribute, so the plan would embed it. That makes it the wrong tool for a test, and a product path must refuse it.

**What the emulator does not prove.** Authentication is skipped when the emulator variable is set (finding G3). The emulator therefore proves nothing about WIF, service-account impersonation, IAM, or which principal writes state. Those are G2 questions, answered from Cloud Audit Logs on the real DEV project. This is the same limit Azurite has for Entra ID (`docs/act-pilot-simulation.md`).

## What was run

| Item | Value |
| --- | --- |
| Terraform | 1.16.4 `linux_amd64`, binary sha256 `44d3683c2ac9d72b6ca8ad880a2df8dd956dd5e019b1d111cb6a5d914d576b73` (the same binary and hash as `docs/act-pilot-simulation.md`) |
| fake-gcs-server | v1.53.1 (tag commit `b91400638ab7742ffffd1d17b5a023a2e241968f`), built from the Go module proxy with `go install` |
| Module checksum | `h1:/gjEYut23/MMhe4daYJ5yIBGPUmLAYupgITuoWG3+jI=`, verified by `go` against `sum.golang.org` and matching that log's record. The project publishes no checksum file of its own for a source build. The local build's binary sha256 was `dca268fc76490d61538cdcdf1b5f82bc4145ec41b4b7bd04558a60eb00bcb9f0` (a local build, not a reproducible-build claim) |
| Why v1.53.1 | the newest release whose `go.mod` accepts the sandbox's Go 1.24.7. v1.54.0 and later need Go 1.25 or 1.26 |
| Go | 1.24.7, `GOTOOLCHAIN=local` (no toolchain download), with module and build caches in a new, empty scratch directory |
| Emulator mode | `-scheme http -host 127.0.0.1 -port 4443 -backend memory` |
| Terraform project | `backend "gcs" {}` and one built-in `terraform_data` resource with a `local-exec` `sleep` provisioner, to hold an apply open. No provider was downloaded |

Every Terraform command ran under `env -i` with only `PATH`, a scratch `HOME`, an empty `CLOUDSDK_CONFIG`, `CHECKPOINT_DISABLE=1` and `TF_IN_AUTOMATION=1`. `HTTPS_PROXY` and `HTTP_PROXY` were set to `http://127.0.0.1:9` (closed) and `NO_PROXY` to `127.0.0.1,localhost`, so any attempt to reach a Google host failed locally instead of leaving the machine. No `GOOGLE_*` variable, Application Default Credentials file or gcloud login existed in that environment. All 173 requests in the emulator's log came from `127.0.0.1`.

## How to repeat it

DEV MODE ONLY. Use a new, empty scratch directory for the download, and a different one for the run.

1. Build the emulator: `GOPATH=<dl>/gopath GOMODCACHE=<dl>/gopath/pkg/mod GOBIN=<dl>/bin GOCACHE=<dl>/gocache GOTOOLCHAIN=local GOSUMDB=sum.golang.org go install github.com/fsouza/fake-gcs-server@v1.53.1`. Then check `<dl>/gopath/pkg/mod/cache/download/github.com/fsouza/fake-gcs-server/@v/v1.53.1.ziphash` against `https://sum.golang.org/lookup/github.com/fsouza/fake-gcs-server@v1.53.1`.
2. Start it: `<dl>/bin/fake-gcs-server -scheme http -host 127.0.0.1 -port 4443 -backend memory -public-host 127.0.0.1:4443 -external-url http://127.0.0.1:4443`.
3. Create a versioned bucket: `curl -X POST -H 'content-type: application/json' -d '{"name":"alz-sim-dev-state","versioning":{"enabled":true}}' 'http://127.0.0.1:4443/storage/v1/b?project=alz-sim-dev'`.
4. In the project directory, under the isolated environment above plus `STORAGE_EMULATOR_HOST=http://127.0.0.1:4443`:
   - `terraform init -input=false -backend-config=bucket=alz-sim-dev-state -backend-config=prefix=dev/alz`;
   - `terraform plan -input=false -out=<plan>`;
   - `terraform apply -input=false <plan>`.
5. Stop the emulator and delete both scratch directories.

## Findings

All with Terraform 1.16.4, the `gcs` backend and fake-gcs-server v1.53.1. Exit codes are from the real process.

**A. Baseline without the emulator.** `init` exits 1: `Error: storage.NewClient() failed: dialing: credentials: could not find default credentials.` No request reached the emulator.

**B. `init` with `STORAGE_EMULATOR_HOST`.** Exit 0. `.terraform/terraform.tfstate` saves the `gcs` backend with `bucket` and `prefix`. Every credential attribute is saved as `null`: `access_token`, `credentials`, `encryption_key`, `impersonate_service_account`, `impersonate_service_account_delegates`, `kms_encryption_key` and `storage_custom_endpoint`.

**C. Plan, apply, layout and locking.**
- `plan -out` and `apply <planfile>` both exit 0.
- The state object is `dev/alz/default.tfstate`, and the lock object is `dev/alz/default.tflock`.
- The emulator log shows the lock protocol on every run:
  1. create the lock object with `ifGenerationMatch=0`;
  2. read and write the state;
  3. delete the lock object with `ifGenerationMatch=<its generation>`.
- With bucket versioning on, the listing then held two state versions and three noncurrent lock-object versions.
- **Contention.** An apply held the lock while a second `plan` ran. The `plan` exited 1 with:

  ```
  Error: Error acquiring the state lock
  Error message: writing "gs://alz-sim-dev-state/dev/alz/default.tflock" failed: googleapi: Error 412: Precondition failed
  ```

  It then printed a `Lock Info` block (ID, path, `OperationTypeApply`, who, version, created). The holder finished with exit 0. The `LOCK_REFUSED` match in `classifyApply` holds for this first `Error:` line.

**D. Stale plan.** The sequence was plan A, plan B, apply B (exit 0), then apply A. Apply A exited 1 with `Error: Saved plan is stale` ("The given plan file can no longer be applied because the state was changed by another operation after the plan was created."). The `STALE` match holds.

**E. Stop mid-apply.**
- **SIGINT (the driver's graceful stop):**
  - output: `Interrupt received`, then `Error: execution halted`, then the provisioner's `signal: killed`;
  - exit 1;
  - the lock object was deleted;
  - the serial moved, recording the part that had run.
- **SIGKILL:**
  - exit 137;
  - the lock object stayed;
  - the next `plan` exited 1 with `Error: Error acquiring the state lock`;
  - `terraform force-unlock -force <id>` cleared it (an emulator-side recovery; the pilot never uses it).
- Neither stop produced `errored.tfstate` or `crash.log`.

**F. The plan embeds the backend.** The plan file (a zip of `tfconfig`, `tfplan`, `tfstate`, `tfstate-prev`) embeds the bucket name in `tfplan`. It does not embed the emulator address, which came from the environment. Applying that plan with `STORAGE_EMULATOR_HOST` unset exited 1 with the same "could not find default credentials" error. Consequences:
- `apply <planfile>` takes connection and credentials from the apply process's environment, as on Azure;
- an environment that adds the emulator variable redirects a sealed plan's state to another server. A product path must therefore refuse `STORAGE_EMULATOR_HOST` in every identity's environment.

**G. Credential attributes under the emulator.**
- **G1: `-backend-config=access_token=SIM-NOT-A-TOKEN`.**
  - `init` and `plan` exit 0;
  - the value is saved in plaintext in `.terraform/terraform.tfstate`;
  - the value is embedded in the plan's `tfplan`;
  - a real access token passed this way would make the sealed plan and the work directory secret-bearing. The G0 package forbids it.
- **G2: `-backend-config=impersonate_service_account=alz-state-write@alz-sim-dev.iam.gserviceaccount.com` with no base credential.** `init` exits 1 with `Error: google: could not find default credentials`. Impersonation needs a source credential before the client is built, even under the emulator.
- **G3: the same impersonation plus a dummy `access_token`.**
  - `init` and `plan` exit 0;
  - no outbound host was reachable, so no token exchange or impersonation call can have happened. With the emulator variable set, the backend does not authenticate;
  - both values are saved in `.terraform/terraform.tfstate`, and the service account email is embedded in the plan. This is consistent with the PLAN's `backendConfig`, which gives `init` STATE_WRITE's email and credential-configuration path (no secret). Whether a real apply then writes state as that account is not shown here (UNVERIFIED until G2).

**G4. Unreachable Google endpoints.** The G3 configuration with the emulator variable unset ran a `plan` that did not end. Every host was refused at the closed proxy port. `timeout 60` sent SIGTERM, and Terraform printed `Interrupt received ... Gracefully shutting down...` but had not exited about four minutes later. A SIGKILL ended it (exit 137). Which Google host it was retrying was not recorded (uncertain). The driver's run limit and process-group SIGKILL are what bound such a run.

**H. `storage_custom_endpoint` instead of the variable.** With `-backend-config=storage_custom_endpoint=http://127.0.0.1:4443/storage/v1/`, a dummy `access_token`, and `STORAGE_EMULATOR_HOST` unset, `init` and `plan` exit 0 against the emulator.

## What the GCP G1b gate becomes

G1b for GCP is an opt-in emulated test, built in slice S6 as `test/apply-emulated-gcp.test.ts` (opt-in through `ALZ_SIM_TERRAFORM` and `ALZ_SIM_FAKE_GCS`), of the real Terraform binary and fake-gcs-server **through the driver**. It mirrors `test/apply-emulated.test.ts`: seal, approve with a test key, apply, refuse a second apply, refuse a stale plan, refuse on a held lock, and the kill switch before and during the engine.

`STORAGE_EMULATOR_HOST` is set by that test harness only, on the same terms the owner set for Azurite's SAS auth (owner decision 6432984515 on issue #39: a clearly labeled, test-only emulator allowance that no product path can reach). Product code refuses the variable and `storage_custom_endpoint`.

The test proves the engine, lock, stale-plan and kill-switch behavior. It does not prove WIF, impersonation or state-write separation; those stay with G2.

## S6a: the automated, opt-in emulated test (SYNTHETIC)

`test/apply-emulated-gcp.test.ts` turns the spike into a repeatable test. It is opt-in: it is skipped unless both `ALZ_SIM_TERRAFORM` and `ALZ_SIM_FAKE_GCS` are set, so default CI is unaffected.

It runs the real Terraform engine against fake-gcs-server on loopback, using the provider spec's own functions (`src/apply/providers/gcp.ts`):
- the product's backend override file;
- `backendLocation`, and the STATE_WRITE `backendConfig` as the seal renders it;
- `savedBackendMatches` on what `init` really saved;
- the product's `classifyApply` on the engine's real errors.

Every proxy variable points at a closed local port. `STORAGE_EMULATOR_HOST` is set only in the engine children the test starts.

**It does not run through the driver yet.** GCP is not an admitted provider, so seal, approve, apply, the ledger and the kill switch cannot run a GCP contract. That journey, S6b, follows admission in the shape of `test/apply-emulated.test.ts`. It is the remaining half of the GCP G1b gate.

Run on 2026-10-27 with Terraform 1.16.4 (the binary above) and the fake-gcs-server v1.53.1 local build above (sha256 `dca268fc…`). It passed 4 of 4, three runs in a row:

| Test | What the real engine showed |
| --- | --- |
| The pin and the saved backend | The project's own `backend "gcs"` block, naming another bucket and a `storage_custom_endpoint`, did not survive the product override. `init` saved exactly the contract's bucket and prefix plus STATE_WRITE's credential path and service account, and `savedBackendMatches` accepts that. A location-only seal saves `credentials` as null, and that is accepted too |
| Refused saved settings | `access_token` (stored in plaintext; finding G1 again) and `storage_custom_endpoint` (finding H) in the saved backend are both refused by `savedBackendMatches` |
| The plan and the apply | The plan's `tfplan` entry carries the bucket, the prefix and STATE_WRITE's service account (finding G3), never the emulator address (finding F). `apply <planfile>` leaves exactly `<prefix>/default.tfstate` and no lock object |
| Lock and stale plan | While one apply holds `<prefix>/default.tflock`, another apply is refused, and `classifyApply` reads it as `FAILED_NO_CHANGE`. Once the lock is released, that plan is stale, and `classifyApply` reads `{ stale: true }`. No `errored.tfstate` |

What it does not prove is unchanged: the emulator skips authentication, so workload identity federation, impersonation, IAM and which principal writes state remain G2 questions.

## What this spike did not do

- It did not run the driver (`src/apply`). There is no GCP provider spec yet, so this was raw `terraform` only.
- It did not download or run the `hashicorp/google` provider, and planned no Google resource.
- It did not test CMEK, retention, soft delete, IAM Conditions on bucket objects, or real latency and retry limits.
- It changed no repository source file, `package.json` or lockfile.

## Cleanup

The emulator (memory backend) and every Terraform process were stopped. The downloaded module cache, the built binary and the run directory stayed in the session's scratch area, outside the repository. They hold no credential, because none existed.
