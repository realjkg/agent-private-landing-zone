# Field package: the supervised DEV ACT pilot

**Owner decision (2026-10-29, "Close ACT enablement blockers", item 4; #39, 6486480658):** package the product as a supervised DEV ACT pilot, not as an unrestricted production deployment product.

This page is the operator's guide to that package. It links to the runbooks instead of repeating them. It grants no authority. ACT is DISABLED in every installation, and the package carries no contract. `AGENTS.md` and [`docs/act-pilot-plan.md`](act-pilot-plan.md) remain the rules.

## 1. What the package is, and what it is not

- **It is** the release archive (`agent-private-landing-zone.tar.gz`, built by `.github/workflows/supply-chain.yml`) or the runtime image (`Dockerfile`, stage `runtime`), plus the `field-package.json` manifest for one accepted source commit (section 3).
- **It is for** an owner-supervised pilot in the customer's own DEV account, subscription or project, one explicitly reviewed target and path at a time.
- **It is not** a production deployment product. It claims no platform support, model qualification or cloud-path qualification beyond the evidence its manifest cites. Today that evidence covers no platform, no model digest and no live path (section 3, "Today").
- **Paths are separate capabilities.** One path's evidence never qualifies another ([`.claude/skills/act-pilot/SKILL.md`](../.claude/skills/act-pilot/SKILL.md), "Paths are separate capabilities").

## 2. What the package contains, and what it never contains

The archive holds exactly `dist/`, `policy/`, `config/`, `package.json`, `package-lock.json`, `alz`, `sbom.cdx.json`, `release-manifest.json` and `brand-provenance.json`. The runtime image holds the same content and its production `node_modules`. Neither holds `scripts/`, `bootstrap/`, `qualification/` or the identity runner hook.

**The exclusion guard** (`src/release/package-exclusions.ts`) fails closed. It runs inside `src/cli/release-package.ts`, so it runs wherever a package is built:

- **At build** (`release-package --root STAGE --version V --source-commit SHA`, which `supply-chain.yml` and the `Dockerfile` already run): it walks every entry of the package and refuses before anything is hashed. A refusal names each finding and writes no manifest.
- **At verify** (`release-package --root DIR --verify`, run by the clean-install smoke, the image build and `./alz qualify verify-package`): it refuses a manifest that names an excluded file, even when every hash matches.
- **What it does:** it reads names and bytes only. It never removes, rewrites or redacts anything. A person removes the file and builds again.

| Never packaged | Guard code |
| --- | --- |
| The owner's pilot contract `config/act-pilot-contract.json` (enabled or not), a draft of it, the retired pin, or any other `act-pilot-contract*` file except the disabled `*.example.json` shapes | `PILOT_CONTRACT` |
| Any contract-shaped JSON that is enabled or carries an `authorize` entry | `ENABLED_CONTRACT` |
| The owner's runner configuration `config/evidence-runner.json`, which names customer targets | `OWNER_CONFIGURATION` |
| Tokens: JWTs (delivered `<IDENTITY>.jwt` files included), GitHub tokens, AWS access key ids, `.env`, `.npmrc`, `.netrc` | `TOKEN` |
| Private keys: PEM, OpenSSH, PKCS#8/#12, Java keystores, PuTTY, `id_*` | `PRIVATE_KEY` |
| Cloud CLI credential folders (`.aws`, `.azure`, `gcloud`) | `CLOUD_CREDENTIALS` |
| Runner registration (`.runner`, `.credentials*`, `.service`, `svc.sh`, `actions-runner/`) | `RUNNER_REGISTRATION` |
| Service units: launchd `.plist`, systemd `.service`, `.timer` and `.socket`, `LaunchAgents/`, `LaunchDaemons/` | `SERVICE_UNIT` |
| Terraform state, working folders, real `*.tfvars`, saved plans (`*.tfplan`, `tfplan`, `plan.out`, `*.plan`) | `TERRAFORM_STATE`, `TERRAFORM_WORKDIR`, `TERRAFORM_VARIABLES`, `SAVED_PLAN` |
| Anything under `.runs/`: evidence, sealed plans, ledgers, journals, qualification records | `RUN_EVIDENCE` |
| Pilot evidence and proposals elsewhere; sealed plans and signed approvals, recognized by content | `PILOT_EVIDENCE`, `SEALED_PLAN`, `SIGNED_APPROVAL` |
| Delivered identities and the runner hook installation (`.alz-identity/`, `.alz-runner-hook/`) | `DELIVERED_IDENTITY` |
| A symbolic link or other non-regular entry, or a file the guard cannot read | `NOT_A_REGULAR_FILE`, `UNREADABLE` |

**Exceptions:**
- **Examples are allowed.** The disabled example contracts (`config/act-pilot-contract.*.example.json`), `*.tfvars.example*` and `.env.example` are allowed.
- **The root `node_modules` is not walked.** It holds the installed dependencies, which the SBOM and the audit cover.

**Tests (SYNTHETIC):** `test/release-package-exclusions.test.ts` plants one file per row and checks it is refused by path and code. It also covers a planted file through the CLI at build and at verify, and confirms that this repository's own staged content passes.

## 3. The field package manifest: `field-package.json`

An offline, read-only generator. Run it from a clean checkout at the accepted commit:

```sh
npx tsx scripts/field-package.ts --source-commit <accepted SHA> --out <folder> \
  --archive agent-private-landing-zone.tar.gz --archive-sha256 agent-private-landing-zone.tar.gz.sha256 \
  --release-manifest release-manifest.json --sbom sbom.cdx.json --trivy trivy-results.json \
  [--npm-audit audit.json] [--models-evidence .runs/model-qualification/<run>.json]
```

The inputs are the files `supply-chain.yml` uploads as its `agent-private-landing-zone-supply-chain` artifact. The generator writes `field-package.json` and its rendering, `field-package.md`, into `<folder>`. It refuses, and writes nothing, in these cases:
- the checkout is not exactly that commit, or has uncommitted changes;
- the release manifest names another commit, fails its own validation or lists an excluded file;
- the SBOM or the archive checksum contradicts another input;
- the journey matrix does not check.

**Every value comes from a file.** There is no flag for a digest or a version. A missing input reads `PENDING` or `NOT_RUN`, never a guess.

| Field | Source | When it is not proven |
| --- | --- | --- |
| `source.commit` | The checkout's HEAD, which must equal `--source-commit` | Refused |
| `artifacts.archive`, `releaseManifest`, `sbom` | The SHA-256 of the files given, cross-checked | `PENDING` |
| `artifacts.runtimeImage` | Not read here; the `arm64-final-image` gate owns it | `PENDING` |
| `exclusionCheck` | The guard applied to the release manifest's file list | `PENDING` without a manifest |
| `dependencyLocks` | `package-lock.json`, and every canary's `.terraform.lock.hcl` and `package-lock.json` under `qualification/`, with provider versions read from the lock | Always present |
| `toolPins` | `config/tool-pins.json` (Terraform, Ollama, AWS CLI, Azure CLI, Bicep, Node) | Always present |
| `scans.sbom`, `scans.trivy`, `scans.npmAudit` | CycloneDX, Trivy JSON and `npm audit --json` output, summarized by severity | `NOT_RUN` |
| `platforms`, `supportedPlatforms` | `platform:*` in `config/release/status.json`. A platform is supported only when its gate is `PASS` on LIVE evidence for this commit | `NOT_QUALIFIED` |
| `models` | The committed pins in `config/tool-pins.json` and a `./alz models verify` record showing that exact digest installed and qualified | `MODEL_DIGEST_UNPINNED`, `NOT_VERIFIED` or `MODEL_DIGEST_MISMATCH` |
| `paths` (six-path matrix) | The provider and engine pairs the accepted ProductionDeploymentContract admits (`src/qualification/production-contract.ts`), the journey rows (`config/acceptance/journeys.json`, checked by `src/release/acceptance.ts`) and the `act:*` gates. A path is `LIVE_QUALIFIED` only when its gate is `PASS` on LIVE evidence for this commit and its journey row is `LIVE_PASS` | `NOT_QUALIFIED`, or `NOT_AVAILABLE` when the product does not admit the path |
| `knownLimitations`, `outOfScope`, `followUps` | Every in-scope gate that has not passed, the owner's scope exclusions, and every work-graph node that is not DONE | Always present |
| `act` | `DISABLED` by default, with no packaged contract | Always |

**Today** (`main` at `60f017e`, SYNTHETIC; the generator was run on this repository with no artifact inputs):

- **Artifacts:** archive, release manifest, SBOM and image are `PENDING`, because no candidate is frozen and no supply-chain run has been cited. Every scan is `NOT_RUN`.
- **Platforms:** none supported. `linux-x64` is `NOT_RUN`; the other five are `BLOCKED`.
- **Models:** `qwen3:1.7b`, `qwen3:4b` and `mistral-nemo:12b` are `MODEL_DIGEST_UNPINNED`, because the owner has not recorded their digests.

The six-path matrix today:

| # | Path | Package scope | Contract admission | ACT gate | Live qualification |
| --- | --- | --- | --- | --- | --- |
| 1 | AWS Terraform | DEV only | admitted | `act:aws-terraform` BLOCKED | NOT_QUALIFIED |
| 2 | AWS CDK / CloudFormation | DEV only | admitted | `act:aws-cdk` NOT_RUN | NOT_QUALIFIED |
| 3 | Azure Terraform | DEV only | admitted | `act:azure-terraform` BLOCKED | NOT_QUALIFIED |
| 4 | Azure Bicep / ARM | DEV only | admitted (the contract requires DEV only) | `act:azure-bicep` BLOCKED | NOT_QUALIFIED |
| 5 | GCP Terraform | DEV only | admitted (the contract requires DEV only) | `act:gcp-terraform` BLOCKED | NOT_QUALIFIED |
| 6 | GCP API-native | NOT_AVAILABLE | not admitted (planned; the contract refuses it as not implemented) | none | NOT_AVAILABLE |

**Package scope DEV only:** this package offers every admitted path for one DEV target, even where the contract also allows the three-stage chain.

**Tests (SYNTHETIC):** `test/release-package-field-manifest.test.ts`.

## 4. Installation

ACT is DISABLED after every installation step below. None of them reaches a cloud.

- **From a source checkout** (the owner's own machine): `./alz bootstrap`, then `./alz`. See [`docs/operator-guide.md`](operator-guide.md), "First-time source checkout".
  - The checkout also holds what the package leaves out: `bootstrap/`, the canaries under `qualification/`, and the identity runner hook.
- **From the release archive:**
  1. Check its SHA-256 against `field-package.json`.
  2. Extract it, then run `npm ci --omit=dev`, `node dist/cli/release-package.js --root . --verify` and `./alz doctor`. This is the same sequence as the clean-install smoke in `supply-chain.yml`.
- **Pinned tools:** `./alz deps` checks the pinned Terraform, Ollama and cloud CLIs and installs only after a typed yes ([`docs/operator-guide.md`](operator-guide.md), "Dependencies: `./alz deps`").
- **Models:** `./alz models verify` checks the installed models against their committed digests. With no committed digest it refuses (`MODEL_DIGEST_UNPINNED`) ([`docs/operator-guide.md`](operator-guide.md), "models").
- **A packaged install under `~/.alz/app`, and its qualification on a disposable host:** `./alz lifecycle` ([`docs/operator-guide.md`](operator-guide.md), "Packaged release lifecycle").

**Nothing runs unattended.**
- The installer and `./alz bootstrap` create no service, launch agent, login item or scheduled task.
- They register no runner.
- The console runs only while `./alz` runs.

`test/release-package-exclusions.test.ts` checks this against the staged file set, the runtime image's copies, every file under `src/` and the `alz` launcher.

## 5. Identity setup

Each pilot identity is its own federated principal. The driver refuses static keys, the operator's own login and shared token files.

- **Bootstrap.** The owner bootstraps the target with a separate, time-bound admin identity: [`docs/act-pilot-bootstrap.md`](act-pilot-bootstrap.md), and [`docs/act-pilot-bootstrap-gcp.md`](act-pilot-bootstrap-gcp.md) for GCP. The pilot identities never run the bootstrap.
- **Token delivery (D4)** is [`docs/act-pilot-identity-delivery.md`](act-pilot-identity-delivery.md):
  - a reviewed delivery workflow;
  - a job allowlist hook on a controlled self-hosted runner;
  - checks on the delivered token files;
  - the owner's proof, `./alz apply identity-check --phase delivered|cleaned`.

**The self-hosted identity runner is optional qualification infrastructure:**
- The field package never installs it, registers it or starts it.
- The owner sets it up by hand, on a host the owner controls, following the D4 page. Section 10 of that page says not to install it as a launch service.
- The package ships neither its hook nor its registration files.
- D4 is not accepted until the owner's own proof on that host passes.

## 6. Contract preparation

The contract is the authorization. The package ships none, so a new installation has ACT DISABLED.

- **Who writes it.** Only the owner, by hand, in one reviewed commit. No product code path, flag, environment variable or agent writes it.
- **One target and one path.** The owner starts from the path's DEV example, for example `config/act-pilot-contract.aws-dev.example.json`, and fills in one DEV target with `"enabledEnvironments": ["DEV"]`.
- **Check it offline.** Run `./alz apply contract-check --file DRAFT.json` and `./alz apply preflight --environment DEV --contract DRAFT.json`.
- **Enable.** Add the `authorize` entry for DEV, for example `{ "DEV": ["APPLY", "CLEANUP"] }`, and commit.
- **Disable.** Emptying `authorize`, or the kill switch, stops ACT.

Details:
- [`docs/act-pilot-apply.md`](act-pilot-apply.md), "The contract is the authorization";
- the step-by-step checklist, [`docs/act-dev-enablement.md`](act-dev-enablement.md);
- the plan's gates, [`docs/act-pilot-plan.md`](act-pilot-plan.md).

**The committed contract never travels in a field package.** The exclusion guard refuses it.

## 7. Approval

Approval is per run, signed by people:
- the requester signs the sealed request;
- each approver signs the artifact hash with their own Ed25519 key and types the phrase (`./alz apply approve`);
- the contract sets the quorum.

A person at the terminal starts the apply, or a person in the console's Pilot apply wizard who holds the session token. One workflow runs wholly in one of the two. Agents, automation and the console's job table never start one.

See [`docs/act-pilot-apply.md`](act-pilot-apply.md): "Commands", "What a person, a terminal and a signature each prove" and "Channels".

## 8. Observation

`./alz apply observe --sealed SEALED_PLAN` reads the run's blueprint and checks each resource independently as DISCOVERY: Cloud Control on AWS, Azure Resource Manager on Azure. `./alz apply report` writes the lifecycle report. The execute stage is LIVE only when the owner's `record-live` record covers it. See [`docs/observe-and-cleanup.md`](observe-and-cleanup.md).

## 9. Cleanup and retention

**Cleanup** of what a run created is its own governed action. `propose-cleanup`, `approve`, `cleanup` and `verify-cleanup` need the contract's `CLEANUP` entry and fresh approvals.

**What cleanup never deletes:**
- the state backend;
- identities and authorizations;
- resource groups;
- anything the run did not create.

Retention decisions, such as the CDK canary's retained sentinel, are the owner's and are recorded as such. See [`docs/act-pilot-apply.md`](act-pilot-apply.md), "Cleanup", and [`docs/observe-and-cleanup.md`](observe-and-cleanup.md).

**Local retention:**
- **Evidence stays until the operator removes it.** It lives under `.runs/` in the installation.
- **Working files.** `./alz apply remove-workspace` removes a run's working files under its own approval. It keeps the evidence directory.

## 10. Recovery

**After a failed apply:** an apply that ends `PARTIAL_REQUIRES_REVIEW` or `KILLED` is never retried. A person reviews the state, the lease and the resources from the ledger, then seals a new plan with new approvals.

**Recording the recovery:** `./alz apply record-recovery --sealed INTERRUPTED --resumed RESUMED --target-hardware-id HOST` records the recovery for the `act-run-recovery` gate.

**The kill switch:** the contract's `killSwitchPath` stops seal, qualify and apply, including a running apply. Only the owner removes it.

See [`docs/act-pilot-apply.md`](act-pilot-apply.md): "When an apply fails", "Recording an interrupted apply's recovery" and "Kill switch".

## 11. The evidence runner

`./alz evidence` is the owner's local runner for live evidence. It sequences the existing producers, and the person types every phrase. It never initiates an apply on its own and never declares a LIVE label for the person. Its stages and status are in [`docs/evidence-runner.md`](evidence-runner.md). Its configuration, `config/evidence-runner.json`, is the owner's and is never packaged.

## 12. Uninstall

Before removing anything, keep or redact the evidence you need under `.runs/` (section 14).

1. **Stop ACT.**
   - Empty `authorize` in a reviewed commit, or create the kill switch.
   - Clean up or retain each run's resources (section 9).
   - Release any identity delivery (D4 page, section 3, step 8). Check with `identity-check --phase cleaned`.
2. **Pinned tools.** Run `./alz deps` and choose Remove for each tool.
3. **A packaged install under `~/.alz/app`.** `./alz lifecycle uninstall` is the tested removal ([`docs/operator-guide.md`](operator-guide.md), "Packaged release lifecycle"). It is built for disposable qualification hosts and asks for `LIFECYCLE LIVE <host>`.
4. **A source checkout or an extracted archive.** Delete its folder.
5. **The optional identity runner.** Removing it is the owner's, as setting it up was (D4 page, section 10). The package installed nothing there.
6. **The cloud side.** The bootstrap's own teardown, run by the owner: [`docs/act-pilot-bootstrap.md`](act-pilot-bootstrap.md), "Teardown".

## 13. Financial boundaries

- **The package authorizes no spending.**
  - Every cloud resource is created in the customer's own accounts, subscriptions or projects and billed there.
  - ACT is DISABLED until the owner's reviewed contract authorizes one DEV target and path.
- **Before any billable run,** the owner names the maximum amount and the retention period. A cost estimate is not a spending authorization.
- **The canaries are deliberately small,** but their cost is not zero by design:
  - AWS: one tagged CloudWatch Logs log group, 30-day retention, no ingestion ([`docs/act-dev-1.md`](act-dev-1.md), "Cost and policy bounds"). The CDK variant adds one no-cost sentinel.
  - Azure: one empty, tagged virtual network.
  - GCP: one Pub/Sub topic.
- **Budgets, alerts and spending limits are the customer's.**
  - The field package creates and changes none.
  - The owner-run bootstrap can create a monthly budget with alerts from the owner's own values. A budget alerts; it never stops spending ([`docs/act-pilot-bootstrap.md`](act-pilot-bootstrap.md), "Budget and cost alerts").
- **Imported cost data authorizes nothing.** Imported billing and cost data is evidence only. It never authorizes a deployment or spending ([`docs/cost-acceptance.md`](cost-acceptance.md)).

## 14. Customer-data boundaries

- **Where data is kept.** Only on the operator's host:
  - evidence, ledgers, sealed plans, approvals, journals and reports, under `.runs/` in the installation, with private file modes;
  - the encrypted evidence vault, under the operator's evidence key.
- **What leaves the host.** Nothing goes to the package's authors: no evidence upload and no usage data. Private models run on the local loopback runtime. The only outbound calls are the ones a person starts:
  - cloud API calls against the customer's own accounts;
  - the pinned tool downloads of `./alz deps`;
  - any monitoring export the operator configures ([`docs/observability.md`](observability.md)).
- **What evidence holds.** Identifiers and hashes, not credentials. It can still carry account, subscription and project ids, tenant ids, regions, resource names and approver ids.
- **Before sharing evidence outside the customer's organization,** redact it, and never share token files, keys, state, plans or `config/act-pilot-contract.json`. The exclusion guard keeps all of these out of the package, but it does not redact what an operator shares by hand.
- **Retention is the operator's.** The package ships no evidence. Removing a run's working files keeps its evidence (section 9).
