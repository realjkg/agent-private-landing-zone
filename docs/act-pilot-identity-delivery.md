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
4. **The job mints a token.** First, the job checks that its runner instance runs the reviewed hook, by SHA-256, configured for this repository and this instance (section 8.1). Then, with `id-token: write` and nothing else, each job asks the runner's token endpoint (`ACTIONS_ID_TOKEN_REQUEST_URL`) for one token with its cloud's audience. The request token travels in a header, never in argv or a log. Before writing anything, the job decodes the claims (without trusting them) and requires:
   - issuer GitHub Actions;
   - the exact audience;
   - a `sub` ending `:environment:<its environment>`;
   - its own environment, repository and run;
   - at least 60 seconds of validity left.
5. **The job writes the token privately.** The token goes to `<root>/<path>/<IDENTITY>.jwt`, with a metadata file `<IDENTITY>.json` beside it (no token in it). `<root>` is the owner's `ALZ_IDENTITY_DELIVERY_ROOT`. Each write goes to a new 0600 file (`O_EXCL|O_NOFOLLOW`), is synced, then renamed into place. The job refuses to start if a token, metadata file or `RELEASE` marker from an earlier delivery is still there.
6. **The job refreshes the token.** Every 60 seconds the job mints a new token and replaces the file atomically, so the file always holds a token with minutes of validity left. A refresh that fails deletes the token rather than leave it to go stale.
7. **The person runs the driver.** In their own terminal on the same host, the person points the identity variables at the session files and runs `./alz apply preflight`, `seal`, `approve`, `apply`, `observe` and the rest. Every step that uses a delivered identity checks the files (section 5), and every phrase, approval, signature, ledger entry and kill switch applies unchanged. The job never runs an engine, never exchanges a token for a cloud credential, and holds nothing but its GitHub OIDC tokens.
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

A token file is *delivered* when it is named `<IDENTITY>.jwt` and sits in a directory named for the path, or beside its metadata file. A delivered layout whose files are gone is refused, not passed on. Files that are not laid out this way are left to the existing provider checks, unchanged. When any identity of the path is delivered, `checkDeliveredTokens` requires all of the following, and refuses with `IDENTITY_NOT_CONFIGURED` or `IDENTITY_COLLAPSED`. Messages never contain a token.

**Where the checks run.** Every step that uses a delivered identity runs them:

- `seal`, `qualify`, `apply` and `cleanup`, through `checkEngineAndIdentities` in the driver;
- `preflight`, as part of its identities item;
- `observe` and `verify-cleanup`, which read the cloud as DISCOVERY.

Steps that read no token do not run them, so a released delivery does not block them:

- `approve`, `status` and `report` read only signed records and evidence;
- `propose-cleanup` builds from the run's records and reads only role ARNs, never a token file;
- `prepare` and `contract-check` read no identity.

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

