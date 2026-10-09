# Four-operation governed action registry — trust boundary

The release design replaces unconditional **eligibility** denial with a narrow external-lease capability. The existing `act(state)` for unapproved agent CHANGE requests stays denied; it must never infer authority from a model response, a user prompt, `approveBuild`, a general IaC plan, or a local developer flag. Production execution requires trusted-host wiring of `executeGovernedAction()` and independent acceptance of that trust-boundary change.

## Registry allowlist (complete)

- `CREATE_RECOVERY_POINT`
- `ROTATE_APPROVED_EVIDENCE`
- `APPLY_APPROVED_TAGS`
- `UPDATE_ONE_PREAUTHORIZED_POLICY_OBJECT`

No general Terraform apply, Pulumi up, CDK deploy, shell execution, managed-cluster CRUD, broad cloud-write credentials, model-created IAM/permissions or arbitrary tool broker fallback.

## Admission contract

The caller supplies an externally issued **Ed25519** signed lease with exact issuer, lease ID, one-operation limit, operation name, target, SHA256 of approved policy, DesignSpec, ChangeSet and canonical payload, an explicit recovery point reference, idempotency key and not-before/expiry timestamps. Lifetime is capped at five minutes. The trust root (Ed25519 public key) and choice of built-in vs local OPA are supplied by the **trusted runtime**, never by the agent. Lease signing must live in an external owner approval service and use `canonicalActionLease` without extra fields.

The local built-in compromise/capability policy applies first. SUSPECTED, CONTAINED, RECOVERY deny actions. Optional local OPA evaluates the identical request, is mandatory when runtime policy mode is LOCAL_OPA, and fails closed. The runner then **atomically claims** the signed one-operation lease in an external durable, compare-and-set idempotency ledger before invoking the one selected handler. A network error after claiming consumes authority until independently reconciled: no auto-retry or duplicate mutation.

The registry holds **no direct provider SDK or shell client**. Exactly four typed handlers must be installed by a trusted host with their own provider resource scoping, read-before-write condition, expected version/ETag and least-privileged task identity. Do not hand the agent an interface to register handlers. Each handler must produce an exact-target receipt, provider evidence SHA256 and recovery evidence SHA256, persisted in a tamper-resistant lineage store.

## Qualification and deployment boundary

`test/governed-action-registry.test.ts` proves lease cryptography, exact hashes, one-operation restriction, compromise and local OPA denials, replay controls and receipt contract. This test suite does **not** perform a cloud operation or establish the external issuer, durable replay database, target-specific handlers, provider minimum roles, or recovery correctness. Those require explicit target/operator PLAN, independent review and the release six-gate qualification campaign.

**Current status:** registry source module and negative tests only; not an enabled cloud execution path. Continue to reject freeform `CHANGE` in `act()` until a trusted, deployment-specific external issuer and handlers are bound. A production release must remain BLOCKED without actual issuer, transactional replay, provider-condition/recovery and independent authorization tests. No authority may be conjured by CI mocks.
