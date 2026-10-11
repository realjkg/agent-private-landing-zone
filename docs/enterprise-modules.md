# Enterprise libraries

Eleven library areas were built and tested but had no command-line or console entry point. They now share one: `./alz enterprise list` shows the entries and `./alz enterprise <module>` runs one. The same seven entries appear in the operator console under "Enterprise libraries" (`docs/operator-console.md`). The catalog entries live in `src/operations/families/enterprise.ts`; the report scripts are `src/cli/enterprise-*.ts`.

Every entry is a read-only, offline, deterministic report over pasted JSON or a built-in catalog. None executes an operation, calls out over the network, holds a credential or grants authority. Exit code 0 means the document is clean, 2 means it was checked and rejected, and 1 means the input could not be used. ACT stays DISABLED.

| Command | What it shows | Input |
| --- | --- | --- |
| `./alz enterprise ledger --input FILE` | Signature, hash chain, anchor and evidence manifest of a signed change-ledger export | `{"export": ..., "trustedPublicKeyPem": "..."}`; the key must come from you |
| `./alz enterprise playbook --input FILE` | Normalized, hashed and hash-checked operational playbooks; never run | One playbook or a list |
| `./alz enterprise alert-rules [--input FILE]` | Strict schema result and production signals with no rule | YAML or JSON; blank checks `config/alert-rules.yaml` |
| `./alz enterprise release-lifecycle --target-version V --target-config-schema N [...]` | Ordered install, upgrade, migrate, rollback and uninstall plan for the release files | Version and schema numbers |
| `./alz enterprise models [--role R] [--local] [--laptop-24gb]` | Model candidates and whether each is in the active catalog or still unqualified | None |
| `./alz enterprise environment --input FILE` | A read-only environment binding checked against the runtime profile, or a signed edge manifest verified | `{"binding": ...}` or `{"edge": ...}`; `authRef` is a reference, never a credential |
| `./alz enterprise knowledge [--input FILE] [--private-sovereign]` | Registered knowledge sources and whether baseline (or a pasted) snapshots would be accepted | Optional snapshot |

## Retirement check

Evidence gathered on 2026-10-11 against the checked-out branch. "Importers" are non-test files under `src/` that import the module (a resolver over relative imports, not a text search). "Promised by" is a grep of `docs/`, `config/`, `README.md` and `.github/`.

| Module | Non-test importers | Tests | Promised by | Operator surface | Decision |
| --- | --- | --- | --- | --- | --- |
| `change-ledger/local.ts`, `types.ts` | `managed-operations/operations.ts` | `change-ledger`, `managed-operations` | `docs/operator-guide.md` (Sovereign local change ledger); `docs/teardown-traceability.md` | `enterprise ledger` | KEEP, wired |
| `change-ledger/integrations.ts` | none | `change-ledger` | `docs/operator-guide.md` (optional Jira, ServiceNow, CMDB, CI contracts) | named in `enterprise ledger` output | KEEP-UNWIRED: typed contracts only, by design |
| `managed-operations/operations.ts` | none | `managed-operations`, `recovery-operations` | `docs/operator-guide.md` (Bounded managed operations) | `enterprise playbook` covers sealing only; the coordinator needs an injected provider and a lease, so it is never run | KEEP, partly wired |
| `delegation/identity.ts` | `managed-operations/operations.ts` | `delegated-identity`, `managed-operations` | `docs/operator-guide.md` (Human-sponsored delegated agent authority); `docs/identity-and-execution-contracts.md` | none: needs an injected identity verifier, RBAC and policy; a report would have to fake them | KEEP-UNWIRED |
| `a2a/confinement.ts` | none | `a2a-confinement` | `docs/operator-guide.md` (A2A sovereignty confinement); runtime profiles carry an A2A policy | none: acceptance needs a destination authorizer and replay store | KEEP-UNWIRED |
| `environment/read-only.ts`, `types.ts` | none | `environment-provider`, `observability-emission-discovery` | `docs/operator-guide.md` (Private substrate EnvironmentProviders); `docs/observability.md` (`provider-discovery-health` source) | `enterprise environment` (binding and signed edge manifest only) | KEEP, partly wired |
| `environment/transport.ts` | none | `environment-provider` | `docs/operator-guide.md` (allowlisted HTTPS fetch transport) | none: it makes the live call | KEEP-UNWIRED |
| `knowledge/baseline.ts`, `ingest.ts`, `sources.ts`, `types.ts` | `ingest.ts` only by `baseline.ts`; `sources.ts` by `ingest.ts` | `knowledge-ingestion` | `docs/positioning/sovereign-lz-corpus.md` (External engineering knowledge ingestion) | `enterprise knowledge` | KEEP, wired |
| `monitoring/alert-rules.ts` | none | `monitoring-alert-rules` | `docs/observability.md` (Alert rules); `config/alert-rules.yaml` header; `src/ollama.ts` comment | `enterprise alert-rules` | KEEP, wired |
| `release/lifecycle.ts` | none | `release-package` | `docs/production-release-admission.md` gate 5 (clean install, upgrade, rollback, uninstall, config migration); `src/release/manifest.ts` lifecycle contract | `enterprise release-lifecycle` | KEEP, wired |
| `models/candidates.ts` | none | `model-execution-contract` | `README.md` (additional private-model candidates are tracked separately) | `enterprise models` | KEEP, wired |
| `models/execution-contract.ts` | `candidates.ts` | `model-execution-contract` | `AGENTS.md` and `docs/architecture.md` (zero model authority, ACT disabled) | authority line in `enterprise models` | KEEP, wired |

### RETIRED

`recovery/service.ts` and `design/output.ts`, retired together. They had no importer, no test and no release-gate use, and they were two halves of one chain: `design/output.ts` was the only writer of the `design` evidence kind, and `recovery/service.ts` the only reader and the only code that would start the recovery controller. Nothing called either, so removal left `tsc --noEmit` clean and the recovery tests passing. The unattended-recovery sentences in `README.md` and `docs/release-readiness.md` now describe the controller as a library without a service entry point. Starting a recovery poller is a separate, explicit decision and is not part of the preview-only runtime. The example `designRef` values in `config/recovery-targets.example.json` are placeholders for design evidence supplied by the operator. The files remain in git history (c01082e, 8dbb66b).

### KEEP-UNWIRED, library only

- `delegation/identity.ts`, `a2a/confinement.ts` and `environment/transport.ts` cannot run without injected identity, policy or network components. A console or CLI report over them would have to invent those components, so they stay library-only.
- `change-ledger/integrations.ts` is intentionally contracts without adapters.