1. **The runner's job-started hook** (`scripts/act-identity-runner-hook.sh`). For each runner instance, the owner installs a copy outside the runner directory and every checkout, with an owner-only file `act-identity-runner-hook.conf` beside it. The instance's `.env` names the copy as `ACTIONS_RUNNER_HOOK_JOB_STARTED`. The hook runs before any step of every job the instance takes. It fails the job unless all of these hold:
   - the job is `deliver` or `cleanup`;
   - the event is `workflow_dispatch`;
   - the ref is `refs/heads/main`;
   - the workflow is this one on main;
   - the repository is the one the configuration names.

   A pull request that names the runner's labels is refused before its first step, including a fork, a branch push, `pull_request_target` or `issue_comment`.

   **Where each value comes from.** No decision rests on a value a job could set alone:

   | Value | Source | Can a job set it? |
   |---|---|---|
   | The allowed repository, the instance's work directory, the Node binary | The owner-only `act-identity-runner-hook.conf` beside the hook (located from the hook's own path, `BASH_SOURCE`) | No |
   | The ref, the workflow file and the repository of the run | The event payload the runner wrote at `<RUNNER_WORK>/_temp/_github_workflow/event.json`, a fixed path from the configuration. `GITHUB_EVENT_PATH` is ignored, except that it must equal that path when set. | No; the hook runs before any step |
   | That the payload is a dispatch | The payload's shape: a string `workflow`, an object `inputs` and a `ref` | No |
   | The job id, and agreeing copies of the event, ref, workflow ref and repository | `GITHUB_JOB`, `GITHUB_EVENT_NAME`, `GITHUB_REF`, `GITHUB_WORKFLOW_REF`, `GITHUB_REPOSITORY` | Possibly, if a job's `env:` reaches the hook. They can only add refusals: the payload must agree. The job id alone comes from here, and every admitted job is one of this reviewed workflow's two. |

   **Hardening.** The hook:
   - calls no builtin or outside function by name. It uses only keywords (`[[ ]]`, `if`), expansions, assignments, its own function and programs by absolute path. An exported function in the environment (`BASH_FUNC_<name>%%`, which bash looks up before builtins) therefore cannot replace anything it calls. A test overrides `unset`, `exit`, `set`, `printf`, `read`, `[`, `test`, `env`, `find`, `false`, `command`, `builtin` and `true`, and the hook still refuses a branch payload;
   - checks, in bash, that the configuration is owner-only, and that the `NODE` binary is owned by root or the runner user and not writable by group or others, **before** it runs that binary (review N8). Node checks both again;
   - judges everything with that Node binary under `env -i` as its last command, so no job-provided variable (`NODE_OPTIONS`, `NODE_PATH` and the rest) reaches the judge, and the judge's verdict is the hook's exit status;
   - pins `PATH`, `IFS` and `LC_ALL=C`;
   - is portable to Apple bash 3.2 and BSD userland: the bash part has no counted regex repetition (BSD's `RE_DUP_MAX` is 255; the `NODE` path's length is checked separately), no `\d`, `\w` or `\s`, and only an unquoted variable on the right of `=~`. `/usr/bin/find` uses only POSIX `-H`, `-prune`, `-perm -mode`, `-user`, `-o` and `-print`. `printf` and `env` take no GNU-only flag. A static test pins all of this;
   - refuses anything unexpected: a missing, open, repeated or unknown configuration line, a symbolic link, or an unreadable payload.

   **The class it cannot defend, and how a leak is made visible.** Bash acts on four variables before the first line of any script runs:
   - `BASH_ENV` is expanded and sourced, so `BASH_ENV='$(…)'` runs code with no file at all;
   - `ENV` does the same in POSIX mode;
   - `SHELLOPTS` and `BASHOPTS` set options. `SHELLOPTS=noexec` makes bash read the hook without running it and exit 0, which admits the job; this was checked with bash 5.2;
   - `PS4` with `xtrace`: `SHELLOPTS=xtrace` and a `PS4` holding a command substitution run that command before every traced line. Bash 4.4 and later ignore an inherited `PS4` only when running as root, and the runner user is not root;
   - exported functions are imported as functions. GNU bash names them `BASH_FUNC_<name>%%`; Apple's patched bash 3.2 names them `__BASH_FUNC<<name>>%%`. The hook calls none of them, but any program it ran through bash could;
   - `DYLD_*` (macOS) and `LD_PRELOAD` (Linux) load code into an unprotected bash. On macOS, System Integrity Protection strips `DYLD_*` when a protected binary such as `/bin/bash` or `/usr/bin/env` starts, but not for a Homebrew bash. `env -i` protects only the Node judge, not the bash that runs the hook.

   **Which bash runs the hook.** The runner starts a `.sh` hook with the `bash` it finds on its `PATH`. As far as can be determined offline, on the MBP that is Apple's `/bin/bash` 3.2, unless a Homebrew bash (`/opt/homebrew/bin/bash`, 5.x) comes first on the runner's `PATH`. The hook prints the bash version in its admitted or refused line (`hook ran under bash …`), so the owner reads it from the job's "Set up runner" log. The hook is written for both (the portability item above), and the proof in section 11, step 7 covers both exported-function formats.

   **If a job's environment reaches the job-started hook, this whole class is a full bypass, and no script can prevent it.** The hook's first check makes a leak visible: if `ALZ_HOOK_ENV_CANARY`, `BASH_ENV` or `ENV` is set, it refuses with the distinct code `ALZ_IDENTITY_HOOK_ENV_LEAK`. The owner's proof (section 11, step 7) sets the canary, a `BASH_ENV` marker and function overrides on every instance, so a leak cannot pass unseen. If it ever shows a leak, option A as designed fails the owner's requirement that no untrusted PR code runs on the credential-bearing runner. Section 12 gives the smallest alternative.

   **The delivery job checks the hook.** Before minting anything, the delivery job refuses unless all of these hold:
   - `ACTIONS_RUNNER_HOOK_JOB_STARTED` names an owner-only regular file whose SHA-256 equals the reviewed script's hash, which is pinned in the workflow as `ALZ_RUNNER_HOOK_SHA256` (a test keeps the two equal);
   - the configuration beside it names this repository;
   - the configuration names this instance's own work directory: `GITHUB_EVENT_PATH` must be under it.

   A hook-less or misconfigured instance therefore never receives a token. It could still run another job, which is why section 11, step 7 runs on every instance.
