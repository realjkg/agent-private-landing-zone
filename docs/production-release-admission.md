# Production Release Admission — Sovereign ALZ PREVIEW_OPERATE

**This is a release gate, not a release.** An offline test suite, CI success badge, synthetic environment, or manually edited checklist does not authorize production operation. Infrastructure ACT remains disabled under the existing deployment contract.

## Release candidate and evidence

The product claims `PREVIEW_OPERATE` support for private Qwen/Mistral reasoning, non-mutating AWS/Azure discovery and governed previews using eight registered IaC adapters. The known Trivy HIGH/CRITICAL image findings remain an **unresolved production security blocker**. No production tag/release should be published without a documented disposition and the independent release approval.

The release evidence gate registry lives in `src/qualification/release-admission.ts`. Run from an exact clean **source commit**:

```sh
npm ci
npm run build
node dist/cli/release-admission.js --manifest .runs/release/evidence-index.json
```

The command verifies the indexed evidence files are inside the workspace, hashes their *actual bytes* and matches the current source commit, gate identity, actual execution mode, and expected release control fields. The resulting report is placed in `.runs/release/admission-<uuid>.json`. It exits nonzero for a missing, stale, synthetic, inconsistent, or failed gate; **it does not deploy or publish** anything.

Example of an **incomplete input** (all other gates will correctly BLOCK):

```json
{
  "schemaVersion": 1,
  "sourceCommit": "REPLACE_WITH_EXACT_40_CHAR_COMMIT",
  "operatingMode": "PREVIEW_OPERATE",
  "infrastructureAct": "DISABLED",
  "records": []
}
```

