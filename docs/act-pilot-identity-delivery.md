# ACT pilot identity delivery: a controlled self-hosted runner (D4, option A)

**Status:** the repository side is built and tested with SYNTHETIC tokens only. **D4 is not complete.** It is complete only after the owner's own proof on the MBP (section 11). Installing the runner is not acceptance. ACT stays DISABLED, and nothing here starts an apply.

**Owner decision (2026-10-28, #39 6483841617):** option A, a controlled self-hosted runner on the MBP. No new issuer. The mechanism must deliver distinct, fresh credentials to the human-operated driver, with exact subjects, audiences, expiry handling, private token files and cleanup. It must not bypass interactive approval or broaden trust conditions, and no untrusted PR code may run on the credential-bearing runner.

**Repository parts**

| Part | File |
|---|---|
| Delivery workflow | `.github/workflows/act-identity-delivery.yml` |
| Runner-side job allowlist (the owner installs it) | `scripts/act-identity-runner-hook.sh` |
| Driver checks on delivered token files | `src/apply/token-delivery.ts`, called from `checkEngineAndIdentities` in `src/apply/driver.ts` |
| The owner's verification command | `./alz apply identity-check` (`src/cli/apply.ts`) |
| Tests | `test/apply-token-delivery.test.ts`, `test/act-identity-delivery-workflow.test.ts`, `test/act-identity-runner-hook.test.ts`, and one driver test in `test/apply-aws.test.ts` |

## 1. What the driver consumes (unchanged)

Each identity is its own federated principal. The driver reads only `ALZ_<IDENTITY>_*` variables, and it refuses static keys, client secrets on the OIDC paths, ambient sessions, the operator's own credentials, and shared token files (`src/apply/identities.ts`, `src/apply/providers/*.ts`).

| Cloud | Token file variable per identity | Other variables per identity |
|---|---|---|
| AWS | `ALZ_<ID>_AWS_WEB_IDENTITY_TOKEN_FILE` | `_AWS_ROLE_ARN`, `_AWS_REGION` |
| Azure | `ALZ_<ID>_ARM_OIDC_TOKEN_FILE` | `_ARM_CLIENT_ID`, `_ARM_TENANT_ID`, `_ARM_SUBSCRIPTION_ID`, `_ARM_USE_OIDC=true` |
| GCP | `credential_source.file` in the file named by `ALZ_<ID>_GOOGLE_APPLICATION_CREDENTIALS` | `_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`, `_GOOGLE_PROJECT`, `_GOOGLE_REGION` |

Option A changes none of this. It changes only where the token files come from, and it adds checks on them (section 5).

## 2. Paths, identities, environments and audiences

There is one protected GitHub environment per identity and per trust scope, named `act-dev-<scope>-<identity>`. A trust scope is one set of cloud principals, so a token minted for one path's role can never come from another path's environment. Both Azure paths use the same four Entra applications (`bootstrap/azure`), so they share one scope. Bicep delivers only DISCOVERY and APPLY. The table is `DELIVERY_PATHS` in `src/apply/token-delivery.ts`. The workflow carries the same table, and a test keeps the two equal.

| Path (`--path`) | Identities delivered | Environments (`act-dev-…`) | Token audience (`aud`) |
|---|---|---|---|
| `aws-terraform` | DISCOVERY, STATE, STATE_WRITE, APPLY | `aws-terraform-discovery`, `-state`, `-state-write`, `-apply` | `sts.amazonaws.com` |
| `aws-cdk` | DISCOVERY, CHANGESET, APPLY | `aws-cdk-discovery`, `-changeset`, `-apply` | `sts.amazonaws.com` |
| `azure-terraform` | DISCOVERY, STATE, STATE_WRITE, APPLY | `azure-discovery`, `-state`, `-state-write`, `-apply` | `api://AzureADTokenExchange` |
| `azure-bicep` | DISCOVERY, APPLY | `azure-discovery`, `azure-apply` (shared with Azure Terraform) | `api://AzureADTokenExchange` |
| `gcp-terraform` | DISCOVERY, STATE, STATE_WRITE, APPLY | `gcp-terraform-discovery`, `-state`, `-state-write`, `-apply` | `https:` + the pool provider name |
| `gcp-api` | DISCOVERY, APPLY | `gcp-api-discovery`, `gcp-api-apply` | `https:` + the pool provider name |

That makes 17 environments. They are all DEV. No QA or PROD environment exists for delivery.

## 3. Token flow, step by step

1. **The owner dispatches.** In GitHub, the owner runs "ACT identity delivery (DEV pilot)" on `main`, choosing a path and a hold of 15, 30, 45 or 60 minutes. Only `workflow_dispatch` starts it.
2. **The owner approves.** Each identity's job waits on its environment's required reviewer (the owner) and runs only after approval. A job that is rejected cancels the rest (`fail-fast`), and cleanup still runs.
3. **The runner admits the job.** The runner's job-started hook (section 8) refuses anything except this workflow's `deliver` and `cleanup` jobs, dispatched on `main` in the owner's repository. It does this before any step runs.
4. **The job mints a token.** With `id-token: write` and nothing else, each job asks the runner's token endpoint (`ACTIONS_ID_TOKEN_REQUEST_URL`) for one token with its cloud's audience. The request token travels in a header, never in argv or a log. Before writing anything, the job decodes the claims (without trusting them) and requires:
   - issuer GitHub Actions;
   - the exact audience;
   - a `sub` ending `:environment:<its environment>`;
   - its own environment, repository and run;
   - at least 60 seconds of validity left.
5. **The job writes the token privately.** The token goes to `<root>/<path>/<IDENTITY>.jwt`, with a metadata file `<IDENTITY>.json` beside it (no token in it). `<root>` is the owner's `ALZ_IDENTITY_DELIVERY_ROOT`. Each write goes to a new 0600 file (`O_EXCL|O_NOFOLLOW`), is synced, then renamed into place. The job refuses to start if a token, metadata file or `RELEASE` marker from an earlier delivery is still there.
6. **The job refreshes the token.** Every 60 seconds the job mints a new token and replaces the file atomically, so the file always holds a token with minutes of validity left. A refresh that fails deletes the token rather than leave it to go stale.
7. **The person runs the driver.** In their own terminal on the same host, the person points the identity variables at the session files and runs `./alz apply preflight`, `seal`, `approve`, `apply`, `observe` and the rest. The driver checks the files (section 5) at every step, and every phrase, approval, signature, ledger entry and kill switch applies unchanged. The job never runs an engine, never exchanges a token for a cloud credential, and holds nothing but its GitHub OIDC tokens.
8. **The person releases the delivery.** The person runs `touch <root>/<path>/RELEASE`, or cancels the run, or lets the hold end. Each job then deletes its own files and exits.
9. **Cleanup runs.** An always-run step deletes the job's own files even after a failure or cancellation. The `cleanup` job then removes the `RELEASE` marker and the session directory. If the directory holds anything the workflow did not write, the job names it, leaves it in place, and fails.

## 4. Subjects and audiences against the committed bootstraps

| Cloud | Committed trust (`bootstrap/*`) | Delivery token | Broadened? |
|---|---|---|---|
| AWS | One role per identity. Trust: `sts:AssumeRoleWithWebIdentity` from the account's OIDC provider for `token.actions.githubusercontent.com`, `StringEquals` on `:aud` = `oidc_audience` (default `sts.amazonaws.com`) and on `:sub` = that identity's single `oidc_subjects` value. Subjects must be distinct (`bootstrap/aws/main.tf`, `variables.tf`). | Issuer GitHub Actions, `aud` `sts.amazonaws.com`, `sub` bound to the identity's environment. | No. Exact match, no wildcard, no `StringLike`. |
| Azure | One application per identity, one federated credential per identity and environment: `issuer` `https://token.actions.githubusercontent.com`, `audiences` `[api://AzureADTokenExchange]`, `subject` = that identity's subject. Four distinct subjects per environment (`bootstrap/azure/identities.tf`, `variables.tf`). | Same issuer, `aud` `api://AzureADTokenExchange`, `sub` bound to `act-dev-azure-<identity>`. | No. Federated credentials match exactly. |
| GCP | One pool and one OIDC provider per project and engine. Its `attribute_condition` admits only `assertion.sub in [the engine's subjects]` plus optional exact `oidc_required_claims`. Each service account grants `roles/iam.workloadIdentityUser` to exactly one `principal://…/subject/<subject>`. `allowed_audiences` is empty by default, which means the provider's own resource name (`bootstrap/gcp/main.tf`, `variables.tf`). | Issuer GitHub Actions, `aud` `https://iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/<pool>/providers/oidc`, `sub` bound to the identity's environment. | No. The owner should also set `oidc_required_claims` to the numeric `repository_id` and `repository_owner_id` (recommended, a narrowing). |

**The exact `sub` string.** It is **observed, not assumed** (`docs/act-dev-1.md`). GitHub's default for an environment job is `repo:<owner>/<repo>:environment:<name>`, and newer repositories can use an immutable form with owner and repository ids. The product requires only that the subject:

- starts with `repo:`;
- ends with `:environment:<the identity's environment>`;
- has no wildcard;
- has the same repository part in every identity.

The owner copies the exact observed subject of each identity from `./alz apply identity-check` (section 11) into `oidc_subjects` in the bootstrap. No trust condition is changed by this lane, and no bootstrap file is edited.

**The audience.** It is fixed per cloud and equal to the bootstrap default. An owner who overrides `oidc_audience` in a bootstrap would be refused by the driver, so the override cannot be used without a reviewed change here. For GCP, the environment variable `ALZ_GCP_WIF_AUDIENCE` on each GCP environment holds the bootstrap output `workload_identity_audience` (`//iam.googleapis.com/…`). The token carries it with the `https:` prefix, and the driver requires exactly that against the credential configuration's own `audience`.

## 5. What the driver checks on delivered files

A token file is *delivered* when it is named `<IDENTITY>.jwt` and sits in a directory named for the path, or beside its metadata file. A delivered layout whose files are gone is refused, not passed on. Files that are not laid out this way are left to the existing provider checks, unchanged. When any identity of the path is delivered, `checkDeliveredTokens` requires all of the following at seal, qualify, apply and cleanup, and refuses with `IDENTITY_NOT_CONFIGURED` or `IDENTITY_COLLAPSED`. Messages never contain a token.

- **One run.** Every identity of the path is delivered, by one run, into one session directory `<root>/<path>`. A partial or mixed delivery is refused.
- **Private.**
  - Each token and metadata file is a regular file of this user: not a symbolic link, mode 0600 or tighter, and exactly one link.
  - The session directory and `<root>` are this user's directories: mode 0700 or tighter, not symbolic links, and their own real paths.
  - The session directory is outside the product checkout.
- **Exact.** The metadata names this path, identity, environment and audience, with a valid schema. The token's claims match:
  - `iss` and `aud`;
  - `sub` ending with the identity's environment, and `environment`;
  - `repository`;
  - `event_name` = `workflow_dispatch`, `ref` = `refs/heads/main`;
  - `workflow_ref` = this workflow on main;
  - `runner_environment` = `self-hosted`;
  - `run_id`.
- **Fresh.**
  - `exp` is at least 60 seconds away. There is no grace period, and a token is never extended.
  - `iat` and `nbf` are not in the future (60 seconds of skew).
  - The job refreshed the metadata within two refresh intervals plus skew (180 seconds); a stopped job's files are stale.
  - The hold has not ended.
- **Distinct.** No two identities share a token, a subject or a token id (`jti`). The existing checks already refuse a shared path, symbolic link or hard link.

**Where expiry is checked.** These checks run when each step starts. A step that started with a valid token keeps the cloud session it obtained: an STS session of up to one hour, or an Entra or Google access token. The job keeps the file fresh for anything the engine re-reads later.

## 6. Private token files

- **Where they live.** `<root>` is a directory the owner creates once, for example `mkdir -m 700 ~/.alz-identity`. It sits on the runner user's own disk: never under the repository, the runner's work directory, a synced folder or a temporary directory shared with others. Each path's files live in `<root>/<path>`, mode 0700.
- **Which user.** The runner and the person at the terminal run as the same dedicated macOS user (section 10, item 2). The files are 0600 and owned by that user, so no other user can read them, and the driver refuses anything looser.
- **Where tokens never go.** No token is put in argv, a log, a job output, `GITHUB_ENV`, the step summary, an artifact, a cache or the repository. The job log prints names, subjects and times only. A test asserts this for the workflow's own scripts.

## 7. Cleanup

| Situation | What removes the files |
|---|---|
| The person releases, or the hold ends | The job deletes its token and metadata and exits 0. The `cleanup` job removes `RELEASE` and the directory. |
| A mint or refresh fails | The job deletes its files and exits 1. The always-run step and the `cleanup` job follow. |
| Canceled or interrupted (SIGINT, SIGTERM, SIGHUP) | The job's signal handler deletes its files. The always-run step and the `cleanup` job follow. |
| The job process is killed outright | The always-run step deletes the job's own files, including partial writes. The `cleanup` job removes the directory. |
| The runner host dies mid-delivery | The files stay until the next delivery refuses to start over them. The tokens expire within minutes, and the driver refuses them as stale or expired. The owner removes the files, or runs the `cleanup` job, and confirms with `--phase cleaned`. |
| An unexpected file in the session directory | The `cleanup` job leaves it, names it and fails. The owner reviews it. |

## 8. No untrusted code on the credential-bearing runner

The repository belongs to a user account and is public. **Failed assumption:** the coordinator's analysis suggested a repository runner group restricted to this workflow. Runner groups, and their "selected workflows" restriction, exist only for organizations and enterprises, not for a user-owned repository. Option A meets the requirement with the controls below instead. The first is structural and sits on the runner host, where pull request code cannot change it.

1. **The runner's job-started hook** (`scripts/act-identity-runner-hook.sh`). The owner installs a copy outside any checkout and sets `ACTIONS_RUNNER_HOOK_JOB_STARTED` in the runner's `.env`. It runs before any step of every job the runner takes, and it fails the job unless all of these hold:
   - the repository is the owner's;
   - the event is `workflow_dispatch`;
   - the ref is `refs/heads/main`;
   - `GITHUB_WORKFLOW_REF` is this workflow on main;
   - the job is `deliver` or `cleanup`;
   - the event payload says the same.

   A pull request that names the runner's label is refused before its first step, including a fork, a branch push, `pull_request_target` or `issue_comment`.
2. **The workflow's triggers.** It has only `workflow_dispatch`. Both jobs also check `github.event_name` and `github.ref`. A test asserts that no other trigger exists.
3. **Each environment's deployment branch policy** is `main` only. A dispatch from another branch cannot enter an environment, so it gets no environment subject. The required reviewer approves each run.
4. **A dedicated runner label** (`alz-identity-delivery`). No other workflow names it, which a test checks. It is used only by this workflow.
5. **No checkout and no action.** The jobs run only the reviewed scripts in the workflow file, so no third-party or repository code runs on the runner, and there is nothing to pin. A test asserts that any `uses:` line would be pinned to a commit SHA.
6. **The runner is online only for the delivery window.** The owner starts it by hand, not as a login service, and stops it after cleanup.
7. **Fork pull request workflows require approval** for all outside collaborators.

## 9. Threat analysis

| Threat | Control | Residual risk |
|---|---|---|
| A fork or branch PR runs code on the runner by naming its label | The hook (8.1) refuses the job before any step. Fork approval (8.7). The runner is offline outside the window (8.6). | The hook is a reviewed copy on the host; its behavior is proven by the owner's negative test (section 11, step 7). |
| A modified workflow on a branch is dispatched to mint an environment token | The environment's branch policy is `main` only. The required reviewer. The hook refuses non-main refs. The driver refuses tokens whose `ref` or `workflow_ref` is not main. | Anyone who can merge to `main` can change the workflow. Main's review and the pending `release-freeze-main` ruleset govern that. |
| A token for identity A is used as identity B | Each cloud trusts exactly one subject per principal. The driver binds file name, metadata, `sub`, `environment` and audience per identity, and refuses the same token, subject or `jti` twice. | None known. |
| A stale or expired token is used | The 60-second validity floor, a heartbeat within 180 seconds, and the hold window. Nothing is extended. | A step that runs longer than its cloud session (one hour) fails rather than continue on an old token. |
| A token leaks through a log, artifact, output or argv | Header-only use of the request token. Private files. No outputs, artifacts, caches or summaries. Tests check the scripts' output. | The same-uid user is inside the trust boundary (`src/apply/identities.ts`). |
| Another local user or process reads the token | 0600 files in 0700 directories, owned by a dedicated macOS user. The driver refuses anything looser. | Root on the MBP, and any process of the dedicated user. |
| An agent process on the MBP reads the token | The dedicated macOS user runs the runner and the driver, and no agent session runs as that user (section 10, item 2). | It is an operational rule; the owner keeps it. |
| The runner job performs the apply instead of the person | The jobs have no engine, no checkout and no cloud exchange. The apply keeps its human-terminal requirement, phrases, approvals and ledger (`src/cli/apply.ts`, `test/apply-boundary.test.ts`). | None known. |
| Trust is widened to make it work | No bootstrap change. Exact `StringEquals`, exact federated credentials and an exact attribute condition. The driver pins the bootstrap default audience. | None known. |
| A leftover token after a crash | The job refuses to start over leftovers. The always-run step and the cleanup job. The driver refuses stale files. `--phase cleaned` confirms. | Files on a dead host remain until the owner cleans them; they expire within minutes. |

## 10. The owner's settings checklist

Agents cannot apply any of these, and none has been applied. Each item is the owner's.

1. **Runner host.** On the MBP, create a dedicated standard macOS user (for example `alzpilot`). Install Node 26 and the pilot's engines for that user. Create `<root>` with `mkdir -m 700 ~/.alz-identity`.
2. **No other software as that user.** Run no agent session, IDE extension, sync client or other automation as that user. The person runs the driver from a terminal logged in as that user.
3. **Register the runner.**
   - Register it at **repository** scope only: Settings → Actions → Runners → New self-hosted runner, for macOS.
   - Use four runner instances, one directory each. Each delivery job holds a runner for the whole window, so a four-identity path needs four. Name them `alz-identity-1` to `alz-identity-4`.
   - Give each instance exactly the custom label `alz-identity-delivery`, in addition to the defaults.
   - Do **not** install them as a launch service. Start them with `./run.sh` for a delivery and stop them after cleanup.
4. **Install the hook.** In each runner directory's `.env`, set these three variables, then restart the runner:
   - `ACTIONS_RUNNER_HOOK_JOB_STARTED=/Users/alzpilot/.alz-runner-hook/act-identity-runner-hook.sh` (a reviewed copy of `scripts/act-identity-runner-hook.sh`, owned by that user, mode 0700, outside every checkout);
   - `ALZ_IDENTITY_RUNNER_REPOSITORY=realjkg/agent-private-landing-zone`;
   - `ALZ_IDENTITY_DELIVERY_ROOT=/Users/alzpilot/.alz-identity`.
5. **Create the environments.** Create the 17 environments of section 2, only for the paths about to be proven. For each:
   - **Required reviewers:** the owner. Leave "Prevent self-review" off, because the owner is also the person who dispatches.
   - **Deployment branches and tags:** selected branches, `main` only. No tags.
   - **No secrets.** For the GCP environments only, the variable `ALZ_GCP_WIF_AUDIENCE` = the bootstrap output `workload_identity_audience`.
6. **Fork pull requests.** Settings → Actions → General → "Fork pull request workflows from outside collaborators": "Require approval for all outside collaborators".
7. **Subject claim template.** Keep the repository's OIDC subject claim template at its current setting during the pilot. Read the observed `sub` values from `identity-check` and put them in the bootstraps' `oidc_subjects`. Do not hand-write them.
8. **Main ruleset.** Apply the approved `release-freeze-main` ruleset (#39, 6460847660) so a change to this workflow or the hook script needs review. This is still pending, per 6483841617.
9. **GCP bootstrap.** Set `token_files` to `<root>/<path>/<IDENTITY>.jwt`, and `oidc_required_claims` to the repository's numeric `repository_id` and `repository_owner_id`.

## 11. The owner's proof (D4 acceptance), on the MBP

Labels:

- SYNTHETIC: this repository's tests.
- HOST_LOCAL: steps 2 to 4 and 7. They are observations on the MBP, not provider evidence.
- LIVE: steps 5 and 6 only.

1. Complete the checklist (section 10). Start the four runner instances.
2. **Deliver.** Dispatch the workflow on `main` for one path, with a 15-minute hold, and approve its environments.
3. **Check what was delivered.** As the dedicated user, export the identity variables pointing at `<root>/<path>/<IDENTITY>.jwt` (for GCP, at the credential configurations naming them). Then run:

   ```sh
   ./alz apply identity-check --path <path> --repository realjkg/agent-private-landing-zone --phase delivered
   ```

   Exit 0 means every identity has its own private, fresh token with the exact environment-bound subject and audience. The HOST_LOCAL record is written under `.runs/apply/identity-delivery/`. Keep it; it holds no token. Record the observed `sub` values for the bootstraps.
4. **Release and check that nothing is left.** Run `touch <root>/<path>/RELEASE`, wait for the run to finish (cleanup included), then run:

   ```sh
   ./alz apply identity-check --path <path> --repository realjkg/agent-private-landing-zone --phase cleaned
   ```

   Exit 0 means no token, metadata or session directory remains.
5. **Cloud trust (LIVE, after the bootstrap uses the observed subjects).** Deliver again, then run `./alz apply preflight --environment DEV` and the path's own read-only qualification (`./alz apply qualify`). That gives one independent STS assumption, or Entra or Google STS sign-in, per identity. Corroborate with CloudTrail or the sign-in logs. Record only non-secret identifiers. This is the evidence the coordinator's analysis lists (6467511299).
6. **Expiry (LIVE).** In one delivery, record two consecutive `identity-check` runs at least two minutes apart: the fingerprints change and `secondsRemaining` stays above 60. After the release, run `./alz apply qualify` (or `seal`) again with the same variables and confirm it is refused with `IDENTITY_NOT_CONFIGURED` before anything runs, because the delivered files are gone.
7. **Negative test of the hook (HOST_LOCAL).** From a throwaway branch that is never merged, dispatch any workflow whose job targets `runs-on: [self-hosted, alz-identity-delivery]`. The job must fail at "Set up runner" with `ALZ_IDENTITY_RUNNER_REFUSED`, before any step. Delete the branch.

D4 is complete when the owner records steps 3 to 7 on #39 and accepts them.

## 12. Unverified assumptions

The owner's proof settles each of these. Every one fails closed if it is wrong.

| Assumption | If it is wrong |
|---|---|
| A GitHub OIDC token lives for a few minutes, so a 60-second refresh keeps it fresh. GitHub's documented example shows five minutes. | A shorter life makes the job refuse to write the token (less than 60 seconds left), or makes the driver refuse it. Nothing runs on an expired token. |
| The job's request token stays valid for the whole job, so re-minting keeps working. | The refresh fails, the job deletes its token and exits 1, and the driver refuses the stale delivery. |
| The job-started hook runs before any step and fails the job on a non-zero exit, with GitHub's default variables and event payload. Step 7 of the proof tests this. | If it does not, the runner must not be used. The smallest fallback is to keep the runner offline except while the owner's own dispatch is queued, and to treat any other job on it as an incident. |
| GitHub's environment `sub` ends with `:environment:<name>` in both the default and the immutable formats. | The job and the driver refuse the token, and nothing is delivered. |
| Google accepts the `https:`-prefixed provider name as the token audience when `allowed_audiences` is empty. | The exchange fails at step 5 and nothing is delegated. Set `oidc_allowed_audiences` to that exact value in a reviewed bootstrap change; that is an exact value, not a broadening. |
