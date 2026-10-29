# AWS Terraform execution brief: the first live DEV canary

Status: prefilled from `main` at `a075380` for the owner closeout direction of 2026-10-29 (issue #39, comment 6508815426, item 5) and the earlier owner input sheet (6486480658, track B). It covers one path, AWS Terraform, in DEV only, and one canary. Everything already decided is filled in below. Only the eight owner fields remain open, followed by the six-step owner sequence.

Every `./alz` command and flag on this page was checked against the CLI source: `src/cli/apply.ts` (`APPLY_USAGE`, `SUBCOMMANDS`), `src/cli/evidence.ts` (`parseEvidenceArgs`), `src/cli/operator.ts` and the catalog groups in `src/operations/`. `test/act-aws-terraform-execution-brief.test.ts` keeps it that way. Steps that use another tool (Terraform, the AWS CLI, OpenSSL, git, GitHub) say so.

## Authority

- **This page authorizes nothing.** It enables no ACT, grants no IAM, authorizes no spending and starts no run.
- **ACT stays DISABLED** until the owner's own reviewed commit of `config/act-pilot-contract.json` with its `authorize` entry (step 3). The repository ships no contract. No product code path, flag, environment variable or agent writes one.
- **Agents never run these steps against the cloud.** They never hold an approver or requester key and never initiate an apply or a cleanup. Every phrase is typed by a person. Every step below is the owner's, or done by a person the owner names.
- **Sensitive values stay off GitHub.** Do not post account ids, role ARNs, observed subjects, the bucket name, keys, tokens or the owner tag on issue #39 or in a PR other than the contract commit itself. Keep the filled copies of `dev.tfvars`, `terraform.tfvars.json` and `config/evidence-runner.json` out of the repository.
- Evidence from a fake engine or an emulator is SYNTHETIC and never counts as live provider qualification (`AGENTS.md`).

## The eight owner fields

These are the only open inputs. Fill them in on your own machine. Do not post them here.

```text
DEV AWS account:
Region:
State bucket/key and workspace:
Verified role ARNs and identity-delivery configuration:
Canary name and owner tag:
Approved spend ceiling, period and expiry:
Cleanup owner and maximum lifetime:
Requester/approver public identities:
```

Where each one goes:

| Field | Fills | Checked by |
| --- | --- | --- |
| DEV AWS account | Contract `targets.DEV.accountId` (12 digits). Bootstrap `account_id` in `dev.tfvars`. The account part of every `ALZ_<IDENTITY>_AWS_ROLE_ARN`. Evidence runner `aws.expectedAccountId`. | `contract-check`; `preflight` (every role ARN must name this account); the AWS provider's `allowed_account_ids` in the bootstrap |
| Region | Contract `targets.DEV.region`. Every `ALZ_<IDENTITY>_AWS_REGION`. Bootstrap `region`. The canary copy's `region` in `terraform.tfvars.json`. Evidence runner `aws.region`. | `preflight` (each identity's region must equal the contract's). The committed canary accepts only `us-east-2` (`variable "region"` validation in `qualification/aws/act-dev1-canary/main.tf`); another region needs a reviewed canary change. `contract-check` shows a NOTICE for `us-east-2` because the example uses it: confirm it is intended. |
| State bucket/key and workspace | Contract `targets.DEV.backend` as `<bucket>/<key>`, and `targets.DEV.workspace`. Bootstrap `state_bucket_name` and, optionally, `state_key` (default `pilot/dev.tfstate`; the lock object is `<key>.tflock`). | `contract-check`; the bootstrap output `contract_target` prints the `backend` and the workspace `default`. A NOTICE for `default` asks you to confirm it. |
| Verified role ARNs and identity-delivery configuration | `ALZ_DISCOVERY_AWS_ROLE_ARN`, `ALZ_STATE_AWS_ROLE_ARN`, `ALZ_STATE_WRITE_AWS_ROLE_ARN` and `ALZ_APPLY_AWS_ROLE_ARN`, from the bootstrap output `role_arns` (default names `alz-pilot-dev-discovery`, `alz-pilot-dev-state`, `alz-pilot-dev-state-write`, `alz-pilot-dev-apply`). Each `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` is `<root>/aws-terraform/<IDENTITY>.jwt`, where `<root>` is the runner's `ALZ_IDENTITY_DELIVERY_ROOT`. Bootstrap `oidc_subjects`: the four **observed** `sub` values from step 1. Bootstrap `apply_managed_policy_arns` (required), `apply_permissions_boundary_arn` (mandatory for ACT-DEV-1 acceptance) and `state_admin_principal_arns`. Evidence runner `act.repository`. | Not contract fields. `identity-check` (step 1), the bootstrap's credential preflight and `./alz apply preflight` (step 2), and the `SEPARATED` attestation at `qualify` (step 4). |
| Canary name and owner tag | The canary copy's `terraform.tfvars.json`: `canary_name`, which must match `^/alz/act-dev-1/[a-z0-9][a-z0-9-]{2,48}$`, and `owner`, which must match `^[A-Za-z0-9._@+-]{1,80}$`. Evidence runner `act.paths.aws-terraform.project`: the copy's absolute path. | Not contract fields. Terraform's own variable validation at `prepare`, `qualify` and `seal`. The contract's `canary` entry fixes only the type and count. |
| Approved spend ceiling, period and expiry | **Owner-enforced; the product does not check this.** It is not a contract field: the contract accepts a closed set of keys (`src/apply/contract.ts`), and none is a spend limit. `./alz apply preflight` reports "financial controls (budget alerts or cost cap)" as `UNVERIFIED`, advisory, and never stops a run. The bootstrap's optional `budget_monthly_usd` with `alert_emails` creates an AWS budget that alerts at 80 and 100 percent of actual spend. It does not stop spend, and alerts can lag by hours. `docs/act-dev-1.md` records a cumulative pilot credit ceiling of $80; that is context, not an authorization for this run. | You, in the billing console. |
| Cleanup owner and maximum lifetime | **Owner-enforced; the product does not check this.** Neither is a contract field, and nothing deletes the canary on a timer. The cleanup itself is governed: its requester must be an allowlisted `approvers[]` id for DEV (`propose-cleanup --requester`), and it needs `requiredApprovals.DEV` signed cleanup approvals. The canary's `retention_in_days = 30` is the retention of log events, not the lifetime of the log group. | You, by running step 6 within the lifetime you set. |
| Requester/approver public identities | Contract `approvers[]`: each entry's `id`, `publicKeyPem` (Ed25519 public key, PEM) and `environments: ["DEV"]`. The same ids go to `--requester` and `--approver`. Evidence runner `act.paths.aws-terraform.requesterId` and, optionally, `approverId`. In DEV one person may both request and approve (`REQUESTER_MAY_APPROVE` in `src/apply/approval.ts`). | `contract-check`; `seal`, `approve`, `propose-cleanup` and the driver verify every signature against this list. Private key files stay with each person (mode 0600) and are never posted or committed. |

## Already decided (prefilled)

| Decision | Value | Source |
| --- | --- | --- |
| Provider and engine | `"provider": "AWS"`, `"engine": "TERRAFORM"` | `config/act-pilot-contract.aws-dev.example.json`; `docs/act-pilot-aws-terraform-g0.md` |
| Scope | DEV only: `"enabledEnvironments": ["DEV"]`, exactly `targets.DEV` and `requiredApprovals.DEV` | `docs/act-dev-1.md`, "DEV-only contract" |
| Approvals | `"requiredApprovals": { "DEV": 1 }`; `"maxApprovalAgeMinutes": 30` as in the example (the validator allows 1 to 1440) | the example contract |
| State-writer binding | `"embedStateWrite": true`. A Terraform contract without it does not load. `seal` and `qualify` ask for the phrase `EMBED STATE_WRITE DEV`. | owner decision 6486426552; `docs/act-pilot-apply.md`, "Binding STATE_WRITE in the plan" |
| Identities | Four distinct IAM roles assumed through web identity, no static keys: DISCOVERY (plans), STATE (reads state and its serial, takes the lock), STATE_WRITE (`init`, workspace, state write and lock), APPLY (the provider writes in `terraform apply`). Twelve variables: `ALZ_<IDENTITY>_AWS_ROLE_ARN`, `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` and `ALZ_<IDENTITY>_AWS_REGION` for `<IDENTITY>` in `DISCOVERY`, `STATE`, `STATE_WRITE` and `APPLY`. | `docs/act-pilot-apply.md`, "Identities" and "AWS" |
| Refused on the execution host | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_CONTAINER_*`, `AWS_EC2_METADATA*`, `ARM_*`, `AZURE_*`, and a role ARN or token file equal to your own `AWS_ROLE_ARN` or `AWS_WEB_IDENTITY_TOKEN_FILE` | `docs/act-pilot-apply.md`, "AWS" |
| Identity delivery | D4 option A: the controlled self-hosted runner on the MBP, path `aws-terraform`, GitHub environments `act-dev-aws-terraform-discovery`, `act-dev-aws-terraform-state`, `act-dev-aws-terraform-state-write` and `act-dev-aws-terraform-apply`, token audience `sts.amazonaws.com` (the bootstrap's `oidc_audience` default; do not override it) | `docs/act-pilot-identity-delivery.md`, sections 2 and 10 |
| State backend | S3 with native locking: one versioned bucket, `use_lockfile = true`, no DynamoDB table. `init` saves exactly the contract's `bucket`, `key` and `region`, `use_lockfile = true` and STATE_WRITE's `assume_role_with_web_identity` (role ARN and token file **path**); anything else is `BACKEND_NOT_IN_CONTRACT`. The project's own backend block is replaced by the product's `backend "s3" {}` override. | `docs/act-pilot-apply.md`, "AWS" |
| Canary | One `aws_cloudwatch_log_group`, created and nothing else: contract `"canary": { "resources": [{ "type": "aws_cloudwatch_log_group", "count": 1 }] }`. The project is a copy of `qualification/aws/act-dev1-canary` outside the checkout: `hashicorp/aws` pinned at `= 6.68.0` with its committed lock file, 30-day retention, tags `environment`, `managed-by`, `purpose`, `owner` and the three unit tags | `docs/act-pilot-apply.md`, "Canary allowlist"; `qualification/aws/act-dev1-canary/main.tf` |
| Unit tags | `alz-managed-by`, `alz-unit` and `alz-build`, printed by `./alz apply prepare`. They are derived from the committed contract's hash, so they exist only after step 3, and any contract edit changes them. `seal` refuses a missing or foreign tag. | `src/apply/unit.ts`; `docs/act-pilot-apply.md`, "The deletion unit" |
| Authorization | `"enabled": true` and `"authorize": { "DEV": ["APPLY", "CLEANUP"] }` in one reviewed commit by the owner. No `REMOVE`, no QA, no PROD. | owner input sheet 6486480658, item 6; `docs/act-pilot-apply.md`, "The contract is the authorization" |
| Kill switch | `"killSwitchPath": ".runs/apply/KILL"` (relative to the repository root). While the file exists, `seal`, `qualify` and `apply` refuse and a running apply is stopped. A switch that cannot be read counts as on. Only you remove it. | the example contract; `docs/act-pilot-apply.md`, "Kill switch" |
| Channel | The terminal (`CLI`). `qualify` is terminal-only in practice, and the evidence runner's guided stages run at the terminal. The console's Pilot apply wizard is the alternative for `preflight`, `prepare`, `seal`, `approve` and `apply`. The channel is sealed into the plan: one workflow runs wholly in one channel, and a mix is refused (`CHANNEL_MISMATCH`). | `AGENTS.md`; `docs/act-pilot-apply.md`, "Channels" |
| Qualification lifetime | Qualification evidence covers an apply for at most 30 days. Seal and apply within 30 days of step 4, or qualify again. | `QUALIFICATION_MAX_AGE_DAYS` in `src/apply/contract.ts` |

### The contract you will commit in step 3

Start from `config/act-pilot-contract.aws-dev.example.json`. Angle brackets mark the eight fields. `policyVersion` is the label of the reviewed policy you commit with it (1 to 256 characters; `prepare` stops without it).

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "AWS",
  "engine": "TERRAFORM",
  "embedStateWrite": true,
  "policyVersion": "<your reviewed policy version label>",
  "enabledEnvironments": ["DEV"],
  "targets": {
    "DEV": {
      "accountId": "<DEV AWS account>",
      "region": "<Region>",
      "backend": "<state bucket>/<state key>",
      "workspace": "<workspace>",
      "canary": { "resources": [{ "type": "aws_cloudwatch_log_group", "count": 1 }] }
    }
  },
  "requiredApprovals": { "DEV": 1 },
  "maxApprovalAgeMinutes": 30,
  "approvers": [
    { "id": "<approver or requester id>", "publicKeyPem": "<Ed25519 public key PEM>", "environments": ["DEV"] }
  ],
  "killSwitchPath": ".runs/apply/KILL",
  "authorize": { "DEV": ["APPLY", "CLEANUP"] }
}
```

Until step 3, keep `"enabled": false` and leave out `authorize`.

## The six-step owner sequence

Run the steps in order. Each step names its pass criterion and when to stop. "Stop" means: do not go on to the next step, record what you saw on #39 without sensitive values, and decide with the coordinator. A stop never calls for a weaker check, a broader permission or a retry with different flags.

### Step 1: MBP D4 proof (identity delivery)

Do this on the MBP, as the dedicated runner user, after the settings checklist in `docs/act-pilot-identity-delivery.md`, section 10. The full procedure is section 11 of that page. Steps marked HOST_LOCAL are observations on the MBP, not provider evidence.

1. In GitHub (not `./alz`), dispatch "ACT identity delivery (DEV pilot)" on `main` for path `aws-terraform` with a 15-minute hold, and approve its four environments.
2. Export the twelve variables, with each token file at `<root>/aws-terraform/<IDENTITY>.jwt`, then check the delivery (HOST_LOCAL):

   ```sh
   ./alz apply identity-check --path aws-terraform --repository realjkg/agent-private-landing-zone --phase delivered
   ```

   Record the four observed `sub` values privately. They go into the bootstrap's `oidc_subjects` in step 2.
3. **Refresh.** In the same delivery, run the `--phase delivered` check twice, at least two minutes apart.
4. **Cleanup.** Run `touch <root>/aws-terraform/RELEASE`, wait for the run to finish (its cleanup job included), then:

   ```sh
   ./alz apply identity-check --path aws-terraform --repository realjkg/agent-private-landing-zone --phase cleaned
   ```

5. **Negative hook test, on each of the four runner instances** (HOST_LOCAL). Use the probe workflow on a throwaway branch that is never merged, one instance at a time, exactly as section 11, step 7 describes. Delete the branch afterwards.

**Pass:**

- the `delivered` check exits 0;
- the two refresh checks show changed fingerprints, and `secondsRemaining` stays above 60;
- the `cleaned` check exits 0;
- on every instance, both probe jobs fail at "Set up runner" with `ALZ_IDENTITY_RUNNER_REFUSED`, the log never shows `ALZ_IDENTITY_HOOK_ENV_LEAK`, neither `/tmp/alz-hook-env-reached-<N>` nor `/tmp/alz-hook-step-ran-<N>` exists, and no step ran.

**Stop:**

- `ALZ_IDENTITY_HOOK_ENV_LEAK` appears, or an `env-reached` marker exists. Job environment reaches the hook, so option A fails. Deliver no tokens. The fallback in section 14 is PROPOSED and needs your approval before any use.
- A probe step ran. That instance has no working hook and must not be used.
- Any `identity-check` exits non-zero.

### Step 2: verify cloud identities and state separation

1. **Bootstrap** (Terraform and the AWS CLI, not `./alz`), with a separately held, time-bound admin identity for the DEV account only. The pilot identities never run it. Follow `docs/act-pilot-bootstrap.md`, Step 2: copy `bootstrap/aws/terraform.tfvars.example` to `dev.tfvars`, set `environment = "DEV"`, `engine = "TERRAFORM"`, the account, region, bucket and the observed `oidc_subjects`, then `terraform init`, `terraform workspace new dev`, `terraform plan -var-file=dev.tfvars -out=dev.plan`, `terraform apply dev.plan` and `terraform output -json`.
2. **Credential preflight** (the AWS CLI, in a separate shell, never the one that runs `./alz apply`). Follow `docs/act-pilot-bootstrap.md`, Step 6: assume each role with its token alone, and print only the ARN. STATE can `head-object` the state key. A `put-object` of a canary key as STATE or as APPLY must be denied.
3. **Draft the contract** with `"enabled": false` and no `authorize`:

   ```sh
   cp config/act-pilot-contract.aws-dev.example.json config/act-pilot-contract.json
   ./alz apply contract-check --file config/act-pilot-contract.json
   ```

4. **Preflight** on the execution host, with a delivery running and the twelve variables set:

   ```sh
   ./alz apply preflight --environment DEV --contract config/act-pilot-contract.json
   ```

**Pass:**

- each role assumes from its own token, and nothing else;
- the state is readable by STATE, and the two `put-object` attempts are denied;
- `contract-check` exits 0 (COMPLETE), and you have confirmed each NOTICE (region, workspace, kill switch path);
- `preflight` shows every item READY except the authorization and qualification, which wait for steps 3 and 4.

**Stop:**

- any role assumes with another identity's token;
- STATE or APPLY can write the state;
- `preflight` reports `IDENTITY_COLLAPSED`, `IDENTITY_NOT_CONFIGURED`, a fallback variable or a wrong account or region.

**The CloudTrail separation attestation is made in step 4.** `qualify` refuses until the contract authorizes `APPLY` for DEV (`admit` in `src/apply/driver.ts`), so the `SEPARATED` check cannot run before step 3.

### Step 3: review and commit the bounded enabling contract

You alone take this step. It is the step that enables the pilot. There is no hash to compute.

```sh
# edit config/act-pilot-contract.json: "enabled": true, "authorize": { "DEV": ["APPLY", "CLEANUP"] }
./alz apply contract-check --file config/act-pilot-contract.json
git switch -c act-dev-aws-enable
git add config/act-pilot-contract.json
git commit
./alz apply status --environment DEV
```

Open it as a PR (git and GitHub, not `./alz`). Reviewers check the target, the `authorize` entry and each approver's key against what you supplied. Merge it through review.

**Pass:**

- the reviewed commit is on the branch you run from, with a clean checkout. Every command that seals, proposes or runs refuses uncommitted or locally masked contract changes.
- `status` lists DEV as AUTHORIZED for `APPLY` and `CLEANUP`, with its entry hash.

**Stop:**

- the review finds any value you did not supply;
- `authorize` names anything beyond DEV `APPLY` and `CLEANUP`;
- `status` reports `ACT_DISABLED` or `ACT_NOT_AUTHORIZED`.

To disable at any time, empty `authorize` in a new reviewed commit, or use the kill switch.

### Step 4: run qualification

On the execution host, in DEV only, with a fresh delivery. The qualifier watches CloudTrail (STS and S3 data events) during the run.

1. Copy `qualification/aws/act-dev1-canary` to a folder outside the checkout. Create `terraform.tfvars.json` there from `terraform.tfvars.example.json`, with your region, `canary_name` and `owner`.
2. Prepare, then copy the three unit tags it prints into `unit_tags`, and prepare again, so the request and manifest bind the final files. Use the request and manifest from the second run.

   ```sh
   ./alz apply prepare --environment DEV --project <CANARY_COPY>
   ./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>
   ./alz apply preflight --environment DEV
   ```

   `qualify` asks for the target, `RUN PROJECT CODE` and `EMBED STATE_WRITE DEV`. It runs `terraform version`, `init` and the workspace as STATE_WRITE, a throwaway plan as DISCOVERY that is never stored, and the state serial read as STATE. It applies nothing.
3. Type `SEPARATED <STATE_WRITE role ARN> <APPLY role ARN>` only if CloudTrail shows state access by STATE_WRITE, provider access by APPLY, and no state access by APPLY.

**Pass:**

- `qualify` writes its encrypted evidence and prints each adapter's evidence hash;
- `preflight` is READY on every item, qualification included.

**Stop:**

- CloudTrail shows APPLY touching the state, or any principal you did not expect. Do not type the phrase. Nothing is written.
- `qualify` refuses (for example `BACKEND_NOT_IN_CONTRACT`, `RESOURCE_NOT_IN_CANARY` or `PROVIDER_VERSION_NOT_REVIEWED`).

`qualify` records your attestation, not machine proof. The qualification does not run `terraform apply`, so the first supervised apply in step 5 is where the write separation first becomes observable.

### Step 5: you review, approve and personally start the sealed canary

One workflow, in the terminal channel, within 30 days of step 4. You, the requester and the approver may be one person in DEV.

```sh
./alz apply seal --request <REQUEST.json> --manifest <MANIFEST.json> --requester <ID> --key <REQUESTER_KEY.pem>
./alz apply approve --bundle <REVIEW_BUNDLE.json> --key <APPROVER_KEY.pem> --approver <ID>
./alz apply apply --request <REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <APPROVAL.json>
./alz apply status --sealed <SEALED_PLAN>
```

- `seal` asks for the target, `RUN PROJECT CODE` and `EMBED STATE_WRITE DEV`. It prints the artifact hash, the review bundle path and the change list.
- `approve` asks for `APPROVE DEV <first 12 characters of the artifact hash>`.
- `apply` asks for one line: `APPLY DEV <first 12 characters> <account> | <backend> | <workspace>`.
- Watch CloudTrail during the apply.

**Pass:**

- the change list shows exactly one `aws_cloudwatch_log_group` with action create, and nothing else, and the unit shown at `seal` and `approve` carries the tags `prepare` printed;
- `apply` exits 0 with outcome `SUCCEEDED`;
- CloudTrail shows the log group created by APPLY and the state written by STATE_WRITE.

**Stop:**

- before you approve: the change list shows anything else, or the provenance shows `UNQUALIFIED`. Do not approve.
- exit 2 (BLOCKED): nothing was spent. Read the code.
- exit 3 (SPENT) with `FAILED_NO_CHANGE`, `PLAN_STALE`, `PARTIAL_REQUIRES_REVIEW` or `KILLED`. **Do not retry.** Follow "When an apply fails" in `docs/act-pilot-apply.md`; a retry is always a new seal with new approvals.

Use the kill switch (`touch .runs/apply/KILL`) to stop at any point. See "Stop and recovery" below.

### Step 6: independent observation and approved cleanup, with a leftover check

The cleanup owner authorizes the cleanup separately, within the maximum lifetime you set.

```sh
./alz apply observe --sealed <SEALED_PLAN>
./alz apply propose-cleanup --sealed <SEALED_PLAN> --requester <ID> --key <REQUESTER_KEY.pem>
./alz apply approve --bundle <PROPOSAL.json> --key <APPROVER_KEY.pem> --approver <ID>
./alz apply cleanup --proposal <PROPOSAL.json> --request <REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <CLEANUP_APPROVAL.json>
./alz apply verify-cleanup --proposal <PROPOSAL.json>
./alz apply report --sealed <SEALED_PLAN> --proposal <PROPOSAL.json>
./alz apply record-live --sealed <SEALED_PLAN>
```

- `observe` reads the resource as DISCOVERY through Cloud Control. It is read-only and repeatable.
- The cleanup approval phrase is `APPROVE CLEANUP DEV <proposal12>`, and the cleanup phrase is `CLEANUP DEV <proposal12> <target>`.
- `verify-cleanup` is the leftover check.
- `record-live` asks for `LIVE DEV <first 12 characters>` and writes `config/acceptance/evidence/<cloud>-<engine>-execute-dev-<artifact>.json`. Review and commit that file.

**The evidence runner alternative.** `./alz evidence` sequences steps 4 to 6 at your terminal while you still type every phrase. It journals each step under `.runs/evidence`. Set up `config/evidence-runner.json` with `./alz evidence init`, then:

```sh
./alz evidence run --dry-run --stage act:aws-terraform
./alz evidence run --stage act:aws-terraform
./alz evidence run --stage cleanup:aws-terraform
./alz evidence status
```

`act:aws-terraform` runs `contract-check`, `identity-check`, `prepare`, `qualify`, `preflight`, `seal`, `approve`, `apply` and `observe`. `cleanup:aws-terraform` runs the cleanup half through `record-live` (`docs/evidence-runner.md`).

**Pass:**

- `observe` is VERIFIED: the log group exists, in the right region, with the unit tags;
- `cleanup` exits 0;
- `verify-cleanup` reports COMPLETE: the approved resource is confirmed deleted, and the deletion-unit sweep found nothing else;
- the lifecycle report and the live record are written.

**Stop:**

- `observe` is not VERIFIED: something is missing or misplaced, or something unexpected carries the run's tag. A person reviews before any cleanup.
- `propose-cleanup` fails closed.
- `verify-cleanup` reports `INCOMPLETE`, `STILL_PRESENT` or `UNKNOWN`.
- `cleanup` ends `PARTIAL_REQUIRES_REVIEW` or `KILLED`. Review by hand. A new proposal needs a new observation and new approvals.

## Stop and recovery

- **Kill switch.** `touch .runs/apply/KILL` stops `seal`, `qualify` and `apply`, and stops a running apply: SIGINT to Terraform, held until its first resource line, then SIGKILL to its process group after 60 seconds. `./alz apply status` reports it. Only you remove the file.
- **A state lock left behind.** A run that ends by SIGKILL cannot release its S3 lock (`<key>.tflock`). The next seal refuses with `Error acquiring the state lock`. The procedure is "Recovering a state lock left by a SIGKILL (owner, by hand)" in `docs/act-pilot-apply.md`: run as STATE_WRITE only, never APPLY, read the exact lock id, and only then run `terraform force-unlock <LOCK_ID>`. The product never removes a lock. Before unlocking, the owner direction of 2026-10-29 (6508815426, item 1) also requires that:
  - the original Terraform process and any competing writer have stopped;
  - the exact backend, workspace and lock id are verified;
  - the available run and state evidence is preserved;
  - who unlocked it, and why, is recorded;
  - the state and the cloud resources are reconciled before another approved operation is prepared.

  `force-unlock` removes the lock only. It does not change infrastructure or prove that an interrupted run recovered. `-lock=false` is never used.
- **A SIGKILLed run is not recovered evidence.** If the `./alz apply` process itself is killed after the engine started (SIGKILL, power loss), its ledger entry stays `RESERVED`. That artifact is never applicable again, and `./alz apply record-recovery` refuses it (`RECOVERY_RECORD_UNAVAILABLE`), so it is not G5 stop-test evidence. Review the state and resources by hand, then seal a new plan. Only a run the ledger finished as `PARTIAL_REQUIRES_REVIEW` or `KILLED`, followed by a new approved run that `SUCCEEDED`, can be recorded with `./alz apply record-recovery --sealed <INTERRUPTED_SEALED_PLAN> --resumed <RESUMED_SEALED_PLAN> --target-hardware-id <HOST>`.

## What this run proves, and what it does not

It proves only the exact account, source commit, Terraform binary and provider lock, identity subjects, contract, state backend, region, resource type and observed canary (`docs/act-dev-1.md`, "Acceptance scope"). It does not qualify AWS CDK, any other path, QA, PROD, general AWS ACT or production admission. The six-path release stays required.

`docs/aws-d4-qualification.md` describes a different, read-only check: the provider qualification of a controlled existing stack (`./alz qualify provider-aws`, or the evidence runner's `aws-readonly` stage). It is not part of this sequence and does not replace it.

Still unverified until this run: real IAM and token issuance, the AWS `s3:` condition keys, and the state-writer separation at `terraform apply` (`docs/act-pilot-apply.md`, "Still UNVERIFIED on real backends").

## Sources

- Owner direction: #39, 6508815426 (item 5) and 6486480658 (track B).
- `config/act-pilot-contract.aws-dev.example.json`; `src/apply/contract.ts`; `src/apply/unit.ts`; `src/apply/driver.ts`.
- `docs/act-pilot-aws-terraform-g0.md`; `docs/act-pilot-apply.md`; `docs/act-pilot-bootstrap.md`; `docs/act-pilot-identity-delivery.md`; `docs/act-dev-1.md`; `docs/aws-d4-qualification.md`; `docs/evidence-runner.md`.
- `bootstrap/aws` (`variables.tf`, `outputs.tf`, `terraform.tfvars.example`); `qualification/aws/act-dev1-canary`.