For a real record in `records` include `id`, `mode`, `sourceCommit`, `targetHardwareId`, `evidencePath` (relative to the repository and inside it) and `evidenceSha256` (SHA256 of that file's complete bytes). **Do not fabricate passing reports**, model digests, cloud output, package scan results or backup/restore measurements. Uploaded evidence should be reviewed on the target environment with appropriate redaction, retention and provenance controls.

## Required gates

1. **Source and artifact:** exact-commit regression CI, deterministic archive, SBOM, release manifest/provenance, clean installed artifact and native ARM64 final image security scan with **zero unresolved HIGH/CRITICAL findings under the current blocking policy**.
2. **Target hardware:** `./alz models verify --production` with a local private Ollama endpoint, explicit target identity, Qwen3 1.7B + Qwen3 4B + Mistral Nemo digests, runtime restart, real long-session and checkpoint qualification. The existing production model JSON is accepted only with exact source and target match and passing constituent checks. Set `ALZ_SOURCE_COMMIT`, `ALZ_TARGET_HARDWARE_ID`, and other documented target configuration before qualifying. A CI fixture thinker cannot satisfy this.
3. **Cloud providers:** real AWS/Azure authenticated read-only inventory and governed preview, actual supported identity, real discovery sources, and matching source/target. Existing `src/cli/provider-qualification.ts` report structures are parsed. A fake region, missing preview output or mock evidence cannot pass.
4. **IaC adapter preview scenarios:** all nine Phase E provider/adapter scenarios (one per engine and provider, the Azure Terraform brownfield scenario among them) plus AWS greenfield/brownfield Pulumi and Azure brownfield Pulumi. Every gate `preview:<scenario-id>` requires real tool preview execution and a reviewed normalized ChangeSet with no unauthorized updates, adoption, delete, replacement or infrastructure apply, and its evidence must name that gate's exact scenario, provider, engine and estate: Terraform evidence never qualifies the CDK gate, and an AWS preview never the Azure one. What is enforced on the change set, exactly: the evidence counts the sealed change list by action (`changes.byAction`); `CREATE`, `UPDATE` and `IMPORT` (an adoption of a pre-existing resource), with `READ` and `SAME`, are admitted and shown for the reviewer (`PREVIEW_GATE_ACTIONS` in `src/qualification/preview-gate.ts`); `DELETE`, `REPLACE`, `REPLACE_CONDITIONAL`, `FORGET`, `DYNAMIC`, `UNKNOWN` and every other action are refused, by the producer before any attestation is asked for (`CHANGES_UNAUTHORIZED`, nothing written) and by the admission review on the document itself, whatever its label says. No per-action authorization exists beyond this: an approval signs a whole sealed artifact, so an update or an adoption is reviewed through the sealed change list, not authorized line by line (interim, pending the owner's decision). The product's own producer for the Terraform gates is `./alz apply preview-evidence` (`src/apply/preview-evidence.ts`): it writes LIVE evidence only from a sealed preview made by the pinned, qualified engine from the candidate commit, with the plan's estate matching the scenario and the person who ran it attesting the real target; anything else it labels SYNTHETIC, with the failed conditions in words, and the gate refuses it. The previously implemented Phase E/Pulumi matrices only prove fixture behavior.
5. **Recoverability/lifecycle:** actual isolated recovery with measured RPO/RTO, plus clean install, upgrade, rollback, uninstall, config migration with independent integrity observations. Synthetic fault injection is separate and never counts as an actual restored system.
6. **ACT run recovery:** the `act-run-recovery` gate (mode `ACT_RECOVERY`) takes only the product's own record, `./alz apply record-recovery` (`src/apply/recovery-record.ts`; the contract in `src/qualification/recovery-gate.ts`): the interrupted apply's ledger evidence (`PARTIAL_REQUIRES_REVIEW` or `KILLED`) and the ledger evidence of the apply that followed it under approvals issued after the interruption, with every gate field derived from those records and recomputed by the review. A hand-written document that only states the four fields, or one relabeled over records that show no interruption or an approval carried over, is refused.
7. **Well-Architected operating evidence:** actual cost, operational excellence, reliability, security, performance and sustainability measurements for the release target, with source and measured artifacts. A qualitative UNKNOWN pillar or hardcoded synthetic metric cannot pass. The owner moved these six `pillar:*` gates to v1.1 on 2026-10-28 (#39, 6481197218), because they require a deployed greenfield landing zone: the v1 scope (`config/release/scope.json`) excludes them, so the review reports them `OUT_OF_SCOPE` and refuses a record for one (`RELEASE_RECORD_FOR_OUT_OF_SCOPE_GATE`). The checks above are unchanged and apply when the owner returns them to the scope.

The registry deliberately excludes PRIVATE/KUBERNETES Pulumi provider permutations from deployment acceptance until PLAN accepts their provider/estate/authority contracts. Their six scope rows remain `PLAN_REQUIRED`, not silently accepted production capabilities.

## Honesty and approval boundary

For each gate, the verifier returns `EVIDENCE_PRESENT` or `BLOCKED`; passing structural checks means the artifact exists, is source-linked, has matching test mode, and contains claimed necessary fields. **A SHA256 checksum is integrity evidence, not proof that a remote model/cloud action genuinely occurred.** A JSON record can be edited and rehashed. Real execution must be corroborated against authenticated runner logs, infrastructure read-only identities, exact model digests, provider tool outputs, operator sign-off and retained artifacts.

Even when all rows have evidence, the report is `readyForIndependentReleaseReview: true` with `productionReleaseApproved: false`. A separate independent reviewer verifies the authentic origin and approves the production release; the tool never creates a GitHub Release or enables ACT.

### Current factual blockers

- The remote repository has no published production release.
- No connected, verified self-hosted private Qwen/Mistral target or real AWS/Azure account is accessible through this session's GitHub connector.
- No real target Pulumi/Terraform/Bicep/CDK/other adapter previews or physical customer-cloud recovery drills have been produced in this session.
- Prior Docker ARM64 final image security scan failed its Trivy HIGH/CRITICAL threshold. Do not suppress or relabel those findings to get green release approval.
- No production release admission manifest populated with real sourced evidence has been submitted or approved.

**Next actual operator action:** connect/run on the intended authorized private host, collect real model/provider/tool/restore reports in order, review each source-bound artifact, then run release admission. Any missing data remains BLOCKED; do not backfill from offline fixtures.

## Workflow economy

Do **not** repeat expensive CI, model downloads or live cloud qualifications on every source edit. Finish DO, freeze the source revision, run one consolidated candidate validation, then collect real target evidence. If a source change occurs, rebind and requalify the affected release candidate. Infrastructure ACT and generic IaC apply stay disabled.

## Pilot-scoped ACT

`infrastructureAct` is `DISABLED`, or `PILOT` for the internal pilot (`docs/act-pilot-apply.md`). `PILOT` requires an `actPilot` block, `{ "provider": "AZURE" or "AWS", "engine": "TERRAFORM" or "CDK", "contractSha256": "<sha256 of the canonical pilot contract>" }`, and a valid pilot contract with `enabled: true` at `config/act-pilot-contract.json`. The static production contract lists exactly three provider/engine pairs, each validated on its own: Azure with Terraform, AWS with Terraform, and AWS with CDK. Admission rejects a pilot contract naming any other pair (`ACT_PILOT_COMBINATION_NOT_ALLOWED`); nothing is inferred and there is no wildcard. It rejects `PILOT` without that contract or with a scope that does not match it, and rejects an enabled contract beside a release that does not declare `PILOT`. Any other value is rejected as before. The report still says `infrastructureAct: "DISABLED"` and `productionReleaseApproved: false`; it adds `actPilot` (the scope, or `null`). Every release gate still needs its own evidence.
