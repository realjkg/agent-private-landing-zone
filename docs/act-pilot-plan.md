# PLAN: ACT pilot for the internal reference build (customer zero)

Status: approved by the repository owner on 2026-10-11 (amendment in `AGENTS.md`), amended by a recorded owner decision on 2026-10-12 (a person may run the pilot at the terminal or in the console wizard, one channel per workflow; authority items 1, 8 and 10, execution hosts). The path is implemented and tested with a fake engine (a fake `terraform`, and a fake `aws` for the CDK engine) and, for Azure and Terraform only, with a real Terraform binary against an emulator (`docs/act-pilot-simulation.md`); no live run has happened and ACT is disabled until the pilot contract is pinned. Operations live in `docs/act-pilot-apply.md`. This is the single authoritative PLAN for the pilot; changing its scope or authority model requires a new PLAN.

## Purpose

Prove the product can take a previewed change from dev through QA to production on our own infrastructure, with evidence that passes the governance and production-conformance gates. This is not general availability, not a customer feature, and not a way to widen what agents may do.

## Authority model (the contract the driver enforces)

1. The operator authorizes. An interactive human gate approves each apply: a person typing each exact phrase at the terminal, or a person answering the same phrases in the console wizard after pasting the one-time session token the console printed in the terminal where it was started. Agents, the console's job table, and automation never initiate one, and nothing is ever typed or answered for the person.
2. An apply runs only the sealed plan that was previewed and approved (for the CDK engine, the sealed CloudFormation change set, which is created and never executed until the apply): the plan hash, manifest hash, channel and target must match the approved artifact (for CDK also the state of the stack the change set was made against, and the template the change set holds). Nothing is regenerated between approval and apply. A release counts as applied only when the engine's own result and the resulting state agree (CDK: the execute call, the stack and the change set), never from the state alone. QA promotes a release that succeeded in DEV, and production promotes a release that succeeded in QA, never a dev execution plan: it needs a separate production-target preview, sealed and approved on its own, and its release identity must equal the one a successful QA apply recorded, which in turn follows a successful dev apply.
3. Approvals are authenticated, not recorded. An approval is an Ed25519 signature by a key on an allowlist, over a statement that binds the exact artifact hash (which covers the plan, the target, the channel and the pinned contract's hash, so the provider, region and tenant), environment, target (account, backend, workspace), expiry, and a one-time nonce. A typed name is never proof. Production requires two distinct verified approvals, and the requester cannot be one of them. Replayed, expired, or mis-bound approvals are refused.
4. Separate identities (Terraform's four; the CDK engine's three, DISCOVERY, CHANGESET and APPLY; an engine spec lists its own, and an identity the engine does not use is refused when configured), injected through the `ALZ_<IDENTITY>_<VAR>` path used by the runner: DISCOVERY (provider reads), STATE (state read and lock), STATE_WRITE (state write and lock, used only by apply), and APPLY (provider writes). CHANGESET (CDK only) creates and describes change sets and cannot execute one; APPLY alone executes. None inherits operator credentials and none falls back to another; in particular APPLY is never used as a state fallback. The backend must write state and coordinate locking, so STATE stays read-only for state content and STATE_WRITE is the only identity that can change state.
5. State locking stays on. State and plan files are sensitive material: the sealed plan is encrypted at rest and never written to evidence in the clear.
6. A kill switch stops a pilot apply, and the driver's behavior on partial failure is defined before the first dev apply.
7. Every apply writes encrypted evidence: who approved, what artifact, what ran, the result, and the redacted output.
8. The console's fixed job table does not gain an apply job, and the catalog validator still refuses one. The console's pilot wizard is a separate door: `src/cli/ui-channel.ts` runs the same commands as the terminal through dialogs, only for a request that carries the session token, and it is the only console module that touches `src/apply`. The Operations card for the pilot stays a handoff.
9. ACT remains DISABLED unless the pilot release contract enables it. A flag or environment variable alone must not.
10. A pilot workflow runs wholly in one channel, `CLI` or `UI`, chosen at the start and never mixed. The channel is set by the calling code, never by a flag or a file, is sealed into the plan and therefore into the artifact hash every approver signs, and `approve` and `apply` refuse with `CHANNEL_MISMATCH` when invoked through the other channel, before anything is consumed. Choosing a channel changes who may type a phrase, not what any gate checks.

## Execution hosts

- **Operator terminal:** the apply command refuses unless stdin and stdout are terminals. Credentials come from the operator-controlled host.
- **Console wizard (UI channel):** the same commands, started from the console on the operator's machine, bound to the loopback address. Each request must carry the session token printed at console start (never in the page, a link or a log), come from the console's own origin, and be a small JSON body. The wizard's dialogs ask the same exact phrases. The approver's key stays a file on that machine, checked as the terminal checks it, and is never uploaded or shown. Credentials still come from the environment of the terminal that started the console. GitHub OIDC is not assumed to exist on an arbitrary terminal.
- **GitHub:** human approvals are captured and verified before the apply job is dispatched; the job receives only the sealed artifact reference and the verified approvals. STATE_WRITE and APPLY authenticate through separate environment-bound federated identities. A GitHub required-reviewer list needs only one reviewer, so it does not satisfy the two-person production rule on its own.

## Pilot prerequisites

Supplied by the owner and listed in `docs/act-pilot-apply.md` ("What the owner supplies"). Missing real values block qualification and apply, not implementation; tests use explicit fixtures. Fake-engine tests are not real-engine qualification.

## Scope

- One internal environment chain (dev, then QA, then production), one provider (the pinned contract's `provider`: Azure or AWS, each with its own spec; the static production contract lists exactly Azure/Terraform, AWS/Terraform and AWS/CDK, with no inference or wildcard), one engine (the pinned contract's `engine`: Terraform, or CDK with AWS only, each with its own spec), chosen at Gate 0 from the engines that pass real-engine qualification.
- No customer environments, no multi-tenant console, no new feature that lacks existing wired code.

## Gates

| Gate | What must be true | Cost rule |
| --- | --- | --- |
| G0 | Provider and engine chosen. Approver roles named. Rollback and partial-failure behavior written down. | Docs only; no heavyweight run. |
| G1 | Denial-path tests written first: no apply without a matching approved preview, no apply with a changed artifact, no agent-initiated apply, no operator-credential inheritance, no unlocked state, no console job. | Targeted tests only. |
| G1b | The path's emulated simulation passes (for Azure and Terraform, the opt-in test against the real Terraform binary and Azurite, `docs/act-pilot-simulation.md`). ACT is then enabled only for the dev pilot run, by a reviewed commit of the pilot contract and its pin; the repository ships with an empty pin. | One local run; no CI minutes. |
| G2 | The engine passes real-engine qualification on a host that has it (qualification is bound to the DEV target). A dev apply of the sealed artifact succeeds with evidence. | One manual dispatch. |
| G3 | The production contract and release admission carry a pilot-scoped ACT setting that tests pin, and `./alz qualify admission` reports ready for independent review. | One manual dispatch per release candidate. |
| G4 | A production-target plan, sealed and approved by two distinct verified approvers, applies exactly as approved, and its release identity matches a successful QA apply, which follows a successful dev apply, with evidence. A QA-stage plan needs one approval and a successful dev apply of the same release. | One production run. |
| G5 | Rollback or recovery is demonstrated, or the failure handling is shown to hold. | Evidence recorded. |

## Where it lives

The apply driver and its pieces are in `src/apply/` (contract, approval, identities, sealed plan, driver, one engine spec per engine in `engine-spec.ts` and `engines/` (Terraform, with its pinned surface in `terraform.ts`, and CDK in `engines/cdk.ts`), and one provider spec per provider in `provider.ts` and `providers/`: Azure with the AzureRM backend and AWS with the S3 backend), the human entries are `src/cli/apply.ts` (the terminal) and `src/cli/ui-channel.ts` (the console wizard's only bridge, mounted by `src/operator-ui/server.ts`, with the wizard in `src/operator-ui/app/pilot/`; a person-level walkthrough is `docs/act-pilot-walkthrough.md`), release admission checks the same contract pin in `src/qualification/release-admission.ts`, and the boundary tests are `test/apply-boundary.test.ts` and `test/teardown-driver-denials.test.ts`.

## Out of scope

- Enabling ACT for agents, or for any path that lacks the interactive gate.
- Customer or multi-tenant use.
- Any change to model, tool, or approval authority for agents.
- Actual destroy. It needs its own PLAN after the apply pilot.

## Process

- Lanes may run in parallel only inside DO and on disjoint paths. Convergence and the production decision are serialized.
- Push in batches. Documentation changes ride with the code they describe and are never merged on their own; they run no heavyweight gate. The manual dispatches above are the heavyweight runs, and each is justified by its gate.
- A failed gate returns to the affected lane. A change to this authority model stops the iteration and creates a new PLAN.
