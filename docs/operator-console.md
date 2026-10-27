# Operator console

`./alz workspace` starts the local operator console on `127.0.0.1`. Every capability an operator can call from the command line has a matching entry in one typed catalog (`src/operations/`). The console server, the React UI, this table and the parity guard (`test/operations-parity.test.ts`) all read that catalog, so a command cannot exist without a console equivalent.

## Customer environment setup for all practices

Modern Platforms and Digital teams in Presales and Delivery can all use **Create a customer environment** from the existing Operations area. The guide explains the currently signed-in AWS management-account profile, customer account email and administrator details, and selection of DEV, QA, STAGING or PROD. It does not introduce extra ALZ authorization or financial-attestation workflows. AWS itself enforces Account Factory permissions, and one explicit human confirmation precedes actual account creation. The browser cards remain guided terminal handoffs and cannot silently invoke AWS writes. See `docs/account-factory-builder.md`.

## How an operation is described

Each entry has an id, a one-sentence summary, a family, the exact CLI form, a safety class, a small input schema and the literal evidence basis shown beside results.

| Safety class | Meaning | Console |
| --- | --- | --- |
| `READ_ONLY` | Reads local files or fixtures only. | Run |
| `SYNTHETIC` | Simulated faults or fixtures; no model, no cloud. | Run |
| `LOCAL_MODEL` | Calls the private model server on this machine. The server refuses it unless `OLLAMA_BASE_URL` is an http address on this machine. | Run |
| `WRITES_LOCAL` | Writes only inside the repository workspace. It needs an existing local evidence key (see below). | Run |
| `HANDOFF` | Needs a person at a terminal, or live cloud access. | Guided handoff, never run |

Inputs are an enum, bounded text with a pattern, a flag, or pasted JSON with a byte cap. The browser sends only an operation id, its inputs and the CSRF token. The server validates every input against the schema (unknown fields are refused), writes any pasted JSON itself to a private `0700` temporary directory, passes the file path to a fixed script, and deletes the directory afterward. One run at a time; output is bounded and sanitized. The request size limit is derived from the catalog's own input caps, so any legal input fits; a text value containing `apply`, `destroy`, `preview-only` or `auto-approve` is refused with a 400 before anything starts.

The console never creates the local evidence key. Jobs run with a minimal environment that includes `AGENTIC_EVIDENCE_KEY_FILE` (a path, not a secret) but never `AGENTIC_EVIDENCE_KEY`. A `WRITES_LOCAL` operation ends with `EVIDENCE_KEY_MISSING` and a next step when no key file exists; run `./alz doctor` once in a terminal, which is where a fresh machine creates it.

## What the console never does

- The operations job table never runs an apply, a real destroy or an arbitrary shell, and gains no new tool or allowlist entry. Infrastructure ACT stays disabled unless the owner's pinned pilot contract enables it, and then only a person can use the separate Pilot apply wizard below.
- It never starts the destroy-preview driver and never builds an argument list containing `destroy`, `preview-only`, `apply` or `auto-approve`. Such a command is a handoff card with the exact command filled in from the form.
- It collects no cloud credentials, tokens or keys. A capability that needs live cloud access is a handoff that names the environment variables to set, never their values. The Pilot apply wizard asks for the location of an approver's key file, never the key, and the identity variables come from the terminal that started the console.

## The Pilot apply wizard

The **Pilot apply** area is a guided wizard for one change at a time (`docs/act-pilot-walkthrough.md`). It is a separate door from the operations catalog: it runs the pilot commands through `src/cli/ui-channel.ts`, the only console module that touches `src/apply`, and only for a request that carries the **session token** `./alz workspace` prints in your terminal at start. The token is never in a page, link or log, and a new one is drawn at every start. Every pilot request must also come from the console's own address, be JSON, be small, and carry no CORS permission. Dialogs ask the same exact phrases as the terminal and never fill one in. A workflow runs wholly in the console or wholly on the command line; the choice is sealed into the prepared change and the other way refuses it (`CHANNEL_MISMATCH`).

