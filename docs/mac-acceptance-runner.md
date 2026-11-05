# Mac acceptance runner: the first supervised AWS cost-baseline run

`scripts/mac-acceptance.sh` is the owner's guided script for the first supervised AWS cost-baseline run in DEV. It runs on the owner's execution host, the Mac Mini. It drives the commands the execution brief already names, in order ([`docs/act-aws-terraform-execution-brief.md`](act-aws-terraform-execution-brief.md), "Cost baseline as payload"), and collects the acceptance evidence. It reimplements no product logic, so the manual work that remains is limited to the typed phrases and the console checks only the owner can make.

> **Do not update the runner during an active acceptance run.**
>
> - Run the whole acceptance run from one commit, and record its SHA (the execution SHA) with the evidence. The runner records the commit and the SHA-256 of `scripts/mac-acceptance.sh` and its helper when a run starts.
> - `--resume` and `--bundle` refuse if the runner changed since then.
> - A runner fix merged later does not change evidence already collected. Applying it to a run, or citing it beside one, requires an evidence-impact note: which steps and which evidence the change could affect, and why.

## Authority and labels

- **It authorizes nothing.** ACT stays as the owner's reviewed contract sets it. The script never writes the contract, an approval or a live record, and never enables anything.
- **Every human gate stays yours.** Each `./alz apply` command gets your own terminal through `script(1)`. The script types no phrase, signs nothing, picks no key and answers no prompt. A live run refuses to start without an interactive terminal on stdin and stdout.
- **Retention is the default.** The disposition is **RETAIN** (owner decision record 6646346513). The script never proposes or runs a cleanup, and it prints the retention note at the end. Teardown needs a separate, explicit disposition and the brief's cleanup step, which you run yourself.
- **The evidence is yours.** The bundle is LIVE evidence collected by the owner on the owner's host. It is not CI evidence and not agent-collected, and it does not by itself certify acceptance.
- **Agents never run it against an account.** Agents test it on fakes only (SYNTHETIC; see "Tests").

## Run this

On the Mac Mini, in Terminal.app, from the root of a clean checkout at the commit that carries your reviewed limits contract:

```sh
./alz bootstrap                                   # once per commit: builds dist/
export ALZ_DISCOVERY_AWS_ROLE_ARN=...             # the twelve ALZ_* variables (brief, "Verified role ARNs ...")
scripts/mac-acceptance.sh --dry-run --readonly-profile <READONLY_PROFILE> --requester-key <KEY.pem>
scripts/mac-acceptance.sh           --readonly-profile <READONLY_PROFILE> --requester-key <KEY.pem>
```

If a step stops, fix what the message names, then continue:

```sh
scripts/mac-acceptance.sh --resume --readonly-profile <READONLY_PROFILE> --requester-key <KEY.pem>
```

Optional flags:

- `--refused-example <CANARY_COPY_DIR>` opts in to the refused half of acceptance item 6 (see "Steps").
- `--include-account-id` keeps the account id in the bundle. It is masked by default.
- `--requester ID`, `--approver ID` and `--approver-key KEY.pem` are needed only when the contract lists more than one approver, or when someone else approves.
- `--bundle` writes the evidence bundle from the run as it stands, for example after a stop.

Before you start:

- Fill in `config/cost.json` (git-ignored), and commit and merge the limits contract (brief, owner checklist items 1 to 3).
- Configure the read-only profile, for example with `aws configure sso --profile <READONLY_PROFILE>`. Do not export it: the script passes it only to the two read-only steps.
- Start the identity delivery before the qualify step. The preflight shows missing tokens as WAIT, and the runner stops at the first step that needs them until they exist.

## The preflight

Every mode starts with one checklist, `PASS`, `FAIL`, `WAIT` or `INFO` per line, each `FAIL` with its exact fix. Any `FAIL` stops the script before anything runs. It never prints a secret: variables are checked by name, and token and key files by type, owner and mode only, never opened.

