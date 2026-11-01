# AWS Terraform execution brief: the first live DEV canary

Status: prefilled from `main` at `fd5fd9b`, for the owner closeout direction of 2026-10-29 (issue #39, comment 6508815426, item 5) and the earlier owner input sheet (6486480658, track B).

- It covers one path, AWS Terraform, in DEV only, and one canary.
- Everything already decided is filled in below.
- Only the eight owner fields remain open, plus one value you fill in the contract, `policyVersion` (see "The ninth value").
- The six-step owner sequence follows.

Every `./alz` command and flag on this page was checked against the CLI source:

- `src/cli/apply.ts` (`APPLY_USAGE`, `SUBCOMMANDS`);
- `src/cli/evidence.ts` (`parseEvidenceArgs`);
- `src/cli/operator.ts`;
- the catalog groups in `src/operations/`.

`test/act-aws-terraform-execution-brief.test.ts` keeps it that way. Steps that use another tool (Terraform, the AWS CLI, OpenSSL, git, GitHub) say so.

## Authority

- **This page authorizes nothing.** It enables no ACT, grants no IAM, authorizes no spending and starts no run.
- **ACT stays DISABLED** until your own reviewed commit of `config/act-pilot-contract.json` with its `authorize` entry (step 3). The repository ships no contract. No product code path, flag, environment variable or agent writes one, and no agent drafts one.
- **Agents never run these steps against the cloud.** They never hold an approver or requester key and never initiate an apply or a cleanup. Every phrase is typed by a person. Every step below is yours, or done by a person you name.
- **Sensitive values stay off GitHub.** Do not post account ids, role ARNs, observed subjects, the bucket name, keys, tokens or the owner tag on issue #39, or in any PR other than the contract commit itself. Keep the filled copies of `dev.tfvars`, `terraform.tfvars.json` and `config/evidence-runner.json` out of the repository.
- **Synthetic evidence is not live evidence.** Evidence from a fake engine or an emulator is SYNTHETIC and never counts as live provider qualification (`AGENTS.md`).

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
| DEV AWS account | The contract's `targets.DEV.accountId` (12 digits). The bootstrap's `account_id` in `dev.tfvars`. The account part of every `ALZ_<IDENTITY>_AWS_ROLE_ARN`. In the evidence runner, `aws.expectedAccountId` (only if you add the `aws` block; see "The evidence runner alternative"). | `contract-check`. `preflight`: every role ARN must name this account. The AWS provider's `allowed_account_ids` in the bootstrap. |
| Region | The contract's `targets.DEV.region`. Every `ALZ_<IDENTITY>_AWS_REGION`. The bootstrap's `region`. The `region` in the canary copy's `terraform.tfvars.json`. | `preflight`: each identity's region must equal the contract's. The committed canary accepts only `us-east-2` (the `variable "region"` validation in `qualification/aws/act-dev1-canary/main.tf`); another region needs a reviewed canary change. Terraform applies that validation at `qualify` and `seal`. `contract-check` shows a NOTICE for `us-east-2` because the example uses it: confirm it is intended. |
| State bucket/key and workspace | The contract's `targets.DEV.backend`, as `<bucket>/<key>`, and `targets.DEV.workspace`. The bootstrap's `state_bucket_name` and, optionally, `state_key` (default `pilot/dev.tfstate`; the lock object is `<key>.tflock`). | `contract-check`. The bootstrap output `contract_target` prints the `backend` and the workspace `default`. A NOTICE for `default` asks you to confirm it. |
| Verified role ARNs and identity-delivery configuration | `ALZ_DISCOVERY_AWS_ROLE_ARN`, `ALZ_STATE_AWS_ROLE_ARN`, `ALZ_STATE_WRITE_AWS_ROLE_ARN` and `ALZ_APPLY_AWS_ROLE_ARN`, from the bootstrap output `role_arns`. The default names are `alz-pilot-dev-discovery`, `alz-pilot-dev-state`, `alz-pilot-dev-state-write` and `alz-pilot-dev-apply`. Each `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` is `<root>/aws-terraform/<IDENTITY>.jwt`, where `<root>` is the runner's `ALZ_IDENTITY_DELIVERY_ROOT`. The bootstrap's `oidc_subjects` are the four **observed** `sub` values from step 1. The bootstrap variables are listed in step 2. In the evidence runner, `act.repository`. | Not contract fields. `identity-check` (step 1). The bootstrap's credential preflight and `./alz apply preflight` (step 2). The `SEPARATED` attestation at `qualify` (step 4). |
| Canary name and owner tag | The canary copy's `terraform.tfvars.json`: `canary_name`, which must match `^/alz/act-dev-1/[a-z0-9][a-z0-9-]{2,48}$`, and `owner`, which must match `^[A-Za-z0-9._@+-]{1,80}$`. In the evidence runner, `act.paths.aws-terraform.project`: the copy's absolute path. | Not contract fields. `prepare` runs no Terraform: it checks only that each variable has a value. Terraform's own variable validation first runs at `qualify` (the throwaway plan) and again at `seal`. The contract's `canary` entry fixes only the type and count. |
| Approved spend ceiling, period and expiry | **Owner-enforced; the product does not check this.** It is not a contract field: the contract accepts a closed set of keys (`src/apply/contract.ts`), and none is a spend limit. `./alz apply preflight` reports "financial controls (budget, alerts and cost visibility; advisory)" from the cost status `./alz cost status` last read (read-only) and saved on this computer, or `UNVERIFIED` when none was read. That item is advisory and never stops a run, and it reads whether a budget and its alerts exist, never a spend limit. The bootstrap's optional `budget_monthly_usd` with `alert_emails` creates an AWS budget. It alerts at 80 and 100 percent of actual spend, does not stop spend, and its alerts can lag by hours. `docs/act-dev-1.md` records a cumulative pilot credit ceiling of $80. That is context, not an authorization for this run. | You, in the billing console. |
| Cleanup owner and maximum lifetime | **Owner-enforced; the product does not check this.** Neither is a contract field, and nothing deletes the canary on a timer. The cleanup itself is governed. Its requester must be an allowlisted `approvers[]` id for DEV (`propose-cleanup --requester`), and it needs `requiredApprovals.DEV` signed cleanup approvals. The canary's `retention_in_days = 30` is the retention of log events, not the lifetime of the log group. | You, by running step 6 within the lifetime you set. |
| Requester/approver public identities | The contract's `approvers[]`: each entry's `id`, its `publicKeyPem` (an Ed25519 public key, PEM) and `environments: ["DEV"]`. The same ids go to `--requester` and `--approver`. In the evidence runner, `act.paths.aws-terraform.requesterId` and, optionally, `approverId`. In DEV one person may both request and approve (`REQUESTER_MAY_APPROVE` in `src/apply/approval.ts`). | `contract-check`. `seal`, `approve`, `propose-cleanup` and the driver verify every signature against this list. Private key files stay with each person (mode 0600) and are never posted or committed. |

### The ninth value: `policyVersion`

You also fill `policyVersion` in the contract. It is outside the eight open fields, but the product requires it:

- `contract-check` reports the example's `REPLACE-WITH-REVIEWED-POLICY-VERSION` as a placeholder, so the step 2 draft stays incomplete (exit 2) until you fill it;
- `prepare` stops with `POLICY_VERSION_MISSING` without it.

It is the label of the reviewed policy you commit with the contract: 1 to 256 characters, each a letter, digit, space or one of `. _ : / @ + = ~ -`.

## Already decided (prefilled)

| Decision | Value | Source |
| --- | --- | --- |
| Provider and engine | `"provider": "AWS"`, `"engine": "TERRAFORM"` | `config/act-pilot-contract.aws-dev.example.json`; `docs/act-pilot-aws-terraform-g0.md` |
| Scope | DEV only: `"enabledEnvironments": ["DEV"]`, with exactly `targets.DEV` and `requiredApprovals.DEV` | `docs/act-dev-1.md`, "DEV-only contract" |
| Approvals | `"requiredApprovals": { "DEV": 1 }`. `"maxApprovalAgeMinutes": 30`, as in the example; the validator allows 1 to 1440. | the example contract |
| State-writer binding | `"embedStateWrite": true`. A Terraform contract without it does not load. `seal` and `qualify` ask for the phrase `EMBED STATE_WRITE DEV`. | owner decision 6486426552; `docs/act-pilot-apply.md`, "Binding STATE_WRITE in the plan" |
| Identities | Four distinct IAM roles, assumed through web identity, with no static keys: DISCOVERY plans; STATE reads the state and its serial and takes the lock; STATE_WRITE runs `init` and selects the workspace, writing the state and the lock; APPLY makes the provider writes in `terraform apply`. Twelve variables: `ALZ_<IDENTITY>_AWS_ROLE_ARN`, `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` and `ALZ_<IDENTITY>_AWS_REGION`, for `<IDENTITY>` in `DISCOVERY`, `STATE`, `STATE_WRITE` and `APPLY`. | `docs/act-pilot-apply.md`, "Identities" and "AWS" |
| Refused on the execution host | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_SECURITY_TOKEN`, `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_CONTAINER_*`, `AWS_EC2_METADATA*`, `ARM_*`, `AZURE_*`, `GOOGLE_*`, `GCLOUD_*`, `CLOUDSDK_*` and `GCE_*`. Also refused: a role ARN or token file equal to your own `AWS_ROLE_ARN` or `AWS_WEB_IDENTITY_TOKEN_FILE`. | `FALLBACK_VARIABLE` in `src/apply/providers/aws.ts` |
| Identity delivery | D4 option A: the controlled self-hosted runner on the MBP, path `aws-terraform`. GitHub environments: `act-dev-aws-terraform-discovery`, `act-dev-aws-terraform-state`, `act-dev-aws-terraform-state-write` and `act-dev-aws-terraform-apply`. Token audience: `sts.amazonaws.com`, the bootstrap's `oidc_audience` default; do not override it. | `docs/act-pilot-identity-delivery.md`, sections 2 and 10 |
| State backend | S3 with native locking: one versioned bucket, `use_lockfile = true`, no DynamoDB table. `init` saves exactly the contract's `bucket`, `key` and `region`, `use_lockfile = true`, and STATE_WRITE's `assume_role_with_web_identity` (the role ARN and the token file **path**). Anything else is `BACKEND_NOT_IN_CONTRACT`. The product's `backend "s3" {}` override replaces the project's own backend block. | `docs/act-pilot-apply.md`, "AWS" |
| Canary | One `aws_cloudwatch_log_group`, created, and nothing else. In the contract: `"canary": { "resources": [{ "type": "aws_cloudwatch_log_group", "count": 1 }] }`. The project is a copy of `qualification/aws/act-dev1-canary`, outside the checkout. It pins `hashicorp/aws` at `= 6.68.0` with its committed lock file, keeps logs for 30 days, and tags `environment`, `managed-by`, `purpose`, `owner` and the three unit tags. | `docs/act-pilot-apply.md`, "Canary allowlist"; `qualification/aws/act-dev1-canary/main.tf` |
| Unit tags | `alz-managed-by`, `alz-unit` and `alz-build`, printed by `./alz apply prepare`. They are derived from the committed contract's hash, so they exist only after step 3, and any contract edit changes them. `seal` refuses a missing or foreign tag. | `src/apply/unit.ts`; `docs/act-pilot-apply.md`, "The deletion unit" |
| Request files | `prepare` writes two request files. `request-<tag>.json` is for `qualify` and `seal`. `apply-request-<tag>.json` holds exactly `environment`, `target` and `projectRoot`, and is for `apply` and `cleanup`. Each command refuses the other's file. | `src/apply/prepare.ts`; `src/cli/apply.ts` (#366) |
| Authorization | `"enabled": true` and `"authorize": { "DEV": ["APPLY", "CLEANUP"] }`, in one commit that you review. No `REMOVE`, no QA, no PROD. | owner input sheet 6486480658, item 6; `docs/act-pilot-apply.md`, "The contract is the authorization" |
| Kill switch | `"killSwitchPath": ".runs/apply/KILL"`, relative to the repository root. While the file exists, `seal`, `qualify` and `apply` refuse, and a running apply is stopped. A switch that cannot be read counts as on. Only you remove it. | the example contract; `docs/act-pilot-apply.md`, "Kill switch" |
| Channel | The terminal (`CLI`). `qualify` runs only at the terminal: it is not one of the console's steps (`PILOT_STEPS` in `src/cli/ui-channel.ts`). The console's Pilot apply wizard is the alternative for `preflight`, `prepare`, `seal`, `approve`, `apply`, `observe`, `propose-cleanup`, `cleanup` and `verify-cleanup`. `seal` binds the channel into the plan. `approve`, `apply` and `cleanup` refuse another channel (`CHANNEL_MISMATCH`), so one workflow runs wholly in one channel. | `AGENTS.md`; `docs/act-pilot-apply.md`, "Channels" |
| Qualification lifetime | Qualification evidence covers an apply for at most 30 days. Seal and apply within 30 days of step 4, or qualify again. | `QUALIFICATION_MAX_AGE_DAYS` in `src/apply/contract.ts` |

### The contract you will commit in step 3

Start from `config/act-pilot-contract.aws-dev.example.json`. Angle brackets mark the values you fill: the eight fields, and `policyVersion`.

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

Until step 3, keep `"enabled": false` and leave out `authorize`. You write this file yourself. No agent drafts it.

## The six-step owner sequence

Run the steps in order. Each step names its pass criterion and when to stop. "Stop" means three things:

- do not go on to the next step;
- record what you saw on #39, without sensitive values;
- decide with the coordinator.

A stop never calls for a weaker check, a broader permission, or a retry with different flags.

### Step 1: MBP D4 proof (identity delivery)

Run this on the MBP, as the dedicated runner user, after the settings checklist in `docs/act-pilot-identity-delivery.md`, section 10. The full procedure is section 11 of that page. HOST_LOCAL marks an observation on the MBP, not provider evidence.

1. In GitHub (not `./alz`), dispatch "ACT identity delivery (DEV pilot)" on `main` for path `aws-terraform`, with a 15-minute hold, and approve its four environments.
2. Export only the four `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` variables, each pointing at `<root>/aws-terraform/<IDENTITY>.jwt`. The role ARNs do not exist until step 2. `identity-check` reports the missing provider variables for information only. Then check the delivery (HOST_LOCAL):

   ```sh
   ./alz apply identity-check --path aws-terraform --repository realjkg/agent-private-landing-zone --phase delivered
   ```

   Record the four observed `sub` values privately. They go into the bootstrap's `oidc_subjects` in step 2.
3. **Refresh.** In the same delivery, run the `--phase delivered` check twice, at least two minutes apart.
4. **Cleanup.** Run `touch <root>/aws-terraform/RELEASE` and wait for the run to finish, its cleanup job included. Then run:

   ```sh
   ./alz apply identity-check --path aws-terraform --repository realjkg/agent-private-landing-zone --phase cleaned
   ```

5. **Negative hook test, on each of the four runner instances** (HOST_LOCAL). Use the probe workflow on a throwaway branch that is never merged, one instance at a time, exactly as section 11, step 7 describes. Delete the branch afterwards.

The cloud-trust check and the after-release check (section 11, steps 5 and 6) need the bootstrap and the authorized contract, so they are part of step 4 below.

**Pass:**

- the `delivered` check exits 0;
- the two refresh checks show changed fingerprints, and `secondsRemaining` stays above 60;
- the `cleaned` check exits 0;
- on every instance, both probe jobs fail at "Set up runner" with `ALZ_IDENTITY_RUNNER_REFUSED`;
- the log never shows `ALZ_IDENTITY_HOOK_ENV_LEAK`;
- neither `/tmp/alz-hook-env-reached-<N>` nor `/tmp/alz-hook-step-ran-<N>` exists;
- no probe step ran.

**Stop:**

- `ALZ_IDENTITY_HOOK_ENV_LEAK` appears, or an `env-reached` marker exists. The job environment reaches the hook, so option A fails. Deliver no tokens. The fallback in section 14 is PROPOSED and needs your approval before any use.
- A probe step ran. That instance has no working hook and must not be used.
- Any `identity-check` exits non-zero.

### Step 2: verify cloud identities and state separation

1. **Bootstrap** (Terraform and the AWS CLI, not `./alz`). Use a separately held, time-bound admin identity for the DEV account only. The pilot identities never run it. Follow `docs/act-pilot-bootstrap.md`, Step 2:
   1. Copy `bootstrap/aws/terraform.tfvars.example` to `dev.tfvars`.
   2. Set `environment = "DEV"`, `engine = "TERRAFORM"`, `account_id`, `region`, `state_bucket_name`, and `oidc_subjects` (the four observed values from step 1).
   3. Set `apply_managed_policy_arns` (required): the least-privilege APPLY policy. `docs/act-dev-1.md` asks for one that allows only the named log group in the region, with the mandatory tags and 30-day retention, and denies IAM, OIDC, backend and control-plane changes.
   4. Set `apply_permissions_boundary_arn`, which ACT-DEV-1 acceptance requires.
   5. Set `state_admin_principal_arns`, the role ARN patterns that may administer the bucket.
   6. Optionally set `budget_monthly_usd` and `alert_emails`.
   7. Run `terraform init`, `terraform workspace new dev`, `terraform plan -var-file=dev.tfvars -out=dev.plan`, `terraform apply dev.plan` and `terraform output -json`.
2. **Credential preflight** (the AWS CLI, in a separate shell, never the one that runs `./alz apply`). Follow `docs/act-pilot-bootstrap.md`, Step 6:
   - assume each role with its token alone, and print only the ARN;
   - STATE can `head-object` the state key;
   - a `put-object` of a canary key as STATE, or as APPLY, must be denied.
3. **Draft the contract** with `"enabled": false` and no `authorize`. Fill the eight fields' contract values and `policyVersion` between the two commands:

   ```sh
   cp config/act-pilot-contract.aws-dev.example.json config/act-pilot-contract.json
   ./alz apply contract-check --file config/act-pilot-contract.json
   ```

4. **Preflight** on the execution host, with a delivery running and all twelve variables set:

   ```sh
   ./alz apply preflight --environment DEV --contract config/act-pilot-contract.json
   ```

**Pass:**

- each role assumes from its own token, and nothing else;
- STATE can read the state, and both `put-object` attempts are denied;
- `contract-check` exits 0 (COMPLETE), and you have confirmed each NOTICE (region, workspace, kill switch path);
- `preflight` lists the identity, account, region, tool and kill switch items as READY.

  **At this step `preflight` exits 2, and that is expected.** The draft is neither enabled nor authorized, qualification is missing, and identity separation stays `UNVERIFIED` until step 4. The financial item is advisory throughout: `UNVERIFIED` until `./alz cost status` has read the DEV account's budget, then the state that read found.

**Stop:**

- any role assumes with another identity's token;
- STATE or APPLY can write the state;
- `preflight` reports `IDENTITY_COLLAPSED`, `IDENTITY_NOT_CONFIGURED`, a fallback variable, or a wrong account or region.

**The CloudTrail separation attestation is made in step 4.** `qualify` refuses until the contract authorizes `APPLY` for DEV (`admit` in `src/apply/driver.ts`), so the `SEPARATED` check cannot run before step 3.

### Step 3: review and merge the bounded enabling contract

You alone take this step. It is the step that enables the pilot. There is no hash to compute.

```sh
# edit config/act-pilot-contract.json: "enabled": true, "authorize": { "DEV": ["APPLY", "CLEANUP"] }
./alz apply contract-check --file config/act-pilot-contract.json
git switch -c act-dev-aws-enable
git add config/act-pilot-contract.json
git commit
```

1. Open the commit as a PR (git and GitHub, not `./alz`).
2. Reviewers check the target, the `authorize` entry and each approver's key against what you supplied.
3. Merge it to `main` through normal review, like any other change.
4. Then, on the merged `main`, run:

   ```sh
   ./alz apply status --environment DEV
   ```

**Merging with CI green depends on lane CI-1** (`release/ci-1-owner-contract-commit`). Today two tests assert that the repository ships no contract, and CI-1 retargets them so that your reviewed contract commit keeps CI green. The coordinator confirms that CI-1 has merged before you open this PR.

**Pass:**

- the reviewed commit is on `main`, and you run from a clean checkout of it. Every command that seals, proposes or runs refuses uncommitted or locally masked contract changes.
- `status` prints JSON with `"act": "PILOT_ENABLED"` and an `authorized` list with one entry: `"environment": "DEV"`, `"operations": ["APPLY", "CLEANUP"]` and its `authorizationSha256`.

**Stop:**

- the review finds any value you did not supply;
- `authorize` names anything beyond DEV `APPLY` and `CLEANUP`;
- `status` shows `"act": "DISABLED"`, or `contract.code` is `ACT_DISABLED` or `CONTRACT_INVALID`;
- DEV is absent from `authorized`.

To disable at any time, empty `authorize` in a new reviewed commit, or use the kill switch.

### Step 4: run qualification

Run this on the execution host, in DEV only, with a fresh delivery and all twelve variables set. CloudTrail must log S3 data events for the state bucket. Data events are not logged by default, so enable them on a trail before the run. The qualifier watches CloudTrail during the run.

1. Copy `qualification/aws/act-dev1-canary` to a folder outside the checkout. Create `terraform.tfvars.json` there from `terraform.tfvars.example.json`, with your region, `canary_name` and `owner`.
2. Run `prepare` once. It succeeds with the placeholder unit tags, because it runs no Terraform. Copy the three unit tags it prints into `unit_tags`. Then run `prepare` again, so that the request files and the manifest bind the final files. Use the files from the second run: `request-<tag>.json` (shown below as `REQUEST.json`), `apply-request-<tag>.json` (`APPLY_REQUEST.json`) and `manifest-<tag>.json` (`MANIFEST.json`).

   ```sh
   ./alz apply prepare --environment DEV --project <CANARY_COPY>
   ./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>
   ./alz apply preflight --environment DEV
   ```

3. `qualify` asks for the target, `RUN PROJECT CODE` and `EMBED STATE_WRITE DEV`. It applies nothing. It runs:
   - `terraform version`;
   - `init` and workspace selection, as STATE_WRITE;
   - a throwaway plan as DISCOVERY, never stored;
   - the state serial read, as STATE.

   **APPLY does not run during `qualify`.** So CloudTrail cannot show APPLY's provider access at this step. Expect to see:
   - `AssumeRoleWithWebIdentity` for STATE_WRITE, STATE and DISCOVERY;
   - S3 data events on the state and lock keys by STATE_WRITE, and possibly by STATE for the serial read;
   - no event by APPLY at all.
4. Then `qualify` prints the expected principals and asks you to type `SEPARATED <STATE_WRITE role ARN> <APPLY role ARN>`. The product cannot see CloudTrail. The phrase is your attestation, recorded as `backendIdentitySeparated`. Type it only if CloudTrail shows state access by STATE_WRITE (and STATE) only, and APPLY never touching the state.

   APPLY's provider access, and its absence from the state, first become observable at the step 5 apply. Check them there.
5. **Finish the D4 record** (`docs/act-pilot-identity-delivery.md`, section 11, steps 5 and 6):
   - The run above is the cloud-trust check: one independent STS assumption per identity, corroborated in CloudTrail. Record only non-secret identifiers.
   - After you release this delivery, run `qualify` once more with the same variables. It must be refused with `IDENTITY_NOT_CONFIGURED` before anything runs, because the delivered files are gone.

**Pass:**

- `qualify` writes its encrypted evidence and prints each adapter's evidence hash;
- `preflight` exits 0 with `"ready": true`. The financial item is advisory whatever its state (`UNVERIFIED` until `./alz cost status` has read the budget);
- the after-release `qualify` is refused with `IDENTITY_NOT_CONFIGURED`.

**Stop:**

- CloudTrail shows APPLY touching the state, or any principal you did not expect. Do not type the phrase; then nothing is written.
- `qualify` refuses, for example with `BACKEND_NOT_IN_CONTRACT`, `RESOURCE_NOT_IN_CANARY`, `PROVIDER_VERSION_NOT_REVIEWED`, or a Terraform variable validation error for `region`, `canary_name`, `owner` or `unit_tags`.
- The after-release `qualify` runs anything.

### Step 5: you review, approve and personally start the sealed canary

Run one workflow, in the terminal channel, within 30 days of step 4. You, the requester and the approver may be one person in DEV. `seal` takes the seal request. `apply` takes the apply request from the same `prepare`.

```sh
./alz apply seal --request <REQUEST.json> --manifest <MANIFEST.json> --requester <ID> --key <REQUESTER_KEY.pem>
./alz apply approve --bundle <REVIEW_BUNDLE.json> --key <APPROVER_KEY.pem> --approver <ID>
./alz apply apply --request <APPLY_REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <APPROVAL.json>
./alz apply status --sealed <SEALED_PLAN>
```

- `seal` asks for the target, `RUN PROJECT CODE` and `EMBED STATE_WRITE DEV`. It prints the artifact hash, the review bundle path and the change list.
- `approve` asks for `APPROVE DEV <first 12 characters of the artifact hash>`. The approval lasts `maxApprovalAgeMinutes` (30), so apply soon after.
- `apply` asks for one line: `APPLY DEV <first 12 characters> <account> | <backend> | <workspace>`.
- Watch CloudTrail during the apply.

**Pass:**

- the change list shows exactly one `aws_cloudwatch_log_group` with the action create, and nothing else;
- the unit shown at `seal` and `approve` carries the tags `prepare` printed;
- `apply` exits 0 with the outcome `SUCCEEDED`;
- CloudTrail shows the log group created by APPLY, the state written by STATE_WRITE, and no state access by APPLY.

**Stop:**

- **Before you approve:** the change list shows anything else, or the provenance shows `UNQUALIFIED`. Do not approve.
- **Exit 2 (BLOCKED):** nothing was spent. Read the code.
- **Exit 3 (SPENT)** with `FAILED_NO_CHANGE`, `PLAN_STALE`, `PARTIAL_REQUIRES_REVIEW` or `KILLED`. **Do not retry.** Follow "When an apply fails" in `docs/act-pilot-apply.md`. A retry is always a new seal with new approvals.
- **After the apply,** CloudTrail shows APPLY touching the state.

To stop at any point, use the kill switch: `touch .runs/apply/KILL`. See "Stop and recovery" below.

### Step 6: independent observation and approved cleanup, with a leftover check

The cleanup owner authorizes the cleanup separately, within the maximum lifetime you set. `cleanup` takes the same apply request as `apply`.

```sh
./alz apply observe --sealed <SEALED_PLAN>
./alz apply propose-cleanup --sealed <SEALED_PLAN> --requester <ID> --key <REQUESTER_KEY.pem>
./alz apply approve --bundle <PROPOSAL.json> --key <APPROVER_KEY.pem> --approver <ID>
./alz apply cleanup --proposal <PROPOSAL.json> --request <APPLY_REQUEST.json> --manifest <MANIFEST.json> --sealed <SEALED_PLAN> --approval <CLEANUP_APPROVAL.json>
./alz apply verify-cleanup --proposal <PROPOSAL.json>
./alz apply report --sealed <SEALED_PLAN> --proposal <PROPOSAL.json>
./alz apply record-live --sealed <SEALED_PLAN>
```

- `observe` reads the resource as DISCOVERY, through Cloud Control. It is read-only and repeatable.
- The cleanup approval phrase is `APPROVE CLEANUP DEV <proposal12>`. The cleanup phrase is `CLEANUP DEV <proposal12> <target>`.
- `verify-cleanup` is the leftover check.
- `record-live` asks for `LIVE DEV <first 12 characters>` and writes `config/acceptance/evidence/<cloud>-<engine>-execute-dev-<artifact>.json`. Review and commit that file.

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

### The evidence runner alternative (steps 4 to 6)

`./alz evidence` sequences steps 4 to 6 at your terminal. You still type every phrase. It journals each step under `.runs/evidence` (`docs/evidence-runner.md`). Use it instead of the manual commands of steps 4 to 6, not after them.

1. **Set up the configuration.** Run `./alz evidence init`, then fill `config/evidence-runner.json`. It is git-ignored and holds identifiers only:
   - `candidateCommit`: the 40-character commit that carries your merged contract;
   - `targetHardwareId`: this host's id;
   - `act.repository`: `realjkg/agent-private-landing-zone`;
   - `act.paths.aws-terraform`: `project` (the canary copy's absolute path), `requesterId` and, optionally, `approverId`.

   The guided stages do not read the `aws` block. Either delete it, which skips the read-only AWS stage, or fill all three of its keys: `expectedAccountId`, `region` and `qualificationStack`. A partial `aws` block fails validation. Delete the `azure` and `gcp` blocks unless you also run those read-only stages.
2. **Fill the unit tags first.** The runner runs `prepare` once. So run `./alz apply prepare --environment DEV --project <CANARY_COPY>` yourself first, copy the printed unit tags into the copy's `unit_tags`, and only then start the runner.
3. **Run the stages:**

   ```sh
   ./alz evidence run --dry-run --stage act:aws-terraform
   ./alz evidence run --stage act:aws-terraform
   ./alz evidence run --stage cleanup:aws-terraform
   ./alz evidence status
   ```

   - `act:aws-terraform` runs `contract-check`, `identity-check`, `prepare`, `qualify`, `preflight`, `seal`, `approve`, `apply` and `observe`. It passes the seal request to `qualify` and `seal`, and the apply request to `apply`. It stops, and never substitutes the other file, if the apply request is missing.
   - `cleanup:aws-terraform` runs the cleanup half through `record-live`, with the same apply request.

The pass and stop criteria of steps 4 to 6 apply unchanged.

## Stop and recovery

- **Kill switch.** `touch .runs/apply/KILL` stops `seal`, `qualify` and `apply`, and stops a running apply: Terraform gets a SIGINT, held until its first resource line, then its process group gets a SIGKILL after 60 seconds. `./alz apply status` reports the switch. Only you remove the file.
- **A state lock left behind.** A run that ends by SIGKILL cannot release its S3 lock (`<key>.tflock`), and the next seal refuses with `Error acquiring the state lock`. The procedure is "Recovering a state lock left by a SIGKILL (owner, by hand)" in `docs/act-pilot-apply.md`:
  - run as STATE_WRITE only, never APPLY;
  - read the exact lock id;
  - only then run `terraform force-unlock <LOCK_ID>`.

  The product never removes a lock. Before unlocking, the owner direction of 2026-10-29 (6508815426, item 1) also requires that:
  - the original Terraform process and any competing writer have stopped;
  - the exact backend, workspace and lock id are verified;
  - the available run and state evidence is preserved;
  - who unlocked it, and why, is recorded;
  - the state and the cloud resources are reconciled before another approved operation is prepared.

  `force-unlock` removes the lock only. It does not change infrastructure, and it does not prove that an interrupted run recovered. `-lock=false` is never used.
- **A SIGKILLed run is not recovered evidence.** Suppose the `./alz apply` process itself is killed after the engine started (SIGKILL, power loss). Its ledger entry stays `RESERVED`, and that artifact never becomes applicable again. `./alz apply record-recovery` refuses it (`RECOVERY_RECORD_UNAVAILABLE`), so it is not G5 stop-test evidence. Review the state and the resources by hand, then seal a new plan.

  Only one pair of runs can be recorded as a recovery: a run that the ledger finished as `PARTIAL_REQUIRES_REVIEW` or `KILLED`, followed by a new approved run that `SUCCEEDED`. Record it with:

  ```sh
  ./alz apply record-recovery --sealed <INTERRUPTED_SEALED_PLAN> --resumed <RESUMED_SEALED_PLAN> --target-hardware-id <HOST>
  ```

## What this run proves, and what it does not

It proves only these: the exact account, source commit, Terraform binary and provider lock, identity subjects, contract, state backend, region, resource type, and the observed canary (`docs/act-dev-1.md`, "Acceptance scope").

It does not qualify AWS CDK, any other path, QA, PROD, general AWS ACT, or production admission. The six-path release stays required.

`docs/aws-d4-qualification.md` describes a different, read-only check: the provider qualification of a controlled existing stack (`./alz qualify provider-aws`, or the evidence runner's `aws-readonly` stage). It is not part of this sequence and does not replace it.

These stay unverified until this run (`docs/act-pilot-apply.md`, "Still UNVERIFIED on real backends"):

- real IAM and token issuance;
- the AWS `s3:` condition keys;
- the state-writer separation at `terraform apply`.

## Sources

- Owner direction: #39, 6508815426 (item 5) and 6486480658 (track B).
- `config/act-pilot-contract.aws-dev.example.json`; `src/apply/contract.ts`; `src/apply/unit.ts`; `src/apply/driver.ts`; `src/apply/prepare.ts`; `src/apply/providers/aws.ts`; `src/cli/ui-channel.ts`; `src/evidence-runner/act.ts`.
- `docs/act-pilot-aws-terraform-g0.md`; `docs/act-pilot-apply.md`; `docs/act-pilot-bootstrap.md`; `docs/act-pilot-identity-delivery.md`; `docs/act-dev-1.md`; `docs/aws-d4-qualification.md`; `docs/evidence-runner.md`.
- `bootstrap/aws` (`variables.tf`, `outputs.tf`, `terraform.tfvars.example`); `qualification/aws/act-dev1-canary`.