## Command groups

A catalog entry may declare a command group and subcommand. `./alz <group> <subcommand> [args]` runs it, and `./alz <group> list` prints the group's subcommands with their safety classes. The enterprise libraries live under the single group `./alz enterprise`.

## Operations

Regenerate with `npm run docs:ops`; a test fails if this table is stale.

<!-- operations:start (generated by npm run docs:ops; do not edit) -->
| Family | Operation | CLI | Safety | Console | Evidence basis |
| --- | --- | --- | --- | --- | --- |
| Evidence and inspection | Governed design demo | `./alz demo` | SYNTHETIC | Run | DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD |
| Evidence and inspection | GCP offline landing-zone walkthrough | `./alz demo gcp terraform` | SYNTHETIC | Run | GCP CLOUD ASSET INVENTORY SYNTHETIC FIXTURE — NO AUTH, LIVE CLOUD, MODEL, TERRAFORM PLAN OR ACT |
| Evidence and inspection | Design specification | `./alz design` | SYNTHETIC | Run | DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD |
| Evidence and inspection | Inspect a live environment | `./alz inspect` | HANDOFF | Guided handoff | LIVE READ-ONLY CLOUD DISCOVERY — YOUR OWN CREDENTIALS — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Discover a fixture environment | `npm run discover:aws` | WRITES_LOCAL | Run | SYNTHETIC FIXTURE DISCOVERY — NO CLOUD ACCESS — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Conversational session (live read-only) | `./alz session` | HANDOFF | Guided handoff | REAL LOCAL QWEN/MISTRAL — LIVE READ-ONLY CLOUD DISCOVERY — ENCRYPTED EVIDENCE |
| Evidence and inspection | Conversational session (fixture) | `npm run session:fixture` | HANDOFF | Guided handoff | DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD — ENCRYPTED EVIDENCE |
| Evidence and inspection | Debug trace (fixture) | `./alz debug --fixture` | SYNTHETIC | Run | DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD — WRITES A REDACTED TRACE UNDER .runs |
| Evidence and inspection | Debug trace (private models) | `./alz debug` | LOCAL_MODEL | Run | REAL LOCAL QWEN/MISTRAL REASONING — FIXTURE ENVIRONMENT, NO LIVE CLOUD — WRITES A REDACTED TRACE UNDER .runs |
| Evidence and inspection | Build loop preview | `npm run build:loop` | WRITES_LOCAL | Run | SYNTHETIC FIXTURE — PREVIEW ONLY, NO CLOUD CHANGES — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Agent kernel (fixture reasoner) | `npm run agent:assess` | WRITES_LOCAL | Run | DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Agent kernel (private models) | `npm run agent` | LOCAL_MODEL | Run | REAL LOCAL QWEN/MISTRAL REASONING — FIXTURE ENVIRONMENT, NO LIVE CLOUD — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Agent-builder connector matrix | `npm run matrix:agent-builder` | SYNTHETIC | Run | SIMULATED TEST DOUBLES — LOOPBACK ONLY, NO EGRESS, NO INFRASTRUCTURE MUTATION |
| Evidence and inspection | Real private build review | `npx tsx src/cli/real-private-build.ts --live-aws-read-only` | HANDOFF | Guided handoff | REAL LOCAL QWEN/MISTRAL — REAL TERRAFORM FMT, VALIDATE AND PLAN — NO APPLY — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Live AWS landing zone journey preview | `npx tsx src/cli/lz-live-journey.ts --instruction <text> --engine <terraform\|cdk> --account <dev-account> --region <region> --workspace <reviewed-project> --allow-project-code` | HANDOFF | Guided handoff | REAL LOCAL QWEN/MISTRAL — LIVE AWS DISCOVERY (OIDC) — NATIVE TERRAFORM PLAN OR CDK CHANGE SET PREVIEW, NO APPLY, RELEASE HOLD — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Terraform validation of the reviewed candidate | `npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models --terraform-validate` | HANDOFF | Guided handoff | REAL LOCAL QWEN/MISTRAL — SYNTHETIC AWS INVENTORY — REAL TERRAFORM CLI, NO APPLY — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Terraform plan of the reviewed candidate | `npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models --terraform-validate --terraform-plan` | HANDOFF | Guided handoff | REAL LOCAL QWEN/MISTRAL — SYNTHETIC AWS INVENTORY — REAL TERRAFORM CLI, NO APPLY — WRITES AN ENCRYPTED RECORD UNDER .runs |
| Evidence and inspection | Evidence runner: create the configuration | `./alz evidence init` | HANDOFF | Guided handoff | WRITES config/evidence-runner.json FROM THE EXAMPLE — NO CLOUD, NO CREDENTIALS |
| Evidence and inspection | Evidence runner: run the release evidence stages | `./alz evidence run` | HANDOFF | Guided handoff | PREFLIGHT ONLY IN THIS BUILD — LIVE ONLY AFTER A TYPED ATTESTATION, OTHERWISE SYNTHETIC — ACT DISABLED — WRITES UNDER .runs/evidence |
| Evidence and inspection | Evidence runner: where the run stands | `./alz evidence status` | HANDOFF | Guided handoff | READS THE LOCAL JOURNAL AND CONFIGURATION — NO CLOUD |
| Governance and policy | Guided environment setup | `./alz account-factory create` | HANDOFF | Guided handoff | LIVE AWS ACCOUNT FACTORY — individually signed-in operator and reviewed account request |
| Governance and policy | Connect existing AWS access | `./alz account-factory inspect` | HANDOFF | Guided handoff | LIVE AWS STS — existing named SSO role, no new IAM role or model credentials |
| Governance and policy | Plan a customer environment | `./alz account-factory prepare` | HANDOFF | Guided handoff | LIVE AWS — read existing organization, OU, Control Tower and Service Catalog; no cloud change |
| Governance and policy | Create the reviewed account | `./alz account-factory submit` | HANDOFF | Guided handoff | LIVE AWS ACCOUNT CREATION — one human confirmation, AWS-native permissions, recorded request |
| Governance and policy | Check environment creation progress | `./alz account-factory status` | HANDOFF | Guided handoff | LIVE SERVICE CATALOG READ — PROVIDER STATUS ONLY; INDEPENDENT ACCOUNT VERIFY STILL REQUIRED |
| Governance and policy | Follow environment provisioning | `./alz account-factory follow` | HANDOFF | Guided handoff | LIVE AWS STATUS AND READBACK — no repeat submission, member account / OU / baseline validation |
| Governance and policy | View created member account | `./alz account-factory verify` | HANDOFF | Guided handoff | LIVE AWS ORGANIZATIONS AND CONTROL TOWER — READ-ONLY MEMBER-ACCOUNT CHECK, NOT A PRODUCTION RELEASE CLAIM |
| Governance and policy | Pilot apply (human-authorized) | `./alz apply <qualify\|seal\|approve\|apply\|status>` | HANDOFF | Guided handoff | HUMAN-AUTHORIZED APPLY OF A SEALED PLAN — PILOT CONTRACT ONLY, ACT DISABLED OTHERWISE — ENCRYPTED EVIDENCE |
| Governance and policy | Create a recovery target intent | `./alz target init <target-id> <owner> <aws\|azure> <scope-id> <startup\|enterprise> <development\|production> <non-critical\|business\|critical> [--compliance=PACK@1,...]` | HANDOFF | Guided handoff | WRITES config/recovery-intents/<target-id>.json — no cloud, no infrastructure change |
| Governance and policy | Check a recovery target intent | `./alz target check <intent-file>` | READ_ONLY | Run | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Explain a recovery target intent | `./alz target explain <intent-file>` | READ_ONLY | Run | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Recovery target status | `./alz recovery status [target-file]` | READ_ONLY | Run | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Recovery test readiness | `./alz recovery test [target-file]` | READ_ONLY | Run | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Capture control-plane recovery evidence | `./alz control-plane capture --root <release-root> --evidence <encrypted-bundle>` | HANDOFF | Guided handoff | WRITES an encrypted bundle — key material is excluded, ACT stays disabled |
| Governance and policy | Verify control-plane recovery evidence | `./alz control-plane verify --evidence <encrypted-bundle>` | HANDOFF | Guided handoff | READS an encrypted bundle — key material is excluded, ACT stays disabled |
| Governance and policy | Control-plane restore drill | `./alz control-plane drill --evidence <encrypted-bundle>` | HANDOFF | Guided handoff | ISOLATED RESTORE DRILL — temporary local directory only, ACT stays disabled |
| Governance and policy | Restore the control plane | `./alz control-plane restore --evidence <encrypted-bundle> --restore-root <empty-isolated-path>` | HANDOFF | Guided handoff | WRITES restored files to the chosen empty directory — ACT stays disabled |
| Governance and policy | Operating economics report | `./alz economics report <input.json> [--json]` | READ_ONLY | Run | ADVISORY — computed only from the pasted entries; no billing or cloud access |
| Governance and policy | Runtime health and readiness | `./alz health [--serve]` | READ_ONLY | Run | LOCAL PROCESS SNAPSHOT — one shot, no listener started, no cloud |
| Governance and policy | Operator self-check | `./alz doctor` | HANDOFF | Guided handoff | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Dependency check and guided installs | `./alz deps` | HANDOFF | Guided handoff | LOCAL CHECK — installs or updates only after you choose "Install it" or "Update it" for each tool, into your user folder; an earlier version stays until the new one is checked; no cloud, no infrastructure change |
| Governance and policy | Packaged release lifecycle runner | `./alz lifecycle <clean-install\|uninstall\|partial-install-recovery\|all> --artifact FILE.tgz --evidence DIR --host ID --commit SHA [--home DIR] [--synthetic]` | HANDOFF | Guided handoff | LOCAL LIFECYCLE EVIDENCE — installs and removes the app under the user folder of a disposable host only; the report is judged by the release admission review and is never submitted or admitted here; --synthetic is labeled and never submittable; no cloud, no infrastructure change |
| Governance and policy | Security preflight | `npm run security:check` | HANDOFF | Guided handoff | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Toolbox self-check | `npm run toolbox:check` | READ_ONLY | Run | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Plug-in compatibility | `./alz plugins` | READ_ONLY | Run | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Governance and policy | Prompt guide | `./alz prompts` | READ_ONLY | Run | STATIC OPERATOR HELP TEXT |
| Governance and policy | Private model catalog | `./alz models list` | READ_ONLY | Run | STATIC MODEL CATALOG — no model is called |
| Governance and policy | Qualify private models | `./alz models verify [--all] [--model MODEL]` | LOCAL_MODEL | Run | REAL LOCAL MODEL CHECKS — loopback Ollama only; writes .runs/model-qualification |
| Governance and policy | Migrate legacy evidence | `npm run evidence:migrate` | HANDOFF | Guided handoff | REWRITES evidence files in place — no cloud, no infrastructure change |
| Governance and policy | Full operator verification | `./alz verify` | HANDOFF | Guided handoff | FULL SOURCE QUALIFICATION — long-running, contacts the npm registry |
| Governance and policy | Generate the SBOM | `./alz sbom` | HANDOFF | Guided handoff | WRITES .runs/sbom/agent-private-landing-zone.cdx.json — lockfile only |
| Governance and policy | Dependency and misconfiguration scan | `./alz scan` | HANDOFF | Guided handoff | DEPENDENCY AUDIT — contacts the npm registry; Trivy scan only when installed |
| Governance and policy | Private target preflight | `npx tsx src/cli/target-preflight.ts --target-hardware-id <id> --output <path>` | HANDOFF | Guided handoff | MODEL METADATA ONLY — no inference, no cloud; writes the report you name |
| Qualification | ALZ eight-adapter scenario matrix (recorded fixtures) | `./alz matrix --offline-fixture` | SYNTHETIC | Run | DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD |
| Qualification | ALZ eight-adapter scenario matrix (private models) | `./alz matrix --live-models` | LOCAL_MODEL | Run | REAL LOCAL QWEN/MISTRAL REASONING — SYNTHETIC IaC FIXTURE PREVIEWS |
| Qualification | AWS brownfield Terraform private-agent review | `npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models` | LOCAL_MODEL | Run | REAL LOCAL QWEN/MISTRAL — SYNTHETIC AWS INVENTORY — NO TERRAFORM PLAN |
| Qualification | Chaos and Well-Architected pillars | `./alz chaos` | SYNTHETIC | Run | SYNTHETIC FAULT INJECTION — no real restore or cloud mutation |
| Qualification | Full offline provider and engine matrix | `./alz qualify offline-matrix` | WRITES_LOCAL | Run | DETERMINISTIC FIXTURES — NO MODEL, NO CLOUD, ACT DISABLED — WRITES EVIDENCE UNDER .runs |
| Qualification | Pre-live campaign | `./alz qualify prelive` | WRITES_LOCAL | Run | DETERMINISTIC FIXTURES — NO MODEL, NO CLOUD, ACT DISABLED — WRITES EVIDENCE UNDER .runs |
| Qualification | Pulumi permutation matrix | `./alz qualify pulumi` | WRITES_LOCAL | Run | DETERMINISTIC FIXTURES — NO MODEL, NO CLOUD, ACT DISABLED — WRITES EVIDENCE UNDER .runs |
| Qualification | Synthetic red-team regression | `./alz qualify redteam` | WRITES_LOCAL | Run | SYNTHETIC ATTACK CASES — NO MODEL, NO NETWORK, NO CLOUD — WRITES EVIDENCE UNDER .runs |
| Qualification | OPA policy parity | `./alz qualify opa` | SYNTHETIC | Run | SYNTHETIC POLICY CASES EVALUATED LOCALLY BY THE PINNED OPA BINARY — WRITES NOTHING, ACT DISABLED |
| Qualification | Production evidence admission | `./alz qualify admission --manifest <evidence-index-file>` | WRITES_LOCAL | Run | LOCAL REVIEW OF PASTED EVIDENCE — NOT AN APPROVAL, ACT DISABLED — WRITES A REPORT UNDER .runs/release |
| Qualification | Verify the release package | `./alz qualify verify-package` | READ_ONLY | Run | LOCAL READ-ONLY CHECK — no model, no cloud, no infrastructure change |
| Qualification | Generate the release manifest | `./alz qualify package --root <release-root> --version <version> --source-commit <sha>` | HANDOFF | Guided handoff | WRITES release-manifest.json into the release root — no cloud, ACT stays disabled |
| Qualification | AWS provider qualification | `./alz qualify provider-aws --provider AWS --source-commit <sha> --aws-stack <name> --aws-template <file>` | HANDOFF | Guided handoff | LIVE CLOUD IDENTITY — READ-ONLY PROVIDER PREVIEW, NO APPLY — WRITES EVIDENCE UNDER .runs/qualification |
| Qualification | Azure provider qualification | `./alz qualify provider-azure --provider AZURE --source-commit <sha> --azure-bicep <file> --azure-location <region>` | HANDOFF | Guided handoff | LIVE CLOUD IDENTITY — READ-ONLY PROVIDER PREVIEW, NO APPLY — WRITES EVIDENCE UNDER .runs/qualification |
| Qualification | Private-model adversarial qualification | `./alz qualify adversarial --scope first\|all` | HANDOFF | Guided handoff | REAL LOCAL QWEN/MISTRAL INFERENCE — NO CLOUD, NO TOOL EXECUTION — WRITES EVIDENCE UNDER .runs/qualification |
| Teardown review | Record a deletion unit | `./alz teardown record` | READ_ONLY | Run | READ-ONLY REVIEW OF PASTED JSON — NO ENGINE, NO CLOUD ACCESS, NOTHING DELETED |
| Teardown review | Check a create plan | `./alz teardown check-plan` | READ_ONLY | Run | READ-ONLY REVIEW OF PASTED JSON — NO ENGINE, NO CLOUD ACCESS, NOTHING DELETED |
| Teardown review | Evaluate a destroy plan | `./alz teardown destroy-preview` | READ_ONLY | Run | READ-ONLY REVIEW OF PASTED JSON — NO ENGINE, NO CLOUD ACCESS, NOTHING DELETED |
| Teardown review | Find orphaned resources | `./alz teardown orphans` | READ_ONLY | Run | READ-ONLY REVIEW OF PASTED JSON — NO ENGINE, NO CLOUD ACCESS, NOTHING DELETED |
| Teardown review | Run a destroy preview | `./alz teardown destroy-preview-run` | HANDOFF | Guided handoff | REDACTED PREVIEW EVIDENCE — PREVIEW ONLY, ACT DISABLED |
| Teardown review | Run a create preview | `./alz teardown preview-run` | HANDOFF | Guided handoff | REDACTED PREVIEW EVIDENCE — PREVIEW ONLY, ACT DISABLED |
| Teardown review | View preview evidence | `npx tsx src/cli/teardown-review.ts evidence` | READ_ONLY | Run | REDACTED PREVIEW EVIDENCE — PREVIEW ONLY, ACT DISABLED |
| Enterprise libraries | Verify a change ledger export | `./alz enterprise ledger` | READ_ONLY | Run | OFFLINE CHECK OF PASTED JSON — NOTHING EXECUTED, NO CLOUD ACCESS, NO AUTHORITY GRANTED |
| Enterprise libraries | Validate operational playbooks | `./alz enterprise playbook` | READ_ONLY | Run | OFFLINE CHECK OF PASTED JSON — NOTHING EXECUTED, NO CLOUD ACCESS, NO AUTHORITY GRANTED |
| Enterprise libraries | Validate alert rules | `./alz enterprise alert-rules` | READ_ONLY | Run | OFFLINE CHECK OF PASTED JSON — NOTHING EXECUTED, NO CLOUD ACCESS, NO AUTHORITY GRANTED; BLANK CHECKS THE SHIPPED config/alert-rules.yaml |
| Enterprise libraries | Plan a release lifecycle | `./alz enterprise release-lifecycle` | READ_ONLY | Run | DETERMINISTIC PLAN OF RELEASE FILES ONLY — NOTHING INSTALLED, CHANGED OR REMOVED |
| Enterprise libraries | List model candidates | `./alz enterprise models` | READ_ONLY | Run | BUILT-IN CATALOG, OFFLINE — NOTHING FETCHED, RUN OR QUALIFIED HERE |
| Enterprise libraries | Validate an environment provider | `./alz enterprise environment` | READ_ONLY | Run | OFFLINE CHECK OF PASTED JSON — NOTHING EXECUTED, NO CLOUD ACCESS, NO AUTHORITY GRANTED; NO REQUEST IS SENT TO THE ENVIRONMENT |
| Enterprise libraries | Show knowledge source status | `./alz enterprise knowledge` | READ_ONLY | Run | BUILT-IN CATALOG, OFFLINE — NOTHING FETCHED, RUN OR QUALIFIED HERE; A PASTED SNAPSHOT IS CHECKED, NOT INGESTED |
<!-- operations:end -->