2. **The workflow's triggers.** It has only `workflow_dispatch`. Both jobs also check `github.event_name` and `github.ref`. A test asserts that no other trigger exists.
3. **Each environment's deployment branch policy** is `main` only. A dispatch from another branch cannot enter an environment, so it gets no environment subject. The required reviewer approves each run.
4. **A dedicated runner label** (`alz-identity-delivery`). No other workflow names it, and a test checks that no workflow in the repository has a self-hosted job whose labels all match a delivery runner (`self-hosted`, `macOS`, `ARM64`, `X64` or this label). This is weaker than it sounds (review N6): a workflow on a branch can name `runs-on: self-hosted` and match these runners. The hook (8.1) is the control; the label only keeps the repository's own workflows off these runners.
5. **No checkout and no action.** The jobs run only the reviewed scripts in the workflow file, so no third-party or repository code runs on the runner, and there is nothing to pin. A test asserts that any `uses:` line would be pinned to a commit SHA.
6. **The runner is online only for the delivery window.** The owner starts it by hand, not as a login service, and stops it after cleanup.
7. **Fork pull request workflows require approval** for all outside collaborators.

## 9. Threat analysis

| Threat | Control | Residual risk |
|---|---|---|
| A fork or branch PR runs code on the runner by naming its label, or just `self-hosted` | The hook (8.1) refuses the job before any step, deciding from its owner-only configuration and the runner's payload. Fork approval (8.7). The runner is offline outside the window (8.6). | One instance without the hook would run anything. The delivery job refuses to deliver on such an instance, but it cannot stop another job there. The owner's negative test runs on every instance (section 11, step 7). |
| A job's own `env:` steers the hook (`NODE_OPTIONS`, `GITHUB_*`, `BASH_FUNC_*%%`) | The hook ignores job-settable values for every decision. It calls no builtin by name, and runs Node under `env -i` with an absolute, owner-checked binary as its last command. Tests reproduce the `NODE_OPTIONS` and `BASH_FUNC_unset%%` probes and show both refuse. | If job environment reaches the hook, `BASH_ENV`, `ENV`, `SHELLOPTS` (for example `noexec`, or `xtrace` with `PS4`), `BASHOPTS`, exported functions in either format, and `DYLD_*`/`LD_PRELOAD` on an unprotected bash act before any line runs: a **full bypass**. The hook's canary check (`ALZ_IDENTITY_HOOK_ENV_LEAK`) and section 11, step 7 make that visible on every instance. If it is seen, option A fails, and section 12 gives the fallback. |
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
4. **Install the hook, once per instance.** For instance `N`:
   - Copy the reviewed `scripts/act-identity-runner-hook.sh` to `/Users/alzpilot/.alz-runner-hook/N/act-identity-runner-hook.sh`. The copy is owned by that user, mode 0700, and sits outside the runner directory and every checkout. Its SHA-256 must equal `ALZ_RUNNER_HOOK_SHA256` in the workflow.
   - Beside it, write `act-identity-runner-hook.conf`, mode 0600, with exactly three lines:
     - `REPOSITORY=realjkg/agent-private-landing-zone`
     - `RUNNER_WORK=<that instance's _work directory, absolute>`
     - `NODE=<absolute path of Node 26>`. The binary must be owned by root or that user and not writable by group or others; the hook refuses it otherwise.
   - In that instance's `.env`, set two variables, then restart the instance:
     - `ACTIONS_RUNNER_HOOK_JOB_STARTED=<the copy's path>`
     - `ALZ_IDENTITY_DELIVERY_ROOT=/Users/alzpilot/.alz-identity`
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
7. **Negative test of the hook, on every instance (HOST_LOCAL).** Start **one** instance at a time, so the job can only land there, and record that runner's name from the job log.
   - **Setup.** On a throwaway branch that is never merged, add a probe workflow with two jobs:
     - one with `runs-on: [self-hosted, alz-identity-delivery]`;
     - one with only `runs-on: self-hosted`.
   - **Overrides.** Give both jobs a job-level `env:` that sets all of these. `<N>` is the instance number.
     - `ALZ_HOOK_ENV_CANARY: instance-<N>`: the canary;
     - `BASH_ENV: '$(touch /tmp/alz-hook-env-reached-<N>)'`: an observable marker that needs no file;
     - `BASH_FUNC_unset%%: '() { builtin exit 0; }'` and `BASH_FUNC_exit%%: '() { builtin exit 0; }'` (GNU bash's format), plus `'__BASH_FUNC<unset>%%': '() { builtin exit 0; }'` and `'__BASH_FUNC<exit>%%': '() { builtin exit 0; }'` (Apple bash 3.2's format): these would make an exposed hook exit 0 if they were honored;
     - `SHELLOPTS: xtrace` and `PS4: '$(touch /tmp/alz-hook-env-reached-<N>)'`;
     - `GITHUB_EVENT_NAME: workflow_dispatch`, `GITHUB_REF: refs/heads/main`, `GITHUB_WORKFLOW_REF: realjkg/agent-private-landing-zone/.github/workflows/act-identity-delivery.yml@refs/heads/main`, `GITHUB_EVENT_PATH: /tmp/forged.json`;
     - `NODE_OPTIONS: --require=/tmp/forged.js`.
   - **Marker.** Each job's only step writes `/tmp/alz-hook-step-ran-<N>`.
   - **Run.** Dispatch the probe from that branch.
   - **Pass, for each instance:**
     - both jobs fail at "Set up runner" with `ALZ_IDENTITY_RUNNER_REFUSED`;
     - the log never shows `ALZ_IDENTITY_HOOK_ENV_LEAK`;
     - neither `/tmp/alz-hook-env-reached-<N>` nor `/tmp/alz-hook-step-ran-<N>` exists on the MBP;
     - no step ran.

   Repeat for each of the four instances, then delete the branch. Record each runner's name, the refusal line and the absence of both markers.
   - **If `ALZ_IDENTITY_HOOK_ENV_LEAK` appears, or the `env-reached` marker exists,** job environment reaches the hook. Option A as designed then fails the "no untrusted PR code" requirement. Do not deliver tokens; use the fallback in section 12.
   - **If a step ran,** that instance has no working hook and must not be used.

