# PLAN: ACT pilot for the internal reference build (customer zero)

Status: approved by the repository owner on 2026-10-11 (amendment in `AGENTS.md`). Implementation has not started. This is the single authoritative PLAN for the pilot; changing its scope or authority model requires a new PLAN.

## Purpose

Prove the product can take a previewed change from dev to production on our own infrastructure, with evidence that passes the governance and production-conformance gates. This is not general availability, not a customer feature, and not a way to widen what agents may do.

## Authority model (the contract the driver enforces)

1. The operator authorizes. An interactive human gate approves each apply. Agents, the console server, and automation never initiate one.
2. An apply runs only the sealed plan that was previewed and approved: the plan hash, manifest hash, and target must match the approved artifact. Nothing is regenerated between approval and apply. Production promotes the qualified release, not a dev execution plan: it needs a separate production-target preview, sealed and approved on its own, and its manifest hash must equal the one a successful dev apply recorded.
3. Approvals are authenticated, not recorded. An approval is an Ed25519 signature by a key on an allowlist, over a statement that binds the exact artifact hash, environment, target (tenant, subscription, backend, workspace), expiry, and a one-time nonce. A typed name is never proof. Production requires two distinct verified approvals, and the requester cannot be one of them. Replayed, expired, or mis-bound approvals are refused.
4. Four separate identities, injected through the `ALZ_<IDENTITY>_<VAR>` path used by the runner: DISCOVERY (provider reads), STATE (state read and lease), STATE_WRITE (state blob write and lease, used only by apply), and APPLY (provider writes). None inherits operator credentials and none falls back to another; in particular APPLY is never used as a state fallback. The AzureRM backend must write state blobs and coordinate leases, so STATE stays read-only and STATE_WRITE is the only identity that can change state.
5. State locking stays on. State and plan files are sensitive material: the sealed plan is encrypted at rest and never written to evidence in the clear.
6. A kill switch stops a pilot apply, and the driver's behavior on partial failure is defined before the first dev apply.
7. Every apply writes encrypted evidence: who approved, what artifact, what ran, the result, and the redacted output.
8. The console shows the command and the reason and never runs an apply. The server's fixed job table does not gain an apply job.
9. ACT remains DISABLED unless the pilot release contract enables it. A flag or environment variable alone must not.

## Execution hosts

- **Operator terminal:** the apply command refuses unless stdin and stdout are terminals. Credentials come from the operator-controlled host. GitHub OIDC is not assumed to exist on an arbitrary terminal.
- **GitHub:** human approvals are captured and verified before the apply job is dispatched; the job receives only the sealed artifact reference and the verified approvals. STATE_WRITE and APPLY authenticate through separate environment-bound federated identities. A GitHub required-reviewer list needs only one reviewer, so it does not satisfy the two-person production rule on its own.

## Pilot prerequisites (supplied by the owner)

Tenant ID and dev and prod subscription IDs (prod separate); Azure region, tags, retention, budget, and least-privilege scope; provisioned state storage per environment and the federated identities; authenticated approver public keys and the second production approver; the execution host; the pilot change (a tagged resource group plus a Log Analytics workspace); and a named cleanup owner with an approved manual cleanup procedure, since actual destroy is out of scope. Missing values block qualification and apply, not implementation; tests use explicit fixtures. Fake-engine tests are not real-engine qualification.

## Scope

- One internal environment pair (dev, then production), one provider, one engine, chosen at Gate 0 from the engines that pass real-engine qualification.
- No customer environments, no multi-tenant console, no new feature that lacks existing wired code.

## Gates

| Gate | What must be true | Cost rule |
| --- | --- | --- |
| G0 | Provider and engine chosen. Approver roles named. Rollback and partial-failure behavior written down. | Docs only; no heavyweight run. |
| G1 | Denial-path tests written first: no apply without a matching approved preview, no apply with a changed artifact, no agent-initiated apply, no operator-credential inheritance, no unlocked state, no console job. | Targeted tests only. |
| G2 | The engine passes real-engine qualification on a host that has it. A dev apply of the sealed artifact succeeds with evidence. | One manual dispatch. |
| G3 | The production contract and release admission carry a pilot-scoped ACT setting that tests pin, and `./alz qualify admission` reports ready for independent review. | One manual dispatch per release candidate. |
| G4 | A production-target plan, sealed and approved by two distinct verified approvers, applies exactly as approved, and its manifest matches a successful dev apply, with evidence. | One production run. |
| G5 | Rollback or recovery is demonstrated, or the failure handling is shown to hold. | Evidence recorded. |

## Code that must change, and the order

Verify each location when its gate starts; these come from review and are not yet confirmed line by line.

1. Tests first (G1).
2. The ACT block in `src/qualification/release-admission.ts` (the check that rejects any manifest where ACT is not DISABLED) and `src/qualification/production-contract.ts`, so a pilot-scoped contract is allowed and nothing else is.
3. The pinned ACT=false values in `src/release/manifest.ts`, `src/observability/health.ts`, `.github/workflows/control-plane-recovery.yml`, and `test/production-contract.test.ts`.
4. The apply driver, built on the destroy-preview driver stack: runner hardening, identities, sealed manifest and snapshot, qualification-based engine activation, evidence redaction, interactive gate.

## Out of scope

- Enabling ACT for agents, or for any path that lacks the interactive gate.
- Customer or multi-tenant use.
- Any change to model, tool, or approval authority for agents.
- Actual destroy. It needs its own PLAN after the apply pilot.

## Process

- Lanes may run in parallel only inside DO and on disjoint paths. Convergence and the production decision are serialized.
- Push in batches. Docs and coordination changes run no heavyweight gate. The manual dispatches above are the heavyweight runs, and each is justified by its gate.
- A failed gate returns to the affected lane. A change to this authority model stops the iteration and creates a new PLAN.
