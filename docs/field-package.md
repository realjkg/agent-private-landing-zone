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

**The owner's files are left out at staging.** The checkout at the owner's authorization commit holds the reviewed contract, and an owner's machine may hold `config/evidence-runner.json`. Neither ever enters a package:

- **The archive.** `scripts/release-stage.sh` is the one staging definition: `supply-chain.yml` runs it, and the tests run it. It copies `config/` into the stage, then removes from the stage only, naming each file:
  - `config/act-pilot-contract*`, except the disabled `*.example.json` shapes. This covers the contract, its drafts and the retired pin.
  - `config/evidence-runner.json`.
- **The runtime image.** `.dockerignore` keeps the same files out of the build context, so `COPY config/` cannot carry them and no image layer ever holds them.

So a build from the authorization commit still packages, and the package still carries no contract. The product in the package reads no contract file and reports `ACT_DISABLED`. The operator supplies their reviewed contract in their own install (section 6).

**The exclusion guard** (`src/release/package-exclusions.ts`) is the fail-closed backstop for anything else. It runs inside `src/cli/release-package.ts`, so it runs wherever a package is built:

- **At build** (`release-package --root STAGE --version V --source-commit SHA`, which `supply-chain.yml` and the `Dockerfile` already run): it walks every entry of the package, by name and by content, and refuses before anything is hashed. A refusal names each finding and writes no manifest.
- **At verify** (`release-package --root DIR --verify`, run by the clean-install smoke, the image build and `./alz qualify verify-package`):
  - It checks names only, and only the files the release manifest lists. It refuses a manifest that names an excluded file, even when every hash matches.
  - A file dropped into an installed package after the build is not in the manifest, so `--verify` does not see it.
  - Its existing line "✓ ACT remains disabled" (older than this guard) means the manifest's contract block says `actEnabled: false`. It does not mean the folder holds no contract file.
  - The binding of a whole archive to its manifest, unlisted files included, is checked by the field package generator (section 3).
- **What it does:** it reads names and bytes only. It never removes, rewrites or redacts anything. A person removes the file and builds again.

| Never packaged | Detected by | Guard code |
| --- | --- | --- |
| The owner's pilot contract `config/act-pilot-contract.json` (enabled or not), a draft of it, the retired pin, or any other `act-pilot-contract*` file except the disabled `*.example.json` shapes | name | `PILOT_CONTRACT` |
| A pilot contract that is enabled or carries an `authorize` entry, under any name: JSON (with a BOM, UTF-16, nested in an array or object), YAML, or one gzip or base64 layer of either | content | `ENABLED_CONTRACT` |
| The owner's runner configuration `config/evidence-runner.json`, which names customer targets | name | `OWNER_CONFIGURATION` |
| Tokens and keys in any file: JWTs (delivered `<IDENTITY>.jwt` files included), GitHub tokens, AWS access key ids, AWS secret access keys (by a key name such as `aws_secret_access_key`, `AWS_SECRET_KEY`, `SECRET_ACCESS_KEY` or `SecretAccessKey` and a 40-character value), Azure storage keys and connection strings (`AccountKey=`, `SharedAccessSignature=`), and Azure SAS URLs (`sig=` with another SAS field such as `sv=`, `se=` or `sp=`, or on a `*.core.windows.net` host); `.env`, `.npmrc` and `.netrc` files by name | content and name | `TOKEN` |
| Private keys: PEM (also escaped inside JSON), OpenSSH, PKCS#8/#12, Java keystores, PuTTY, kubeconfig client keys, `id_*` | content and name | `PRIVATE_KEY` |
| Cloud credentials: an AWS shared-credentials file under any name (an INI section with `aws_*` keys), a cloud service-account key file, and the `.aws`, `.azure` and `gcloud` folders | content and name | `CLOUD_CREDENTIALS` |
| Runner registration (`.runner`, `.credentials*`, `.service`, `svc.sh`, `actions-runner/`) | name | `RUNNER_REGISTRATION` |
| Service units: launchd `.plist`, systemd `.service`, `.timer` and `.socket`, `LaunchAgents/`, `LaunchDaemons/` | name | `SERVICE_UNIT` |
| Terraform state, by name (`*.tfstate*`, `terraform.tfstate.d/`) and by content (`terraform_version`, `lineage` and `serial`); working folders; real `*.tfvars` | content and name | `TERRAFORM_STATE`, `TERRAFORM_WORKDIR`, `TERRAFORM_VARIABLES` |
| Saved plans: by name (`*.tfplan`, `*.tfplan.json`, `tfplan`, `plan.out`, `*.plan`); a zip under any name whose directory holds `tfplan`, `tfstate` or `tfconfig/` entries; a JSON plan by content | content and name | `SAVED_PLAN` |
| Inside a zip that starts at the file's first byte: every stored or deflated entry is inflated in memory and judged by these same rules, by its name and content, one level deep. A zip whose directory cannot be read, or an entry in another compression method, fails closed | content | the entry's own code, or `UNREADABLE` |
| Anything under `.runs/`: evidence, sealed plans, ledgers, journals, qualification records | name | `RUN_EVIDENCE` |
| Pilot evidence and proposals elsewhere | name | `PILOT_EVIDENCE` |
| Sealed plans and signed approvals, under any name | content | `SEALED_PLAN`, `SIGNED_APPROVAL` |
| Delivered identities and the runner hook installation (`.alz-identity/`, `.alz-runner-hook/`) | name | `DELIVERED_IDENTITY` |
| A symbolic link or other non-regular entry, or a file the guard cannot read | type | `NOT_A_REGULAR_FILE`, `UNREADABLE` |

