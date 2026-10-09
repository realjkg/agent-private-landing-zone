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
4. **IaC adapter preview scenarios:** all eight currently approved Phase E provider/adapter combinations plus AWS greenfield/brownfield Pulumi and Azure brownfield Pulumi. Every gate `preview:<scenario-id>` requires real tool preview execution and a reviewed normalized ChangeSet with no unauthorized updates, adoption, delete, replacement or infrastructure apply. The previously implemented Phase E/Pulumi matrices only prove fixture behavior.
5. **Recoverability/lifecycle:** actual isolated recovery with measured RPO/RTO, plus clean install, upgrade, rollback, uninstall, config migration with independent integrity observations. Synthetic fault injection is separate and never counts as an actual restored system.
6. **Well-Architected operating evidence:** actual cost, operational excellence, reliability, security, performance and sustainability measurements for the release target, with source and measured artifacts. A qualitative UNKNOWN pillar or hardcoded synthetic metric cannot pass.

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