D4 is complete when the owner records steps 3 to 7 on #39 and accepts them.

## 12. Unverified assumptions

The owner's proof settles each of these. Every one fails closed if it is wrong.

| Assumption | If it is wrong |
|---|---|
| A GitHub OIDC token lives for a few minutes, so a 60-second refresh keeps it fresh. GitHub's documented example shows five minutes. | A shorter life makes the job refuse to write the token (less than 60 seconds left), or makes the driver refuse it. Nothing runs on an expired token. |
| The job's request token stays valid for the whole job, so re-minting keeps working. | The refresh fails, the job deletes its token and exits 1, and the driver refuses the stale delivery. |
| The job-started hook runs before any step and fails the job on a non-zero exit, and the runner has written the event payload at `<RUNNER_WORK>/_temp/_github_workflow/event.json` by then. Step 7 of the proof tests this on every instance. | The runner must not be used for delivery. |
| **A job's `env:` does not reach the job-started hook.** If it did, `BASH_ENV`, `ENV`, `SHELLOPTS`/`BASHOPTS` (including `xtrace` with `PS4`), exported functions (`BASH_FUNC_*%%`, or `__BASH_FUNC<*>%%` on Apple bash 3.2), and `DYLD_*`/`LD_PRELOAD` on a bash that System Integrity Protection does not cover would act before the hook's first line: a full bypass. Step 7's canary, `BASH_ENV` marker and function overrides make it observable on every instance. | **Option A as designed then fails the "no untrusted PR code" requirement.** The smallest alternative needs no new issuer and no new mechanism, just a narrower window. Run each instance as an **ephemeral** runner (`config.sh --ephemeral`, re-registered by the owner for each delivery), started only after the owner's own dispatch is queued and approved, and only once the owner has confirmed in Actions that no other job is queued for a self-hosted runner. Each instance takes exactly one job and deregisters. The owner checks in each run log that the one job it took was a `deliver` or `cleanup` job of this run. Any other job on it is an incident: its tokens are discarded, nothing is applied, and the instance is wiped. |
| GitHub's environment `sub` ends with `:environment:<name>` in both the default and the immutable formats. | The job and the driver refuse the token, and nothing is delivered. |
| Google accepts the `https:`-prefixed provider name as the token audience when `allowed_audiences` is empty. | The exchange fails at step 5 and nothing is delegated. Set `oidc_allowed_audiences` to that exact value in a reviewed bootstrap change; that is an exact value, not a broadening. |

