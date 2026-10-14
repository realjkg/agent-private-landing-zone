# Installer agent journey qualification — offline only

This is a **scripted operator-agent simulator**, not a deployed LLM agent, cloud session, credential grant, or production qualification. It is intentionally deterministic so a failed installer/onboarding journey can be reproduced against one commit.

## Run locally on your MacBook

From the parent `adaptcloud` directory:

```sh
cd agent-private-landing-zone
npm ci
npm run build
npm run build:ui
npm run test:installer
npm run simulate:installer
npm run simulate:installer -- --json
```

The simulation runs inside Node and does not call Google Cloud, AWS, Azure, Ollama, Terraform, `apply`, or the operating-system package manager. The report includes one reproducible SHA-256 digest and a count of synthetic cloud-auth accept/reject verdicts. **Success proves only that the finite scripted mock cases behaved according to the tested code.**

## What agents exercise

- First-time install, existing prerequisites, missing pinned Terraform, missing Crossplane, mismatched tool version, noninteractive exit and cancellation.
- All combinations of AWS, Azure, GCP and private x development, staging/non-production and production x eight IaC engines x three auth fixtures; plus additional adversarial/first-run personas.
- All mock sign-in statuses: not requested, valid fixture, expired, wrong scope, denied.
- All mock ACT requests: none, no approval, human approval fixture, model-originated request.
- An attempted shell-like menu input and a malicious/invalid journey identifier.
- Positive checksum-verified installation using an injected local fake archive, and rejection of a mismatched checksum or typed confirmation.
- Browser-safe mock sign-in and ACT scenario switches in the Advanced/Expert Environment planning panel; zero network calls and no ACT button.

## Safety rules

1. **Synthetic only**: fake sign-in outcomes are enums, not real credentials. No managed identity, OIDC token, refresh token, security principal or cloud SDK is accessed.
2. **ACT always DENIED**: even valid mock sign-in and fabricated human approval cannot unlock an infrastructure action. This simulator has no mutation tool.
3. **No silent installs**: the supported pinned Terraform/Ollama installer uses the existing checked manifest and exact human phrase on a TTY. Unpinned third-party tools (including Crossplane, OpenTofu, Bicep and Ansible) have setup instructions, **not** an automatic installer.
4. **Guided continuation**: the `./alz` dependency path now offers configure, select pinned install, open local workspace or exit, rather than stopping after the inventory.
5. **Deterministic evidence only**: a scenario or hash is not a production access proof, model qualification or deployment approval.

## What is not yet a fully qualified installer

Platform-specific signing/notarization, arbitrary optional tool installers with independent verified artifact pins, rollback/resume after interrupted package installs, automated browser accessibility and visual acceptance, fully validated environment-scoped cloud IAM onboarding, real preview execution, Crossplane reconciliation and authenticated provider parity are still open. The environment isolation gate is [Issue #147](https://github.com/realjkg/agent-private-landing-zone/issues/147), GCP parity is #141 and Preview/Operate release qualification is #39.

There must be a separate reviewed PLAN before exposing real cloud login or production ACT in this experience.
