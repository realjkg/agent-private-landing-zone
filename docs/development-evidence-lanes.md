# Development evidence versus production qualification

## Principle

**Live cloud/model evidence is a release gate, not permission to develop.** The Sovereign Landing Zone should continue ordinary DO-lane work, mock inventory replay, installation simulator development, UI review and deterministic testing while real AWS/Azure/GCP credentials, target hardware or private Qwen/Mistral workloads are unavailable.

This is NOT a relaxation of the production gate. `src/qualification/release-admission.ts` remains the only release evidence admission verifier. It still refuses missing or synthetic live model, provider, preview, recovery, supply chain and well-architected measurement artifacts. ACT remains disabled.

## The three separate decisions

| Question | Evidence required | Result without live target |
|---|---|---|
| May we continue writing and testing code? | No cloud credentials or live model; keep mock/synthetic modes explicit | **Yes**, including if local tests are failing while they are fixed |
| May this PR merge? | Exact-head GitHub PR validation and applicable repository security policy | **Only** if those checks pass; operator-reported test status is not CI proof |
| May this artifact be admitted for production? | Full source- and target-bound evidence reviewed through `release-admission` plus independent signoff | **No**, missing live qualification stays BLOCKED |

For optional tools, `./alz` may show a reviewed installation path and simulated journeys while Crossplane controllers, cloud IAM, local models and full ACT remain NOT_QUALIFIED. The installer-agent report is development evidence only.

## Inspect development posture without cloud or live models

Starting from your parent directory:

```sh
cd ~/adaptcloud
cd agent-private-landing-zone
./node_modules/.bin/tsx scripts/development-readiness.ts
```

Report the results of tests you actually ran (these are marked **operator-reported, not attested CI**):

```sh
cd ~/adaptcloud
cd agent-private-landing-zone
./node_modules/.bin/tsx scripts/development-readiness.ts \
  --check typescript=pass \
  --check node-tests=pass \
  --check ui-tests=pass \
  --check installer-journeys=pass \
  --json
```

Allowed checks: `typescript`, `node-tests`, `ui-tests`, `offline-provider-fixtures`, `installer-journeys`, `security-boundaries`. Omitted checks are `NOT_RUN`, failed checks remain `REPORTED_FAIL`. The report does **not** run those tests or certify their authenticity. PR CI remains the source of actual merge-validation evidence.

The JSON displays each real release gate as `DEFERRED_TO_RELEASE_QUALIFICATION` with `evidenceCounted: false`. It never creates a release evidence record, modifies the manifest, submits to admission, connects to a provider or enables a pilot/ACT. The source SHA-256 identifies the report's content and is not proof that external execution happened.

## Work-loop guidance

1. **PLAN / DO**: code small non-overlapping changes; use recorded AWS/Azure/GCP inventories, mocked auth and ACT denial, and the bounded installer agent journeys.
2. **Targeted CHECK**: build affected TypeScript, run relevant deterministic tests and UI checks. Correct failures in the responsible DO lane. Do not start or require heavyweight cloud/model qualification.
3. **CONVERGE**: require GitHub PR validation and independent review. A local pass claim never authorizes merging.
4. **RELEASE VERIFY**: only after a source candidate is frozen, run the distinct target-private-model and live provider qualification, security scan, recovery and operational measurement gates. Missing or synthetic evidence remains BLOCKED.
5. **ACT**: infrastructure mutation remains DISABLED globally. No mock approval, UI toggle, fixture, developer report or production-stage selection grants an exception; the separately authorized pilot contract and all associated gates remain intact.

The release-closeout ledger is [Issue #39](https://github.com/realjkg/agent-private-landing-zone/issues/39). Optional installer progression is [Issue #149](https://github.com/realjkg/agent-private-landing-zone/issues/149), environment enforcement is [Issue #147](https://github.com/realjkg/agent-private-landing-zone/issues/147), and GCP live-provider onboarding is [Issue #141](https://github.com/realjkg/agent-private-landing-zone/issues/141).