| Check | How |
| --- | --- |
| macOS, bash | `uname`, `sw_vers`, `$BASH_VERSION` (Apple's `/bin/bash` 3.2 is supported) |
| Node | the major the repository pins (`config/tool-pins.json`) |
| Checkout, clean worktree, built `dist/` | `git`, and `dist/.alz-build-complete` naming `HEAD` (`./alz bootstrap`) |
| Terraform, Git, AWS CLI, Node | `./alz deps` (report only, without a terminal): Terraform's version and pinned checksum, as the product checks them |
| Read-only profile | `aws configure list-profiles` (local configuration only) |
| No fallback credentials | none of `AWS_PROFILE`, static keys, `AWS_CONFIG_FILE` or other cloud variables in this shell (the list in `src/apply/providers/aws.ts`) |
| Contract | `config/act-pilot-contract.json` committed and unchanged at `HEAD`, AWS Terraform, with `targets.DEV.limits` |
| ACT status | `./alz apply status --environment DEV` shows `PILOT_ENABLED` and DEV authorizes APPLY |
| Kill switch | the contract's `killSwitchPath` does not exist (only you remove it) |
| `config/cost.json` | the product's own validator (`readLocalCostConfig`, from `dist/`) |
| Identity variables | all twelve set; role ARNs in the contract's account; regions equal the contract's; token files owner-only once delivered |
| Requester and keys | an allowlisted id; key files are owner-only regular files (mode 0600) |
| Network | not required beyond the product's own calls: no documentation site (docs.aws.amazon.com) is needed |

`--dry-run` stops after the checklist and prints every step's exact command. It touches no cloud and writes no run state.

## Steps

Each step shows its exact command, runs it, and records its exit code, start and finish times and the SHA-256 of its output. On failure it stops with the next action. A step that finished is skipped on `--resume`.

| Step | Command | Who answers |
| --- | --- | --- |
| `01-build` | `ALZ_ALLOW_REAL_PRIVATE_BUILD=1 ALZ_ALLOW_TERRAFORM_PLAN=1 TF_VAR_aws_region=<region> node dist/cli/real-private-build.js --live-aws-read-only --scenario cost-baseline`, with the read-only profile and without the `ALZ_*` identities. Its output is kept in the run folder and only its last lines are shown. | nobody |
| `02-tfvars` | copies the project's `terraform.tfvars.example.json` to `terraform.tfvars.json` | nobody |
| `03-prepare-1` | `./alz apply prepare --environment DEV --project <project>` | you, if it asks |
| `04-unit-tags` | writes the three unit tags `prepare` printed into `unit_tags` | nobody |
| `05-prepare-2` | `prepare` again; the runner stops if the unit tags changed, and uses this run's files | you, if it asks |
| `06-qualify` | `./alz apply qualify --request <REQUEST.json> --manifest <MANIFEST.json>` | you type the target, `RUN PROJECT CODE`, `EMBED STATE_WRITE DEV` and, only after checking CloudTrail, `SEPARATED ...` |
| `07-preflight` | `./alz apply preflight --environment DEV` (must exit 0) | nobody |
| `08-seal` | `./alz apply seal --request ... --manifest ... --requester <ID> --key <KEY.pem>` | you type the phrases, then review the change list |
| `09-approve` | `./alz apply approve --bundle <REVIEW_BUNDLE.json> --key <KEY.pem> --approver <ID>`; the signed approval the product prints (no secret) is saved for apply | you type `APPROVE DEV <artifact12>` |
| `10-apply` | `./alz apply apply --request <APPLY_REQUEST.json> --manifest ... --sealed ... --approval ...` | you type the `APPLY DEV ...` line |
| `11-apply-status` | `./alz apply status --sealed <SEALED_PLAN>` | nobody |
| `12-observe` | `./alz apply observe --sealed <SEALED_PLAN>` | nobody |
| `13-cost-status` | `./alz cost status --account <account> --unit <unit> --region <region>`, with the read-only profile and without the `ALZ_*` identities | nobody |
| `14` to `17` (opt-in) | `prepare` twice and `seal` of the log-group canary copy, expected to stop with `RESOURCE_NOT_IN_LIMITS`. This is a live, read-only DISCOVERY plan in the account. A seal that succeeds stops the run: do not approve it. | you type the seal's phrases |

Rules the runner keeps:

- **An apply is never retried.** Once `10-apply` started, `--resume` refuses to run it again, unless it ended `BLOCKED` (exit 2, nothing spent). After exit 3 (SPENT), follow "When an apply fails" in `docs/act-pilot-apply.md`. A retry is a new seal with new approvals, in a new run.
- **One run at a time.**
  - A second run is refused while `.runs/mac-acceptance/current` names one. Move that file aside only after review.
  - Every mode except `--dry-run` also takes a lock, `.runs/mac-acceptance/lock`, created atomically, with the runner's pid. A second runner started at the same time, `--resume` included, is refused while the first one runs.
  - The lock is never broken while its process is alive. A lock whose process is gone is stale: the next runner moves it aside atomically, checks that the moved lock still names that dead process, then removes it and says so.
  - Two runners can find the same stale lock. If the other one replaced it with its own live lock in the meantime, the moved lock names a different process. This runner moves it back untouched and refuses. If it cannot move it back, it stops and names the folder to review.
  - A lock without a readable pid is never removed automatically. Review it, and remove it by hand only when no runner is running.
- **An apply is retried only after BLOCKED.** `--resume` runs `10-apply` again only when its latest attempt recorded its own exit, and that exit is 2. An attempt that recorded no exit (for example, the window closed during the apply) is never retried by the runner.
- **Approvals expire.** An approval lasts the contract's `maxApprovalAgeMinutes`, so apply soon after you approve.

### If the APPLY line was mistyped

A mistyped or empty APPLY line stops `apply` with `APPLY_CONFIRMATION_MISMATCH` (exit 1). Nothing is applied and no approval is consumed. The runner still counts it as an attempt and never retries it.

Recover with a new seal and new approvals, in a new run:

1. Bundle what you have: `scripts/mac-acceptance.sh --bundle ...`.
2. After review, move `.runs/mac-acceptance/current` aside.
3. Start a new run. It builds, prepares, qualifies, seals and approves again.

The product's ledger and the approval's one-time nonce refuse a second apply of a spent plan in any case.

## The evidence bundle

At the end, or with `--bundle`, the runner writes everything under `.runs/mac-acceptance/<run>/` (owner-only):

- `bundle/`: the folder (mode 0700), holding:
  - `acceptance-report.md`;
  - `MANIFEST.sha256` (`shasum -a 256 -c` format);
  - the redacted step records and outputs;
  - the redacted preflight;
  - `cost-status.redacted.json`, redacted by the product's own `redactCostStatus`;
  - the review bundle's change list and unit (no target, no signature);
  - the observation summary.
- `acceptance-bundle-<run>.tar.gz` and its `.sha256`.

What redaction does:

- removes private keys, PEM blocks, web identity tokens, access key ids and secret values;
- masks every email as the product masks a recipient (`redactAddress`: first character, `***`, the domain);
- replaces the account id with `<ACCOUNT>`, unless you pass `--include-account-id`;
- replaces the state bucket with `<STATE_BUCKET>` and key file paths with labels;
- replaces absolute paths with labels: the checkout becomes `<REPO>`, the canary copy `<CANARY_COPY>` and your home folder `<HOME>`, and any other `/Users/<name>/` becomes `/Users/<USER>/`, so your user name is not in the bundle.

The account and the state bucket are the run's own, recorded when the run starts. `--bundle` masks them even when the contract is no longer readable. When neither the run nor the contract names the account, `--bundle` refuses unless you pass `--include-account-id`.

Raw state and tfvars are never copied. A final scan refuses to archive a bundle that still holds secret-looking text, a bare 12-digit number (unless you kept the account) or a user path. It prints each file and line number with the kind of match, never the matched value.

A refused bundle is kept for review, owner-only, in `.runs/mac-acceptance/<run>/bundle/`. It is not archived, and no tar.gz or checksum is left beside it. Open the named lines, fix the cause, and run `--bundle` again before you share anything. For example, a 12-digit value that is not an account may be part of an identifier.

`acceptance-report.md` maps acceptance items 1 to 8 (brief, "Minimum acceptance") from what this run read. Each item is OBSERVED, WAITING, UNKNOWN, NOT_APPLICABLE or NEEDS_OWNER_CHECK:

| # | Mapped from | Note |
| --- | --- | --- |
| 1 | `budget.state`, limit, period, filters, subscribers | NEEDS_OWNER_CHECK when the subscriber is the alert topic (default route): confirm the recipients in the SNS console |
| 2 | nothing the product reads | always NEEDS_OWNER_CHECK: confirm the subscriptions and make a safe test publish yourself |
| 3 | `tags.state` | OBSERVED only for `ALL_PRESENT`; `NO_RESOURCES_FOUND` is not a pass |
| 4 | `costAllocationTags.state` | WAITING for `TAG_KEY_NOT_YET_IN_BILLING` |
| 5 | `export.state`, `configValid` | OBSERVED for `DELIVERED`, WAITING for `WAITING` with `configValid` observed true, else UNKNOWN |
| 6 | the cost seal and the refused example | OBSERVED only when the seal succeeded and the refused example stopped with `RESOURCE_NOT_IN_LIMITS` |
| 7 | none | always NOT_APPLICABLE (analytics is phase 2) |
| 8 | the status labels | recorded as read, none upgraded |

## The D4 identity proof on the Mac Mini

The D4 identity-delivery proof was planned for the MacBook Pro runner (`docs/act-pilot-identity-delivery.md`, section 11; brief step 1). If the owner now uses the Mac Mini as the execution host, the D4 proof must be repeated on the Mac Mini before the delivered tokens are used there. This covers:

- the `delivered`, refresh and `cleaned` checks;
- the negative hook test on every runner instance.

This script does not run that proof, and its preflight only reminds you of it.

## Tests

`test/mac-acceptance.test.ts` (SYNTHETIC) runs the script under `/bin/bash` against a fake checkout. The checkout has a fake `./alz`, a fake build and fake product modules, and `node`, `terraform`, `aws`, `uname` and `sw_vers` shims on a fake `PATH`. The tests prove:

- the dry run;
- each preflight failure with its fix;
- the refusal without a terminal;
- the stop at a failed step, and `--resume` skipping completed steps;
- that no gate is fed input;
- that no cleanup command is ever invoked and an apply is never retried;
- the bundle's manifest, report, masking and absence of secrets.

A text check keeps the script free of bash 4 and GNU-only constructs, and `bash -n` checks its syntax. The macOS job (`.github/workflows/act-identity-macos.yml`) runs the same tests under Apple's `/bin/bash` 3.2 and the BSD userland.

shellcheck is not installed in the agent sandbox, so it was not run there. If you have it on the Mac, `shellcheck scripts/mac-acceptance.sh` is an extra check.
