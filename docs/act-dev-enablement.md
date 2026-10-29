# ACT DEV enablement checklist: AWS Terraform and Azure Terraform

Status: written 2026-10-27 against `origin/main` at `b583529` (merge of #295), for the owner decision "Clear paths to ACT enablement in both Azure and AWS for dev" (issue #39, comment 6442856302). That decision extends the DEV-only pilot exception from AWS Terraform to Azure Terraform, DEV only, under the same PLAN (`docs/act-pilot-plan.md`), release contract and gates. QA, PROD and GCP stay outside it.

This page is a checklist, not an authority. It enables nothing. ACT stays DISABLED, the repository ships no pilot contract, and no agent writes the contract, holds an approver key or initiates an apply. Every OWNER step below is done by a person. Every command on this page was checked against `src/cli/apply.ts` (`APPLY_USAGE` and `SUBCOMMANDS`), `src/cli/evidence.ts`, `src/operations/families/qualification.ts` and `bootstrap/`. Where a step uses a tool that is not `./alz` (Terraform, the AWS CLI, the Azure CLI, OpenSSL, git), this page says so.

Status words:

- **DONE**: merged on `main`; the cited PR and evidence path prove it.
- **IN PROGRESS**: an open PR or an active lane on issue #39 owns it.
- **MISSING**: an engineering task that nobody owns yet. Each one is small and names its files.
- **OWNER**: a step only a person can take.

Evidence from a fake engine or an emulator is SYNTHETIC. It never counts as live provider qualification (`AGENTS.md`).

## One contract, one cloud at a time

The product reads exactly one pilot contract, `config/act-pilot-contract.json` (`repoPaths()` in `src/apply/contract.ts`). The contract is the authorization: its `authorize` entry lists, per environment, the operations ACT may run (owner decisions of 2026-10-27, issue #39, "Unpin the ACT decision"; the old `config/act-pilot-contract.sha256` pin and `./alz apply pin` are removed). A contract names one `provider`. So AWS DEV and Azure DEV are still two separate enablements, one after the other. Switching clouds changes the contract hash and its authorizing entry, which every sealed plan binds. Plans sealed under the other contract are refused (`ACT_AUTHORIZATION_CHANGED` or `ARTIFACT_INVALID`), and the other cloud's qualification evidence no longer matches the DEV target. Running both clouds live at the same time needs the product to select between more than one committed contract, which is an open follow-up, not a task on this page.

The owner decision does not set the order. `config/release/status.json` currently says Azure "waits on the AWS Terraform row going live first". The Azure lane is updating that line (check-in 6442903960).

## AWS Terraform DEV

### Gate table

| Gate | Status | What proves it |
| --- | --- | --- |
| G0: provider, engine, roles, rollback | **DONE** (#277, merge `8fb945e`) | `docs/act-pilot-aws-terraform-g0.md`; `config/act-pilot-contract.aws-dev.example.json`; `./alz apply contract-check --file DRAFT.json` (`src/apply/contract-check.ts`, `test/apply-contract-check.test.ts`) |
| DEV-only contract scope | **DONE** (on `main` before this work) | `src/apply/contract.ts` `validate`: `enabledEnvironments: ["DEV"]` is accepted for `AWS` + `TERRAFORM` only; `docs/act-dev-1.md` |
| G1: denial paths | **DONE** | `test/apply-boundary.test.ts`, `test/apply-cli.test.ts`, `test/apply-seal.test.ts`, `test/apply-approval.test.ts`, `test/apply-identities.test.ts`, `test/apply-aws.test.ts`, `test/teardown-driver-denials.test.ts`, `test/apply-ledger.test.ts` (fake engine; listed in the G0 gap table) |
| Requester signing (authority item 3) | **DONE** (#286, merge `cbf19a6`) | `src/apply/approval.ts`, `src/apply/seal.ts`; `test/apply-requester.test.ts` |
| Cleanup: closed allowlist, SCP-only, PROD quorum | **DONE** (#264, `84e51ec`; #294, `41f7132`; #295, `b583529`) | `src/observe/aws-leaf-types.ts`, `src/apply/cleanup-proposal.ts`; `test/apply-cleanup.test.ts`, `test/apply-cleanup-requester.test.ts` |
| CDK cleanup stack | **DONE** (#265, `5edcded`; #266, `3a37a32`; #267, `78a5c20`) | Not on the Terraform path; listed for completeness |
| AWS CLI pin | **DONE** (#288, merge `8fd5a70`) | `config/tool-pins.json` `awsCli`. Used by the CDK path (`prepare --aws-cli-version`), not by Terraform DEV |
| G1b: emulated simulation | **DONE** (#279, merge `df7708a`) | `docs/act-pilot-simulation-aws.md`; `test/apply-emulated-aws.test.ts` (real Terraform 1.16.4 against moto, opt-in, SYNTHETIC/emulated) |
| Backend-redirection fix (backend pinning) | **IN PROGRESS** (lane `backend-pin-override`, check-in 6442419794; no PR yet) | Replaces the hand-written reader in `src/apply/backend-block.ts`, whose s3 rule `main` still passes for the reviewer's reproduction (escalation 6437189291). Design adopted in 6442530013: a product-written `zzzz_alz_backend_override.tf`. **Blocks the authorization commit** |
| G1b re-run on the backend-pinned path | **MISSING** (A1 below) | `test/apply-emulated-aws.test.ts` passing on a `main` that contains backend pinning, recorded in `docs/act-pilot-simulation-aws.md` |
| DISCOVERY control-plane scope | **IN PROGRESS** (#293, head `5772f2f`) | `bootstrap/aws/discovery.tf`, `bootstrap/aws/discovery-policy.json`; `test/discovery-scope.test.ts`. Changes what the DEV bootstrap creates, so the owner bootstraps after it merges |
| Release status and G0 page are current | **MISSING** (A2 below) | `config/release/status.json` `act:aws-terraform` `nextAction` still says "Engineering still owes G1b"; `docs/act-pilot-aws-terraform-g0.md` (G1b row and checklist step 6) still says the AWS simulation does not exist |
| Evidence runner | **DONE** for S1 (#291, `e4b80e9`; hardening #292, `39f6e26`); **IN PROGRESS** for S2–S6 (lane EVR, branch `release/evr-s2-s6`) | `./alz evidence init`, `run`, `status`. S2–S6 add the read-only stages, the guided `act:<path>`, `cleanup:<path>` and `recovery` stages and the summary; the run sheet is in [`evidence-runner.md`](evidence-runner.md). Not required for the authorization commit |
| G0 owner items: roles, host, scope, cleanup owner | **OWNER** | Written down by the owner; `docs/act-pilot-aws-terraform-g0.md`, "Approver roles" |
| Bootstrap and federated identity | **OWNER** | `bootstrap/aws`; `docs/act-pilot-bootstrap.md`, Steps 2 to 6 |
| Contract draft complete | **OWNER** | `./alz apply contract-check --file config/act-pilot-contract.json` exits 0 (COMPLETE) |
| Preflight ready but for qualification | **OWNER** | `./alz apply preflight --environment DEV` |
| Authorization commit (enables the DEV pilot) | **OWNER** | `config/act-pilot-contract.json` with `enabled: true` and `"authorize": { "DEV": [...] }` in one reviewed commit |
| G2: qualification and first DEV apply | **OWNER** | `./alz apply qualify` with the `SEPARATED` attestation (encrypted under `.runs/apply/qualification`); one supervised apply; `./alz apply record-live` writes `config/acceptance/evidence/<cloud>-<engine>-execute-dev-<artifact>.json` |
| G3: admission | **OWNER** | `./alz qualify admission --manifest <evidence-index-file>` after the live record |
| G4: QA and PROD promotion | Out of scope | The DEV-only contract has no QA or PROD target |
| G5: recovery | **OWNER** | `./alz apply record-recovery` after a real interrupted run and a new approved run (`act-run-recovery` gate) |

### MISSING engineering tasks (AWS)

- **A1. Re-run G1b on the backend-pinned path.** Backend pinning changes the files `init` reads. After it merges, run the opt-in test again with the pinned binary and record the run.
  - Files: `docs/act-pilot-simulation-aws.md` (status line and results). Change `test/apply-emulated-aws.test.ts` only if the override needs a fixture change.
  - Run: `docs/act-pilot-simulation-aws.md`, "How to run it" (DEV MODE ONLY). This could be part of the backend-pin lane's own PR. If so, close A1 there.
- **A2. Correct the stale AWS status lines.**
  - Files: `config/release/status.json` (`act:aws-terraform` `nextAction`: drop "Engineering still owes G1b"; name backend pinning and #293 as the remaining engineering items), then regenerate `docs/release-status.md`.
  - Also `docs/act-pilot-aws-terraform-g0.md`: in the G1b row of the gap table, cite #279 and `docs/act-pilot-simulation-aws.md`; in checklist step 6, replace "Wait for G1b" with "Wait for backend pinning and #293".
  - `config/release/status.json` is a shared file. The Azure lane holds it now for the `act:azure-terraform` line, so this edit is sequenced after that lane releases it.

### Owner steps (AWS), with exact commands

Run these in order. Steps marked "not `./alz`" use a vendor tool.

1. **G0 decisions.** Assign the roles in `docs/act-pilot-aws-terraform-g0.md` ("Approver roles") to people. Choose the execution host, the one additive change and the cleanup owner. No command.
2. **DEV account.** Create or verify the DEV member account, credits or authorized spend, and budget alerts (`docs/act-dev-1.md`, D1 and D2). No `./alz` command.
3. **Federated identity issuer.** Decide where the four web-identity tokens come from. GitHub OIDC is not available on an arbitrary terminal; use a self-hosted issuer or another workload identity mechanism that writes one token file per identity, mode 0600, outside the working tree (`docs/act-pilot-bootstrap.md`, Steps 3 and 4). For GitHub, create one environment per identity, for example `dev-discovery`, `dev-state`, `dev-state-write` and `dev-apply`. Put required reviewers on STATE_WRITE and APPLY.
4. **Bootstrap** (Terraform and the AWS CLI, not `./alz`; with a separately held admin identity for the DEV account only; after #293 merges):

   ```bash
   export AWS_PROFILE=<dev-admin-profile>
   aws sts get-caller-identity                    # Account must be the DEV account
   cd bootstrap/aws
   cp terraform.tfvars.example dev.tfvars         # environment = "DEV", account_id, region, engine = "TERRAFORM",
                                                  # oidc_subjects, apply_managed_policy_arns, state_bucket_name,
                                                  # state_admin_principal_arns (and oidc_issuer_host for a self-hosted issuer)
   terraform init
   terraform workspace new dev
   terraform fmt -check && terraform validate
   terraform plan -var-file=dev.tfvars -out=dev.plan
   terraform apply dev.plan
   terraform output -json                         # role_arns, oidc_provider_arn, contract_target
   ```

5. **Credential preflight** in a separate shell, never the one that runs `./alz apply`. Use the `aws sts assume-role-with-web-identity` and `env -i ... aws sts get-caller-identity` checks in `docs/act-pilot-bootstrap.md`, Step 6. STATE can `head-object` the state key. A `put-object` canary as STATE or APPLY must be denied.
6. **Approver and requester keys** (OpenSSL, not `./alz`). Each person makes their own key on their own machine. Only the public key leaves it.

   ```bash
   umask 077
   openssl genpkey -algorithm ed25519 -out approver-dev.pem     # private, mode 0600, never shared
   openssl pkey -in approver-dev.pem -pubout                    # paste into approvers[].publicKeyPem
   ```

   `approve`, `seal` and `propose-cleanup` refuse a key file that is not mode 0600 or not Ed25519 (`APPLY_KEY_INVALID`).
7. **Draft the contract** (`enabled` stays `false`):

   ```bash
   cp config/act-pilot-contract.aws-dev.example.json config/act-pilot-contract.json
   # fill: policyVersion, targets.DEV.{accountId, region, backend "<bucket>/<key>", workspace},
   #       requiredApprovals.DEV, maxApprovalAgeMinutes, approvers[], killSwitchPath
   ./alz apply contract-check --file config/act-pilot-contract.json   # repeat until exit 0 (COMPLETE); confirm each NOTICE
   ```

8. **Identities on the execution host.** Set twelve variables, with absolute token file paths:

   ```bash
   export ALZ_DISCOVERY_AWS_ROLE_ARN=arn:aws:iam::<dev-account>:role/<discovery-role>
   export ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE=/abs/path/discovery.jwt
   export ALZ_DISCOVERY_AWS_REGION=<region>
   # the same three for STATE, STATE_WRITE and APPLY
   ./alz apply preflight --environment DEV --contract config/act-pilot-contract.json
   ```

   Every item must be READY except qualification. Do not export `AWS_PROFILE`, `AWS_ACCESS_KEY_ID` or the other fallback variables on this host (`docs/act-pilot-apply.md`, "AWS").
9. **Optional: the evidence runner** (`./alz evidence`). It sequences steps 12 to 15 for you, one path at a time, while you still type every phrase. It also runs the read-only provider qualification and the summary, and journals each step's exit code and the documents it wrote. The command sequence per path is the owner run sheet in [`evidence-runner.md`](evidence-runner.md). Not required for the authorization commit.
10. **Wait for engineering:** backend pinning merged, A1 done, #293 merged. If #293 merges after step 4, plan and apply the bootstrap again so DISCOVERY gets the new scope.
11. **Authorization commit.** This is the step that enables the pilot, and only the owner takes it. There is no hash to compute: the product derives the contract and entry hashes and binds them into every plan and approval.

    ```bash
    # edit config/act-pilot-contract.json: "enabled": true, "authorize": { "DEV": ["APPLY", "CLEANUP"] }
    ./alz apply contract-check --file config/act-pilot-contract.json   # COMPLETE; writes nothing
    git switch -c act-dev-aws-enable                    # git, not ./alz
    git add config/act-pilot-contract.json
    git commit                                         # one reviewed change; reviewers check the target, authorize and each key
    ./alz apply status --environment DEV               # "act": "PILOT_ENABLED"; AUTHORIZED lists DEV with its entry hash
    ```

    Open it as a PR and merge it through review. Every command that seals, proposes or runs a change (seal, qualify, apply, propose-cleanup, cleanup, propose-removal, remove-workspace) refuses a checkout with uncommitted changes, and also one whose contract bytes differ from the committed file (a skip-worktree, assume-unchanged or locally excluded edit), so the edit runs only once committed. An absent or empty `authorize` stays `ACT_DISABLED`; an operation it does not list is `ACT_NOT_AUTHORIZED`.
12. **G2 qualification** on the execution host, DEV only. The qualifier watches CloudTrail (STS and S3 data events):

    ```bash
    ./alz apply prepare --environment DEV --project <PROJECT_DIR>       # writes .runs/pilot/DEV/request-<id>.json and manifest-<id>.json
    ./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>
    # type SEPARATED <STATE_WRITE role ARN> <APPLY role ARN> only if CloudTrail shows state access by STATE_WRITE,
    # provider access by APPLY, and no state access by APPLY
    ./alz apply preflight --environment DEV                              # now READY, qualification included
    ```

13. **One supervised DEV apply**, in one channel (the terminal here; the console wizard runs the same steps):

    ```bash
    ./alz apply seal --request <REQUEST.json> --manifest <MANIFEST.json> --requester <ID> --key <REQUESTER_KEY.pem>
    ./alz apply approve --bundle <REVIEW_BUNDLE.json> --key <APPROVER_KEY.pem> --approver <ID>   # each approver, own machine
    ./alz apply apply --request <REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <APPROVAL.json>
    ./alz apply status --sealed <SEALED_PLAN>
    ./alz apply record-live --sealed <SEALED_PLAN>                       # type LIVE DEV <12 chars>; commit the file it writes
    ```

14. **Cleanup**, authorized separately by the cleanup owner:

    ```bash
    ./alz apply observe --sealed <SEALED_PLAN>
    ./alz apply propose-cleanup --sealed <SEALED_PLAN> --requester <ID> --key <REQUESTER_KEY.pem>
    ./alz apply approve --bundle <PROPOSAL.json> --key <APPROVER_KEY.pem> --approver <ID>          # APPROVE CLEANUP DEV ...
    ./alz apply cleanup --proposal <PROPOSAL.json> --request <REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <CLEANUP_APPROVAL.json>
    ./alz apply verify-cleanup --proposal <PROPOSAL.json>
    ./alz apply report --sealed <SEALED_PLAN> --proposal <PROPOSAL.json>
    ```

15. **G3 and G5.** Run `./alz qualify admission --manifest <evidence-index-file>` after the live record. Record recovery with `./alz apply record-recovery --sealed <INTERRUPTED_SEALED_PLAN> --resumed <RESUMED_SEALED_PLAN> --target-hardware-id <HOST>` once a real interrupted run and a new approved run exist.

## Azure Terraform DEV

### Gate table

| Gate | Status | What proves it |
| --- | --- | --- |
| DEV-only contract scope for Azure | **DONE** (#298, merge `5e99385`; generalized by the contract-authorization PR to one DEV-only rule for every implemented path) | `src/apply/contract.ts` `validate`; `test/apply-contract.test.ts` accepts an Azure Terraform DEV-only contract and refuses QA and PROD in it |
| G0: provider, engine, roles, rollback | **MISSING** (Z1 below) | No Azure G0 page and no Azure DEV-only example contract. The provider facts are in `docs/act-pilot-apply.md` ("Azure"). The rollback and partial-failure behavior is generic (`docs/act-pilot-aws-terraform-g0.md`) |
| G1: denial paths | **DONE** | The same generic tests as AWS, plus `test/apply-cleanup-azure.test.ts` and `test/ui-channel.test.ts` (Azure in the console); `config/acceptance/journeys.json` AZURE TERRAFORM rows are SYNTHETIC_PASS |
| Requester signing; PROD cleanup quorum | **DONE** (#286, #295) | Provider-independent; same tests as AWS |
| Backend-redirection fix for `azurerm` | **IN PROGRESS** (the same backend-pin lane as AWS) | The lane's claim covers `src/apply/providers/*`. On `main` the Azure backend block is not judged at all (`docs/act-pilot-apply.md`, "Providers") |
| Entra-only state auth | **IN PROGRESS** (#287, head `8b408f5`; #289, head `450d1e6`) | Must rebase onto backend pinning and drop its own reader (6440778421, 6442419794). **Required:** `bootstrap/azure` disables account keys and SAS on the state accounts, so only Entra authorization works, and the runner profile does not yet set it (`docs/act-pilot-apply.md`, "Azure") |
| G1b: emulated simulation | **MISSING** for the Entra-only path (Z2 below) | `test/apply-emulated.test.ts` and `docs/act-pilot-simulation.md` passed on 2026-10-27, but with SAS and access-key auth, which Entra-only will refuse. Needs the test-only SAS allowance (owner decision 6432984515). Lane (b) plans it as PR 2, after backend pinning |
| Bootstrap supports a DEV-only run | **MISSING** (Z3 below) | `bootstrap/azure/variables.tf` requires exactly three distinct subscriptions and storage accounts; `providers.tf`, `environments.tf` and `identities.tf` hard-code DEV, QA and PROD |
| DISCOVERY read scope (owner decision 6440801434, item 2) | **MISSING** check (Z4 below) | #293 covers AWS only. Azure DISCOVERY is Reader (`docs/act-pilot-bootstrap.md`), which has not been reviewed against "control-plane metadata only" |
| Release status line | **IN PROGRESS** (the same Azure lane) | `config/release/status.json` `act:azure-terraform` `nextAction` |
| Bootstrap, federated identity, contract, preflight, authorization commit, G2, G3, G5 | **OWNER** | As for AWS, with the Azure commands below |

### MISSING engineering tasks (Azure)

- **Z1. Azure G0 package and DEV-only example contract** (docs and config only).
  - New file `config/act-pilot-contract.azure-dev.example.json`: `provider: "AZURE"`, `engine: "TERRAFORM"`, `enabledEnvironments: ["DEV"]`, `targets.DEV.{tenantId, subscriptionId, backend "<storage-account>/<container>/<key>", workspace}` with fake values (an `examplefake` storage account, repeated-digit GUIDs), and `REPLACE-WITH` approver and `policyVersion`.
  - Add a case to `test/apply-contract-check.test.ts`: the example is never COMPLETE, and `inspectPilotContract` accepts its shape once the DEV-only exception lands.
  - New file `docs/act-pilot-azure-terraform-g0.md`, mirroring the AWS page: provider and engine, the four app registrations with one federated credential each, roles, an owner-input table mapped to the Azure fields, and an owner checklist.
  - Sequenced after the Azure contract lane, which owns `src/apply/contract.ts`.
- **Z2. Azure G1b on the Entra-only, backend-pinned path.** Add the test-only SAS allowance to the emulated harness only. The allowance must live in test code, so no product path accepts SAS. Run `test/apply-emulated.test.ts` with the pinned Terraform 1.16.4 and Azurite.
  - Files: `test/apply-emulated.test.ts`, its helpers under `test/helpers/` if needed, `docs/act-pilot-simulation.md`.
  - Lane (b) PR 2 plans this after backend pinning and #287/#289 merge.
- **Z3. DEV-only mode for `bootstrap/azure`.** Make QA and PROD optional, so an owner with one subscription can bootstrap DEV alone, and keep the three-environment form unchanged.
  - Files: `bootstrap/azure/variables.tf` (relax the "== 3" conditions to "distinct across the environments given"), `providers.tf` and `environments.tf` (one provider and module per environment present, or a `dev_only` switch), `identities.tf` (federated credentials only for the environments present), `outputs.tf`, `terraform.tfvars.example`.
  - Also `docs/act-pilot-bootstrap.md` (Step 1) and the `bootstrap/azure` offline test (`terraform validate`, or a `terraform test` file, as #293 adds for `bootstrap/aws`).
  - Workaround until it lands: the owner supplies three subscriptions.
- **Z4. Azure DISCOVERY scope review.** Confirm that Reader on the pilot resource group exposes control-plane metadata only (no `listKeys`, no secret or data reads), or narrow it to a custom role. Record the result.
  - Files: `bootstrap/azure/identities.tf` or `bootstrap/azure/modules/environment` (the DISCOVERY role assignment), `docs/act-pilot-bootstrap.md` (the identity table).
  - If Reader already holds, this is a docs-only note.

### Owner steps (Azure), with exact commands

1. **G0 decisions.** Assign roles (pilot owner, operator, DEV approver, qualifier, cleanup owner), the execution host, the one additive change and the cleanup owner. Use Z1's page when it lands.
2. **Tenant and DEV subscription.** You need Application Administrator or Cloud Application Administrator in the tenant, and Owner (or Contributor plus User Access Administrator) on the subscription: the bootstrap defines APPLY's custom roles, which needs `Microsoft.Authorization/roleDefinitions/write`, and Role Based Access Control Administrator holds only role assignment writes (UNVERIFIED: built-in role contents as of 2026-10-28; check with `az role definition list --name "Role Based Access Control Administrator"`). Register `Microsoft.Storage` (`docs/act-pilot-bootstrap.md`, "Prerequisites").
3. **Federated identity issuer.** As for AWS step 3. Each of the four identities needs its own subject per environment. GitHub's audience is `api://AzureADTokenExchange`.
4. **Bootstrap** (Terraform and the Azure CLI, not `./alz`). Until Z3 lands this needs three subscriptions.

   ```bash
   az login --tenant <tenant-id>
   az account set --subscription <dev-subscription-id>
   az provider register --namespace Microsoft.Storage --wait
   cd bootstrap/azure
   cp terraform.tfvars.example terraform.tfvars   # replace every fake value; state_allowed_ip_ranges is required
   terraform init
   terraform fmt -check && terraform validate
   terraform plan -out=bootstrap.plan
   terraform apply bootstrap.plan
   terraform output -json                          # tenant_id, identity_client_ids, contract_targets, apply_scopes
   ```

5. **Credential preflight** in a separate shell (`docs/act-pilot-bootstrap.md`, Step 6, Azure): `az login --service-principal ... --federated-token` per identity in a throwaway `AZURE_CONFIG_DIR`. Check that STATE lists the container and cannot upload, and that APPLY and DISCOVERY cannot list it.
6. **Approver and requester keys.** As for AWS step 6.
7. **Draft the contract.** Start from `config/act-pilot-contract.azure-dev.example.json` once Z1 lands. Until then, start from `config/act-pilot-contract.example.json` and reduce it to `enabledEnvironments: ["DEV"]`, `targets.DEV` and `requiredApprovals.DEV`. Add `"authorize": { "DEV": ["APPLY", "CLEANUP"] }` only in the owner's enabling commit (step 10).

   ```bash
   ./alz apply contract-check --file config/act-pilot-contract.json   # repeat until exit 0 (COMPLETE)
   ```

8. **Identities on the execution host.** Set five variables per identity: DISCOVERY, STATE, STATE_WRITE and APPLY. The client ids come from `identity_client_ids`.

   ```bash
   export ALZ_DISCOVERY_ARM_CLIENT_ID=<client-id>
   export ALZ_DISCOVERY_ARM_TENANT_ID=<tenant-id>
   export ALZ_DISCOVERY_ARM_SUBSCRIPTION_ID=<dev-subscription-id>
   export ALZ_DISCOVERY_ARM_USE_OIDC=true
   export ALZ_DISCOVERY_ARM_OIDC_TOKEN_FILE=/abs/path/discovery.jwt
   # the same five for STATE, STATE_WRITE and APPLY
   ./alz apply preflight --environment DEV --contract config/act-pilot-contract.json
   ```

   Do not export `AZURE_*`, `ARM_USE_*` other than `ARM_USE_OIDC` (including `ARM_USE_MSI` and `ARM_USE_AZUREAD`), or any `ARM_CLIENT_CERTIFICATE*` variable. Entra ID state authentication needs no variable: the product turns it on in its own backend file (`use_azuread_auth = true`; `docs/act-pilot-apply.md`, Azure). `ARM_STORAGE_USE_AZUREAD` is the azurerm provider's variable and the Terraform backend never reads it.
9. **Wait for engineering:** backend pinning, #287/#289, Z2, and Z3 if you bootstrap with one subscription.
10. **Authorization commit.** As for AWS step 11, with branch name `act-dev-azure-enable`. If the AWS contract is committed at the time, this replaces it (see "One contract, one cloud at a time").
11. **G2 qualification.** As for AWS step 12. The attestation is `SEPARATED <STATE_WRITE client id> <APPLY client id>`, checked in the Entra sign-in logs and the storage logs.
12. **DEV apply, cleanup, G3 and G5.** The same commands as AWS steps 13 to 15. Cleanup never deletes a resource group, an identity, the state backend or deployment history (`docs/act-pilot-plan.md`, "Cleanup of pilot-created resources").

## Kill switch (both clouds)

The contract's `killSwitchPath` names a file. A relative path is resolved under the repository root.

```bash
touch .runs/apply/KILL       # stop: seal, qualify and apply refuse; a running apply is stopped (SIGINT, then SIGKILL after 60 s)
./alz apply status           # reports contract.killSwitch: true while an authorized contract is enabled
rm .runs/apply/KILL          # the owner removes it; the code never does
```

A switch that cannot be read counts as on. The points where it is read, and what each outcome means, are in `docs/act-pilot-apply.md` ("Kill switch", "When an apply fails").

## Shortest path

### AWS Terraform DEV

Engineering, in order:

1. Backend pinning merges (backend-pin lane, IN PROGRESS).
2. A1: G1b re-run on the backend-pinned path, recorded in `docs/act-pilot-simulation-aws.md`. This can ride in the backend-pin PR.
3. #293 DISCOVERY control-plane scope merges (IN PROGRESS).
4. A2: correct `act:aws-terraform` in `config/release/status.json` and the G1b lines in `docs/act-pilot-aws-terraform-g0.md` (after the Azure lane releases `status.json`).

Owner, in order, up to and including the authorization commit:

1. Assign roles; choose the execution host, the change and the cleanup owner.
2. Verify the DEV account and budget.
3. Set up the federated identity issuer and the four subjects.
4. Bootstrap `bootstrap/aws` for DEV, after #293.
5. Run the credential preflight (`docs/act-pilot-bootstrap.md`, Step 6).
6. Generate the Ed25519 keys and collect the public keys.
7. Draft `config/act-pilot-contract.json` from the AWS DEV example until `./alz apply contract-check --file config/act-pilot-contract.json` is COMPLETE.
8. Set the twelve `ALZ_*_AWS_*` variables; `./alz apply preflight --environment DEV` is READY but for qualification.
9. Set `enabled: true` and `"authorize": { "DEV": ["APPLY", "CLEANUP"] }`, and commit the contract in one reviewed change.

### Azure Terraform DEV

Engineering, in order:

1. The Azure DEV-only contract exception merges (`src/apply/contract.ts`, Azure lane, IN PROGRESS).
2. Backend pinning merges, covering `azurerm` (backend-pin lane, IN PROGRESS).
3. #287/#289 Entra-only state auth, rebased onto backend pinning, merge (IN PROGRESS).
4. Z2: Azure G1b on the Entra-only path with the test-only SAS allowance (lane b, PR 2).
5. Z1: Azure G0 page and `config/act-pilot-contract.azure-dev.example.json`.
6. Z3: DEV-only mode for `bootstrap/azure`. Skip it if the owner bootstraps with three subscriptions.
7. Z4: Azure DISCOVERY scope review.

Owner, in order, up to and including the authorization commit:

1. Assign roles; choose the execution host, the change and the cleanup owner.
2. Confirm the tenant and subscription permissions; register `Microsoft.Storage`.
3. Set up the federated identity issuer and the four subjects.
4. Bootstrap `bootstrap/azure`: after Z3 with DEV only, or now with three subscriptions.
5. Run the credential preflight (`docs/act-pilot-bootstrap.md`, Step 6, Azure).
6. Generate the Ed25519 keys and collect the public keys.
7. Draft the Azure DEV contract until `./alz apply contract-check --file config/act-pilot-contract.json` is COMPLETE.
8. Set the twenty `ALZ_*_ARM_*` variables, plus #289's state-auth variable once documented; `./alz apply preflight --environment DEV` is READY but for qualification.
9. Decide whether this replaces a committed AWS contract. Set `enabled: true` and `"authorize": { "DEV": ["APPLY", "CLEANUP"] }`, and commit the contract in one reviewed change.

For both clouds, G2 starts after the authorization commit: `./alz apply qualify` with the `SEPARATED` attestation, one supervised DEV apply, then `./alz apply record-live`.