**Exceptions:**
- **Examples are allowed.** The disabled example contracts (`config/act-pilot-contract.*.example.json`), `*.tfvars.example*` and `.env.example` are allowed.
- **The root `node_modules` is not walked.** It holds the installed dependencies, which the SBOM and the audit cover. Nothing else is skipped.
- **One rule is limited to non-code files.** The YAML contract rule does not read JavaScript, TypeScript, CSS or HTML files, whose object literals read like YAML. Every other rule reads them.

**Known limitations (not detected):**
- **More than one encoding layer:** base64 of base64, gzip of base64, gzip of gzip, and base64 embedded in a JSON value. One gzip or base64 layer of the whole file, and base64 of gzip, are decoded.
- **Archives beyond one zip level:** a zip inside a zip, tar or tgz; a zip with bytes before it (for example a self-extracting archive); encrypted or password-protected zips (an entry that cannot be inflated fails closed); and archive formats other than zip.
- **Contract forms the rules do not parse:** YAML with quoted keys or a JSON flow mapping; a contract written as a literal inside a JavaScript, TypeScript, CSS or HTML file (the YAML rule skips code files, and the JSON rules read whole-file JSON); JSON nested more than four levels deep.
- **Weak shapes:** a SAS URL whose only SAS field is `sig=` on a host other than `*.core.windows.net`; secrets in a format none of the rules above names.
- **Identifiers that are not secrets:** account, subscription or project ids and resource names in a file that is not pilot evidence by name or shape.
- **The root `node_modules`:** not walked (above).

None of these is the file the product reads as its authority: `config/act-pilot-contract.json` is matched by name, case-insensitively, and staging leaves it out.

**What the guard is for.** It is a backstop, not a scanner of the customer's data. Staging, which never copies `.runs/` or anything outside the listed folders, is the first control.

**Tests (SYNTHETIC):** `test/release-package-exclusions.test.ts` covers:
- **Planted files:** one file per rule and encoding, each refused by path and code.
- **Through the CLI:** a planted file at build and at verify.
- **Owner files at staging:**
  - It stages a checkout exactly as `supply-chain.yml` does, with the owner's committed contract, a draft and `config/evidence-runner.json` present.
  - The package builds.
  - The stage, the manifest and the archive hold none of them.
  - The contract then reads `ACT_DISABLED`.
- **The image:** `.dockerignore` keeps the same files out of the image's context, and every committed `config/` file still reaches it.
- **False positives:** the real lockfiles, Terraform provider locks, configuration, policy, an SBOM and code that only names the keys are not refused.

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
- the archive is given without its release manifest, is not that manifest's package file for file, holds a link, or repeats a name (an earlier, shadowed copy could ride along);
- the SBOM or the archive checksum contradicts another input;
- the journey matrix does not check.

