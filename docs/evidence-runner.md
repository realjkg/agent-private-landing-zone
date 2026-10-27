# The evidence runner: `./alz evidence`

`./alz evidence` is the owner's local runner for the live evidence that blocks a release. It runs on the owner's own machine, against the owner's own accounts, and orchestrates the evidence producers that already exist. It never produces a document a producer did not write, never declares a LIVE label for the person, never initiates an apply, and never reads, stores or forwards a credential. ACT stays disabled: the runner does not change the pilot contract, the pin or any approval.

The PLAN is on the coordination ledger (issue #39), with the owner's decisions it follows (6432901333) and the delegated decisions 2 to 5 (6433391052).

## Status of this build

This is slice S1: the command, configuration, journal, preflight, status and dry run. Every later stage reports `NOT_BUILT` with the slice that adds it, so a run ends `BLOCKED` and claims no evidence.

| Stage | Slice | What it does |
| --- | --- | --- |
| `preflight` | S1 (built) | Clean checkout of the candidate, no mutation identity in the environment, the pilot pin's presence, each provider's identity against the expected one, the owner inputs, then the start attestation. |
| `aws-readonly` | S2 | Verify the account, check the owner's no-op stack read-only, run the AWS provider qualification under the federated qualification identity. |
| `azure-readonly` | S3 | Verify the tenant and subscription, run the Azure provider qualification under the federated qualification identity. |
| `gcp-readonly` | S4 | Held until the GCP lane's PLAN lands its gate and producer. |
| `act`, `recovery`, `cleanup` | S5 | After the owner's pin only: a person at the terminal runs each existing `./alz apply` step and types every phrase. `recovery` and `cleanup` run only when named with `--stage`. |
| `summary` | S6 | Index the evidence and run the release admission review. |

## Commands

```text
./alz evidence init [--config FILE]
./alz evidence run [--config FILE] [--stage NAME] [--dry-run] [--synthetic]
./alz evidence status [--config FILE] [--synthetic]
```

- `init` copies `config/evidence-runner.example.json` to `config/evidence-runner.json` (git-ignored) and never overwrites.
- `run --dry-run` runs the preflight and prints the plan. It writes only `<evidenceDir>/dry-run/<candidate12>/dry-run.json` (marked `evidence: false`), a folder no run or index reads, and journals nothing.
- `run` runs the preflight; when it passes, it asks for the start attestation, then journals each selected stage.
- `status` reads the journal and prints each stage's last outcome, the next stage, the owner inputs still missing, and how each release gate is produced.

Exit codes: `0` only when every requested stage after the preflight produced its evidence (at least one did, and none was skipped, held, not built or blocked), `2` anything else, including a run that produced nothing or was refused, `1` an error. In this build every run exits `2`, and so does every dry run that plans a stage after the preflight. A dry run of `--stage preflight` alone exits `0` when the preflight passes, because it plans nothing that could be blocked. The console never runs the command: its three catalog entries are handoffs, and `cli/evidence.js` can never be a console job.

## Configuration

`config/evidence-runner.json` holds identifiers only, in a closed set of keys: `schemaVersion`, `candidateCommit`, `targetHardwareId`, `evidenceDir` (`.runs/evidence` or a folder under it), `aws { expectedAccountId, region, qualificationStack }` and `azure { expectedTenantId, expectedSubscriptionId, location }`. No credential, profile, key file or token path belongs in it; an unknown key, a `REPLACE-WITH` placeholder or a credential-shaped value is refused, and a refusal never echoes the value. A missing provider block skips that provider's stage. Evidence is written only under the git-ignored `.runs/evidence`, so a run never dirties the checkout it is bound to, and a symbolic link anywhere on that path below the repository refuses the run before anything is written (`EVIDENCE_PATH_REFUSED`). Every write re-checks that its folder is still a real folder at its real path (again after the run lock is taken), opens the file without following a link at its name (`O_NOFOLLOW`; a whole document goes to an exclusively created temporary file renamed into place), and checks afterward that the file it wrote is the plain, single-link file now at that path. Node cannot open a file relative to an already checked folder, so a folder swapped for a link in the instant between that check and the open cannot be prevented; it is detected right after the write and the run stops with `EVIDENCE_PATH_REFUSED`.

## Labels

A run is LIVE only when the person types `EVIDENCE LIVE <targetHardwareId>` at an interactive terminal after the preflight passes. `--synthetic`, or typing `SYNTHETIC`, labels the run SYNTHETIC: its files go under `<evidenceDir>/synthetic/` and every document is stamped `fixture: true`, which the release admission review refuses. Without a terminal and without `--synthetic` the run is refused and nothing is written. No flag or file can declare a label.

## Identities: the operator's own CLI login, in process only

Delegated decision 2 (6433391052) lets the read-only stages use the person's existing CLI login (`aws sso login`, `az login`, later `gcloud auth`) for one purpose: verifying the account, tenant, subscription or project, and read-only reads, inside the runner's own process. This is the single exception to the rule in [runner-hardening.md](runner-hardening.md) that no tool child inherits the operator's credentials, and it does not loosen that rule:

- The runner passes no session-bearing value to any child process it starts: no `AZURE_CONFIG_DIR`, `ARM_*`, AWS credential, profile or configuration variable, `CLOUDSDK_*` setting or token reaches Terraform, `az`, Bicep or any other tool. The governed tool-child environment stays the test oracle.
- `./alz qualify provider-aws` and `provider-azure`, governed previews, seal, state and apply keep the pilot's federated identities. When those are not configured, the runner reports the step BLOCKED with the missing identity named; it never substitutes the operator's login.
- Every document records the identity kind (`OPERATOR_CLI_LOGIN` or `FEDERATED`) and the account, tenant and subscription ids, never token material. Evidence obtained under the operator's login is personal-account scope, never organizational qualification.

A wrong account, tenant or subscription (`WRONG_ACCOUNT`) or a missing login (`NOT_SIGNED_IN`) stops the stage before anything is read. In this build no identity probe is built yet, so a configured provider reports `IDENTITY_NOT_VERIFIED` and the run stops BLOCKED; the probes ship with slices S2 and S3, where their exact process and environment are reviewed.

## Owner inputs

Some inputs only the owner can supply (delegated decision 3). The runner lists each one with its BLOCKED reason and never supplies it:

- `OWNER_INPUT_NOOP_STACK`: the AWS no-op qualification stack (default `alz-qualification-noop`), created by hand from `qualification/provider/aws-noop-stack.yaml`. The runner only verifies it, read-only, and never creates, updates or deletes it.
- `OWNER_INPUT_FEDERATED_IDENTITY`: the federated qualification identity the provider gates run under.
- `OWNER_INPUT_PIN`: the owner's reviewed pin commit. The `preview:*` gates are produced at seal after it, and the `act:*` gates by the DEV apply after it.

## Gates with no producer

Every production release gate is mapped (`src/evidence-runner/gates.ts`). The runner reads the gate ids from `config/release/status.json` and derives each mode from its id, so it never loads the gate registry module, which loads the pilot apply path. At run time it checks `status.json` against a committed copy of the registry's ids (`src/evidence-runner/gate-ids.ts`): a missing, unknown, repeated or reordered gate, or a scope exclusion naming no gate, refuses the run and `status` with `EVIDENCE_RELEASE_GATES_MISMATCH`, naming the ids. A test pins that copy and every derived mode to the registry. A gate with no producer on main reports `NO_PRODUCER` and the runner writes nothing for it, never a placeholder (delegated decision 4): today the CI gates (producer in open PR #274), `arm64-final-image`, `isolated-recovery`, the five `lifecycle:*` gates, `security-review:independent` and the six `pillar:*` gates. Their producers belong to a new PLAN. The `platform:*` gates are OWNER steps: the owner runs `./alz lifecycle` (merged in #281) on a disposable host of each platform, and the runner does not ingest its report yet. `private-model-runtime` is an OWNER step in this build (`./alz models verify --production` on the model host); the runner has no model stage, by a deliberate S1 choice, and a later slice may add one. Gates the owner's release scope excludes report `OUT_OF_SCOPE`.

## Journal and resume

Each candidate's run lives in `<evidenceDir>/<candidate12>/` (`<evidenceDir>/synthetic/<candidate12>/` for synthetic runs): `journal.jsonl` and `preflight.json`, both mode `0600`. The journal is append-only, with a `start` line before and a `finish` line after each step, and every line carries the run identity: source commit, configuration digest, hardware id, label, host and a digest of the expected account ids. A journal of another run is refused (`EVIDENCE_JOURNAL_MISMATCH`), a torn last line is refused rather than repaired, and `run.lock` keeps two runs out of one folder. The lock is the lifecycle runner's (`src/lifecycle/journal.ts`), not a copy: a lock is stale only when its process is proven gone, and only the run holding the exclusive takeover token may replace it, so two runs that both find a stale lock never both proceed. A lock that names no process (a run stopped while taking it) is refused as `EVIDENCE_LOCK_UNREADABLE`, naming the file to remove when no run is active. The preflight runs again on every run; a stage that already passed is skipped.
