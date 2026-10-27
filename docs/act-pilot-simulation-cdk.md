# Pilot apply: CDK / CloudFormation emulated simulation

**SYNTHETIC / EMULATED. This is not G2, not live provider qualification and not release approval.**

Status: run on 2026-10-27 in a Linux sandbox, for path 2 of the narrow ACT-DEV release (AWS CDK / CloudFormation, `docs/act-dev-paths.md`, item C2). It runs the **real pinned AWS CLI v2** against a **local moto server** (CloudFormation, STS, the tagging API and the logs backend). No AWS account, role, token or service was used, and nothing was paid. ACT stays DISABLED. It checks the facts `src/apply/engines/cdk.ts` marks UNVERIFIED, as far as an emulator can. Everything moto cannot show stays for the live, owner-supervised DEV run (G2).

## What was run

| Item | Value |
| --- | --- |
| AWS CLI | 2.38.6 (the `awsCli` pin in `config/tool-pins.json`), `awscli-exe-linux-x86_64-2.38.6.zip` from `awscli.amazonaws.com` |
| Zip sha256 | `66974301c11f8116a6cb96bf72acae57453734b61fa8dd3f56422de9eaab0e42`. The `.sig` verified as a good signature from the AWS CLI Team key `FB5D B77F D5C1 18B8 0511 ADA8 A631 0ACC 4672 475C`. The key copy fetched from keyserver.ubuntu.com is marked expired. |
| `dist/aws` sha256 | `20568b01e21b5bb6cde2e73cdfef134900a8f8f741c3ec5edbb96fde872b9b5a` |
| moto | 5.2.4 (`moto[server,cloudformation]`: Werkzeug 3.1.9, boto3 and botocore 1.43.119, cfn-lint 1.58.0), installed from PyPI into a scratch virtual environment |
| Python / Node | 3.13.16 / 26.11.1 |

## How to run it

The test is skipped unless both variables are set, so default CI is unaffected. Everything here is **DEV MODE ONLY**. Operators use `./alz`.

1. Download the CLI zip and its `.sig`, verify the signature with the AWS CLI Team's PGP key, unzip it, and run `./aws/install -i <scratch>/aws-cli -b <scratch>/bin`. Use no root and no system location.
2. `python3 -m venv <scratch>/moto && <scratch>/moto/bin/pip install "moto[server,cloudformation]"`
3. `ALZ_SIM_AWS_CLI=<scratch>/bin/aws ALZ_SIM_MOTO=<scratch>/moto/bin/moto_server npx tsx --test test/apply-emulated-cdk.test.ts`

It needs `openssl` and `readlink` on the path. It needs no hosts-file change and no system trust change.

**How the emulator is reached.** moto serves TLS with a throwaway certificate for the four hosts the CLI uses in `us-east-1`:

- `sts.us-east-1.amazonaws.com`
- `cloudformation.us-east-1.amazonaws.com`
- `tagging.us-east-1.amazonaws.com`
- `cloudcontrolapi.us-east-1.amazonaws.com`