## 13. Stated limits (review 6484800474)

- **N1. The driver checks are a guard against mistakes, not a security control.** They apply by file layout. A token copied out of `<root>/<path>/<IDENTITY>.jwt` without its metadata is not a delivered file, and goes to the provider checks without the freshness and claim checks. That is inside the same-user trust boundary. The cloud still enforces expiry and trust.
- **N2. Claims are decoded without verifying the signature.** An `alg:none` token, or one with duplicate JSON keys (the last wins), passes the decoding. Every decision the driver takes on these claims can only refuse; none widens authority. The cloud's signature check is the control.
- **N5. Check and use are not atomic.** After `lstat` judges a file, it is opened by path without `O_NOFOLLOW`, so a symbolic link swapped in between could be read. Only the same user can do that, which is inside the trust boundary.
- **N7. Facts the owner verifies.** None could be checked offline. The behavior if each is wrong is in section 12. The owner verifies:
  - that a deployment branch policy of `main` only stops a job from another branch from getting an environment subject (the owner sees a branch dispatch wait or fail at its environment);
  - that the job-started hook runs before any step, and before any container initialization, and that a non-zero exit fails the job (section 11, step 7);
  - the OIDC token lifetime and the immutable `sub` format (section 11, steps 3 and 6);
  - that Google accepts the `https:`-prefixed provider name when `allowed_audiences` is empty (section 11, step 5).