**Every value comes from a file.** There is no flag for a digest or a version. A missing input reads `PENDING` or `NOT_RUN`, never a guess.

| Field | Source | When it is not proven |
| --- | --- | --- |
| `source.commit` | The checkout's HEAD, which must equal `--source-commit` | Refused |
| `artifacts.archive`, `releaseManifest`, `sbom` | The SHA-256 of the files given. The archive needs `--release-manifest`, and is bound to it file by file: its `release-manifest.json` must be byte for byte the manifest given (which must name this commit), every file the manifest lists must be in the archive with its hash, and the archive may hold nothing else. The SBOM must be the one the manifest binds | `PENDING`; refused when unbound or contradicted |
| `artifacts.runtimeImage` | Not read here; the `arm64-final-image` gate owns it | `PENDING` |
| `exclusionCheck` | The guard applied to the release manifest's file list and, with an archive, to every archive entry through that binding | `PENDING` without a manifest |
| `dependencyLocks` | `package-lock.json`, and every canary's `.terraform.lock.hcl` and `package-lock.json` under `qualification/`, with provider versions read from the lock | Always present |
| `toolPins` | `config/tool-pins.json` (Terraform, Ollama, AWS CLI, Azure CLI, Bicep, Node) | Always present |
| `scans.sbom`, `scans.trivy`, `scans.npmAudit` | CycloneDX, Trivy JSON and `npm audit --json` output, summarized by severity | `NOT_RUN` |
| `platforms`, `supportedPlatforms` | `platform:*` in `config/release/status.json`. A platform is supported only when its gate is `PASS` on LIVE evidence for this commit | `NOT_QUALIFIED` |
| `models` | The committed pins in `config/tool-pins.json` and one `./alz models verify --production` run. A model is `VERIFIED` only when that run passed as a whole and in every production and stack check, was made from this commit (`production.context.sourceCommit`) under the prompt policy this commit ships (`policyHash`), carries no fixture, synthetic or mutation marker, names its target host, and its record shows the committed pin installed and qualified. These are the release admission review's private-model rules plus the policy and pin checks; sharing one exported predicate with `src/qualification/release-admission.ts` is a follow-up. `models verify` writes no LIVE label of its own, so a production run on the target host is the strongest claim its output can make | `MODEL_DIGEST_UNPINNED`, `NOT_VERIFIED` or `MODEL_DIGEST_MISMATCH` |
| `paths` (six-path matrix) | The provider and engine pairs the accepted ProductionDeploymentContract admits (`src/qualification/production-contract.ts`), the journey rows (`config/acceptance/journeys.json`, checked by `src/release/acceptance.ts`) and the `act:*` gates. A path is `LIVE_QUALIFIED` only when its gate is `PASS` on LIVE evidence for this commit and its journey row is `LIVE_PASS` | `NOT_QUALIFIED`, or `NOT_AVAILABLE` when the product does not admit the path |
| `knownLimitations`, `outOfScope`, `followUps` | Every in-scope gate that has not passed, the owner's scope exclusions, and every work-graph node that is not DONE | Always present |
| `act` | `DISABLED` by default, with no packaged contract | Always |

**Today** (`main` at `91b11f2`, SYNTHETIC; the generator was run on this repository with no artifact inputs):

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

**The committed contract never travels in a field package.**
- The staging script and `.dockerignore` leave it out (section 2), and the exclusion guard refuses it if it gets in anyway.
- An archive or image therefore always installs with ACT DISABLED.
- The operator supplies the reviewed contract in their own install. That install is the owner's checkout at the reviewed commit, where every command that seals, proposes or runs a change refuses a contract that differs from the committed file ([`docs/act-pilot-apply.md`](act-pilot-apply.md), "The contract is the authorization").

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
- **Before sharing evidence outside the customer's organization,** redact it, and never share token files, keys, state, plans or `config/act-pilot-contract.json`. Staging and the exclusion guard keep these out of the package within the limits in section 2. They do not redact what an operator shares by hand.
- **Retention is the operator's.** The package ships no evidence. Removing a run's working files keeps its evidence (section 9).