A loopback CONNECT proxy, handed to the CLI through `ALZ_NETWORK_HTTPS_PROXY` (the runner's existing path), sends exactly those hosts to moto and refuses every other host. Each scenario asserts that only those hosts were asked for, and the cleanup scenario asserts that all four were.

**How the CLI trusts the emulator.** The bundled CLI ignores `SSL_CERT_FILE`, and the apply profile refuses `AWS_CA_BUNDLE`. So the harness builds a per-run shadow of the install:

- every file is linked;
- `botocore/cacert.pem` is a copy with the emulator's certificate appended;
- the `aws` program is a byte copy, and the test asserts its hash equals the real binary's.

**How it authenticates.** It uses the product's own identity path. DISCOVERY, CHANGESET and APPLY are `ALZ_<IDENTITY>_AWS_ROLE_ARN`, `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE` and `ALZ_<IDENTITY>_AWS_REGION`. The values are the fixture's fake role ARNs in the fake DEV account `111111111111`, with three distinct dummy token files. moto's `AssumeRoleWithWebIdentity` accepts any token. No static key, session token, profile or endpoint override reaches the product's children. The forged qualification record (a test fixture, labeled as such) binds the real binary hash and version.

The person's steps (turning termination protection on, and an out-of-band execute) use the same CLI as a separate fake person role, with a private `HOME` per call. The harness's own reads go to a launcher endpoint, never to an AWS API.

## Harness shims (moto gaps; nothing they touch is counted as verified)

The launcher patches moto in its own process. Each shim is listed in the test's header:

1. `GetTemplate` by `ChangeSetName`. moto reads `StackName` only.
2. `DescribeChangeSet` `Tags`. moto keeps a change set's tags but serializes none.
3. `UpdateTerminationProtection`. moto has no handler. This is the person's step and never the product's.
4. Cloud Control `GetResource` for `AWS::Logs::LogGroup` only, answered from moto's own logs backend. moto has no Cloud Control.
5. A hook that writes the kill switch when moto receives `ExecuteChangeSet`.

## Scenarios (the real driver: `sealPreview`, `runApply`, `observeRun`, `buildCleanupProposal`, `runCleanup`, `verifyProposalLeftovers`)

The workload is the CDK journey assembly fixture (`writeAssembly`, `test/helpers/cdk-fixtures.ts`) with its resources replaced. It holds the path 1 canary `AWS::Logs::LogGroup` and one `AWS::Events::Rule`, a type outside the reviewed leaf allowlist that a cleanup holds. The template's description and parameter default keep the fixture's canaries. Every seal carries `requester: REQUESTER`.

| Scenario | Result |
| --- | --- |
| Seal | One `CREATE` change set, created as CHANGESET in the role's account and region. Its change list is the two `Add`s. Capabilities are `[]`, the stack is `REVIEW_IN_PROGRESS`, nothing is executed, and the review bundle verifies. |
| Apply | `SUCCEEDED`: the stack is `CREATE_COMPLETE`, the change set is `EXECUTE_COMPLETE`, and the log group exists. The evidence, ledger and blueprint are written: `describe-stack-resources` as DISCOVERY, the log group's ARN derived, and the stack as the container. No canary appears in any result. |
| Second apply | `ARTIFACT_ALREADY_APPLIED`, and nothing is executed again. |
| Stale plan (a) | The sealed change set was executed out of band, so `PLAN_STALE`. |
| Stale plan (b) | An update sealed against an unprotected stack is refused (`TERMINATION_PROTECTION_OFF`) before any change set exists. After the person protects the stack, two `UPDATE`s are sealed and the later one is applied. The earlier one is `PLAN_STALE` and the cloud is unchanged. |
| Stale plan (c) | The same assembly again gives `NO_CHANGES_TO_APPLY`. |
| Kill switch before | `KILL_SWITCH_ACTIVE`. Nothing is reserved, and the change set is still `AVAILABLE`. |
| Kill switch during | The switch appears as moto receives `ExecuteChangeSet`. moto completes synchronously, so the engine's first look shows a settled create. The outcome is `SUCCEEDED` and no cancel is sent: a settled success is never reported as `KILLED`. |
| Observe | The log group is `VERIFIED` (Cloud Control shim). The rule is `UNVERIFIABLE` (no Cloud Control mapping). The tagging inventory is `COMPLETE`, and nothing unexpected is found: the stack's own ARN is the container. |
| Cleanup | The proposal deletes only the run-created log group and holds the rule (`TYPE_UNREVIEWED`). After the person protects the stack, one `UPDATE` change set removes the log group: `SUCCEEDED`, the stack is `UPDATE_COMPLETE` and is never deleted, and the log group is gone from moto. The leftover check gives the log group `CONFIRMED_DELETED`, the rule `INTENTIONALLY_RETAINED`, and the disposition `INCOMPLETE`. |

Result of the recorded run: 5 tests (10 scenarios), **5 passed, 0 failed**; see the table at the end.

## Defects the real CLI exposed

- **`src/apply/engines/cdk.ts`: every seal and cleanup failed with `CHANGE_SET_UNREADABLE`.** AWS CLI 2.38.6 follows `describe-change-set`'s change-list pages itself. It then prints every other key in the paginator's `non_aggregate_keys` (`botocore/data/cloudformation/2010-05-15/paginators-1.json`), with `null` where CloudFormation sent none. The raw XML from moto had no `Capabilities` element, yet the CLI printed `"Capabilities": null`, so this is the CLI's behavior and not moto's. The engine read `null` as malformed.
  - **Fix:** `Capabilities`, `Parameters` and `Tags` that are missing or `null` now read as empty. Any other value that is not a list is still `CHANGE_SET_UNREADABLE`.
  - **The fake now matches.** The fake `aws` in `test/helpers/cdk-fixtures.ts` prints the same `null` keys.
  - **Regression test:** a new test in `test/apply-cdk.test.ts`. Without the fix, 38 of the 55 CDK tests fail against the corrected fake; with it, all 55 pass.
- **Operator note (no code change):** the bundled CLI ignores `SSL_CERT_FILE` and `CURL_CA_BUNDLE`. The apply profile refuses `AWS_CA_BUNDLE` by design. An operator behind a TLS-inspecting proxy therefore cannot use the CDK path as it stands. That is an owner decision, not something this change widens.

## The UNVERIFIED facts (`docs/act-pilot-apply.md`, "CDK")

"Emulated" means shown with the real CLI against moto. It is evidence of the CLI's own behavior and of moto's model of CloudFormation, not of AWS.

| # | Fact | Result |
| --- | --- | --- |
| 1 | CLI subcommands and flags | **VERIFIED (emulated)**, as the real CLI parses them: `create-change-set` (with `--tags` shorthand), `wait change-set-create-complete`, `describe-change-set`, `get-template --change-set-name --template-stage Original`, `execute-change-set`, `describe-stacks`, `describe-stack-resources`, `--region`, `--output json`, `--no-cli-pager`, and `aws --version` printing `aws-cli/2.38.6 ...`. **Not run:** `describe-stack-events` and `cancel-update-stack`, which no emulated outcome reaches. |
| 2 | Web identity credentials | **VERIFIED (emulated)** that the CLI reads `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`, calls the regional `sts.us-east-1.amazonaws.com`, and acts in the role's account (every ARN names `111111111111`). **UNVERIFIED:** real STS trust evaluation (moto accepts any token) and `AWS_EC2_METADATA_DISABLED`. |
| 3 | Output shapes | **VERIFIED (emulated):** `Id` and `StackId` from create; `ChangeSetId`, `StackId`, `StackName`, `Status`, `ExecutionStatus`, and `Changes[].ResourceChange` with `Action` `Add` and `Remove`, `LogicalResourceId` and `ResourceType`; `Stacks[].StackId`, `StackStatus`, `EnableTerminationProtection`, `CreationTime` and `Tags`. **Fixed:** absent lists print as `null`, see above. **UNVERIFIED:** `get-template`'s `TemplateBody` (shim 1); `LastUpdatedTime`, which moto never prints; `RoleARN`, `NotificationARNs` and `RollbackConfiguration` values; `Replacement`; `Modify`, `Import` and `Dynamic`; and `StackEvents`. |
| 4 | Statuses | **VERIFIED (emulated):** a missing stack's error says "does not exist" (moto copies AWS's text); a `CREATE` change set leaves the stack `REVIEW_IN_PROGRESS`; creating a change set does not change the stack; a change set is `CREATE_COMPLETE` and `AVAILABLE`, then `EXECUTE_COMPLETE` after an execution, and a used one is `PLAN_STALE`. **UNVERIFIED:** `OBSOLETE` or `UNAVAILABLE` after the stack changed (moto keeps `AVAILABLE`; the engine's own stack-state check caught it), and a second `CREATE` seal on a `REVIEW_IN_PROGRESS` stack (moto makes a second stack of the same name, which the engine refuses as `CHANGE_SET_MISMATCH`). |
| 4a | Empty or failed change set | **VERIFIED (emulated):** the waiter exits non-zero on a `FAILED` change set, and a change set with nothing to change gives `NO_CHANGES_TO_APPLY`, using moto's copy of AWS's "didn't contain changes" wording. **UNVERIFIED:** the reason text of a change set that could not be built. |
| 5 | `cancel-update-stack` | **UNVERIFIED.** moto has no handler and executes synchronously, so no update is ever `UPDATE_IN_PROGRESS`. A stop while CloudFormation is still working is for G2. |
| 6 | Termination protection | **VERIFIED (emulated)** that a stack created by a change set is unprotected, that the engine reads `EnableTerminationProtection` and refuses an update until a person turns it on, and that a cleanup then proceeds. Turning it on is shim 3. Real `CreateChangeSet` behavior is for G2. |
| 7 | Inline template limit and assembly layout | **UNVERIFIED:** not exercised. The layout is the fixture's, and moto does not enforce the 51,200-byte limit. |
| 8 | Stack tags | **VERIFIED (emulated):** the `--tags Key=..,Value=..` shorthand sets the stack's tags. **UNVERIFIED:** that `describe-change-set` echoes them (shim 2), and that CloudFormation stamps them on resources (moto does not, so the sweep found only the stack). |
| 9 | `describe-stack-resources` | **VERIFIED (emulated):** `LogicalResourceId`, `PhysicalResourceId` (a log group's name), `ResourceType` and `ResourceStatus`, and the log group ARN the blueprint derives. Cloud Control's own answer is shim 4. |
| 10 | The stack's `Tags[].Key/Value` | **VERIFIED (emulated):** the cleanup read the unit's three tags from `describe-stacks` and passed them back. |
| 11 | Deletion policies and empty stacks | **UNVERIFIED:** not exercised. |

The CDK row of "Readiness audit" in `docs/act-pilot-apply.md` stays open: the items above marked UNVERIFIED, and every VERIFIED (emulated) item, are confirmed only by the owner-supervised DEV run.

## Recorded run

Recorded on 2026-10-27 with the versions above, with no other process on the emulator. The test durations below are for this sandbox only.

| Test | Result | Duration |
| --- | --- | --- |
| Seal | pass | 9.8 s |
| Apply, evidence, blueprint, second apply refused | pass | 25.4 s |
| Stale plans (used change set, unprotected update, moved stack, no changes) | pass | 67.5 s |
| Kill switch before and during | pass | 27.1 s |
| Observe, proposal, cleanup, leftover check | pass | 47.1 s |
| **Total** | **5 of 5 passed** | 180.8 s |

Without `ALZ_SIM_AWS_CLI` and `ALZ_SIM_MOTO`, the suite is skipped, which is how default CI and `npm run test:quiet` see it.
