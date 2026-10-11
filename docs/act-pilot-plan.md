# PLAN: ACT pilot for the internal reference build (customer zero)

Status: approved by the repository owner on 2026-10-11 (amendment in `AGENTS.md`). The path is implemented and tested with a fake engine and, for Azure only, with a real Terraform binary against an emulator (`docs/act-pilot-simulation.md`); no live run has happened and ACT is disabled until the pilot contract is pinned. Operations live in `docs/act-pilot-apply.md`. This is the single authoritative PLAN for the pilot; changing its scope or authority model requires a new PLAN.

## Purpose

Prove the product can take a previewed change from dev through QA to production on our own infrastructure, with evidence that passes the governance and production-conformance gates. This is not general availability, not a customer feature, and not a way to widen what agents may do.

## Authority model (the contract the driver enforces)

1. The operator authorizes. An interactive human gate approves each apply. Agents, the console server, and automation never initiate one.
2. An apply runs only the sealed plan that was previewed and approved: the plan hash, manifest hash, and target must match the approved artifact. Nothing is regenerated between approval and apply. QA promotes a release that succeeded in DEV, and production promotes a release that succeeded in QA, never a dev execution plan: it needs a separate production-target preview, sealed and approved on its own, and its release identity must equal the one a successful QA apply recorded, which in turn follows a successful dev apply.
3. Approvals are authenticated, not recorded. An approval is an Ed25519 signature by a key on an allowlist, over a statement that binds the exact artifact hash (which covers the plan, the target and the pinned contract's hash, so the provider, region and tenant), environment, target (account, backend, workspace), expiry, and a one-time nonce. A typed name is never proof. Production requires two distinct verified approvals, and the requester cannot be one of them. Replayed, expired, or mis-bound approvals are refused.
4. Four separate identities, injected through the `ALZ_<IDENTITY>_<VAR>` path used by the runner: DISCOVERY (provider reads), STATE (state read and lock), STATE_WRITE (state write and lock, used only by apply), and APPLY (provider writes). None inherits operator credentials and none falls back to another; in particular APPLY is never used as a state fallback. The backend must write state and coordinate locking, so STATE stays read-only for state content and STATE_WRITE is the only identity that can change state.
5. State locking stays on. State and plan files are sensitive material: the sealed plan is encrypted at rest and never written to evidence in the clear.
6. A kill switch stops a pilot apply, and the driver's behavior on partial failure is defined before the first dev apply.
7. Every apply writes encrypted evidence: who approved, what artifact, what ran, the result, and the redacted output.
8. The console shows the command and the reason and never runs an apply. The server's fixed job table does not gain an apply job.
9. ACT remains DISABLED unless the pilot release contract enables it. A flag or environment variable alone must not.

## Execution hosts

- **Operator terminal:** the apply command refuses unless stdin and stdout are terminals. Credentials come from the operator-controlled host. GitHub OIDC is not assumed to exist on an arbitrary terminal.
- **GitHub:** human approvals are captured and verified before the apply job is dispatched; the job receives only the sealed artifact reference and the verified approvals. STATE_WRITE and APPLY authenticate through separate environment-bound federated identities. A GitHub required-reviewer list needs only one reviewer, so it does not satisfy the two-person production rule on its own.

## Pilot prerequisites

Supplied by the owner and listed in `docs/act-pilot-apply.md` ("What the owner supplies"). Missing real values block qualification and apply, not implementation; tests use explicit fixtures. Fake-engine tests are not real-engine qualification.

## Scope

- One internal environment chain (dev, then QA, then production), one provider (the pinned contract's `provider`: Azure or AWS, each with its own spec), one engine, chosen at Gate 0 from the engines that pass real-engine qualification.
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

The apply driver and its pieces are in `src/apply/` (contract, approval, identities, sealed plan, driver, Terraform adapter, and one provider spec per provider in `provider.ts` and `providers/`: Azure with the AzureRM backend and AWS with the S3 backend), the human entry is `src/cli/apply.ts`, release admission checks the same contract pin in `src/qualification/release-admission.ts`, and the boundary tests are `test/apply-boundary.test.ts` and `test/teardown-driver-denials.test.ts`.

## Out of scope

- Enabling ACT for agents, or for any path that lacks the interactive gate.
- Customer or multi-tenant use.
- Any change to model, tool, or approval authority for agents.
- Actual destroy. It needs its own PLAN after the apply pilot.

## Process

- Lanes may run in parallel only inside DO and on disjoint paths. Convergence and the production decision are serialized.
- Push in batches. Documentation changes ride with the code they describe and are never merged on their own; they run no heavyweight gate. The manual dispatches above are the heavyweight runs, and each is justified by its gate.
- A failed gate returns to the affected lane. A change to this authority model stops the iteration and creates a new PLAN.
