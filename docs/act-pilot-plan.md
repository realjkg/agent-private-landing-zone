# PLAN: ACT pilot for the internal reference build (customer zero)

Status: approved by the repository owner on 2026-10-11 (amendment in `AGENTS.md`). Implementation has not started. This is the single authoritative PLAN for the pilot; changing its scope or authority model requires a new PLAN.

## Purpose

Prove the product can take a previewed change from dev to production on our own infrastructure, with evidence that passes the governance and production-conformance gates. This is not general availability, not a customer feature, and not a way to widen what agents may do.

## Authority model (the contract the driver enforces)

1. The operator authorizes. An interactive human gate approves each apply. Agents, the console server, and automation never initiate one.
2. An apply runs only the sealed artifact that was previewed: the manifest and immutable snapshot hashes must match the approved preview. Nothing is regenerated between preview, dev apply, and production apply.
3. Production requires a second approver who is not the requester.
4. A distinct APPLY identity holds the credentials, injected through the `ALZ_<IDENTITY>_<VAR>` path used by the runner. It never inherits operator credentials and never falls back to the deployment or discovery identity.
5. State locking stays on. State is sensitive material and is never written to evidence in the clear.
6. A kill switch stops a pilot apply, and the driver's behavior on partial failure is defined before the first dev apply.
7. Every apply writes encrypted evidence: who approved, what artifact, what ran, the result, and the redacted output.
8. The console shows the command and the reason and never runs an apply. The server's fixed job table does not gain an apply job.
9. ACT remains DISABLED unless the pilot release contract enables it. A flag or environment variable alone must not.

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
| G4 | The same sealed artifact applies to production under the two-person gate, with evidence. | One production run. |
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
