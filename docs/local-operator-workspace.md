# Sovereign ALZ — local browser workspace

This interface is a **local operator wrapper** over the existing, governed ALZ qualification CLIs. It is intended for people who should not need to remember npm, Ollama flags, matrix scenario IDs or evidence paths.

## Start

From a source checkout that has completed the standard one-time `./alz bootstrap`:

```sh
./alz
```

**One-command model-first startup:** On a prepared, interactive Mac, `./alz` opens the built-in local Sovereign ALZ browser workspace at `http://127.0.0.1:8788` without requiring npm commands or terminal menu navigation. Advanced/Expert workflow selection starts with the private Qwen/Mistral option, with a read-only model availability check. If the required local Ollama models are missing or disabled, the existing UI automatically selects the offline fixture workflow and explains the gap. No model is run merely by opening the page.

If the local workspace has not been built, `./alz` falls back to the existing guided setup. `./alz bootstrap` builds the runtime and UI once; it is a development checkout step, not a recurring user journey. For required and optional tool checks use `./alz deps`; installs still require deliberate, separately confirmed operator action.

For a manual start that only prints the URL without opening your browser:

```sh
./alz workspace
```

Operator qualification is ordinarily conducted through the local interface and CI. Engineers requiring a full local regression may use the existing **quiet** test runner (`npm run test:quiet`), which writes complete logs to `.runs/tests/latest.log` and prints a short summary. Do not direct ordinary operators to the verbose `npm run test:node` output. A green local suite or offline model matrix does not qualify live AWS, production admission, or ACT.

Open the displayed `http://127.0.0.1:8788` address **on the same machine**. Alternative local port: `ALZ_OPERATOR_PORT=8790 ./alz workspace`. No public listener, remote interface, password or internet portal is enabled.

Bootstrap builds both the runtime and the console UI. At startup the workspace says what would block every run:

- `SETUP INCOMPLETE — missing build output: …` — run `./alz bootstrap` (or `npm run build && npm run build:ui`), then restart.
- `NOTE — this checkout has uncommitted changes` — every workflow refuses to run until changes are committed or stashed, so each evidence record names an exact commit. The console explains this when a run is blocked; it never relaxes it.

The private-model workflows are switched off in the console when no local Ollama answers on the configured loopback address or the configured Qwen/Mistral models are not installed; the note under the workflow select names what is missing and offers **Check again**.

## Available guided tasks

- **Explore scenarios (offline):** eight existing direct vs conversational ALZ workflows with deterministic fixture reasoning. No real models or provider plans.
- **Private Qwen/Mistral matrix:** real local inference plus synthetic AWS/Azure discovery and fixture-generated infrastructure previews. This does not prove model-authored IaC.
- **AWS Terraform private-agent proposal:** the bounded Scenario 01 Qwen/Mistral structured proposal. Candidate HCL is generated deterministically and marked REVIEW_REQUIRED. No Terraform plan/apply through the browser.
- **Backup, recovery and pillar chaos:** 11 synthetic failure injections, including recovery hash tamper, design drift, cost spike, performance regression, idle resource waste, telemetry loss, unauthorized mutation and failure-domain isolation.

No arbitrary command, provider/model additions, mutation, CI dispatch, cloud credential capture, production plan or recovery restore is offered by the guided tasks above. ACT remains disabled unless the owner's pinned pilot contract enables it; the one separate exception is the Pilot apply wizard (`docs/act-pilot-walkthrough.md`), which only a person holding the session token printed at console start can use, one reviewed change at a time. Developer/operator CLIs remain available for qualified workflows requiring explicit approval and extra evidence.

The browser displays workflow progress and the evidence classification. Each CLI persists its hashed evidence in `.runs/qualification/`; inspect the resulting named JSON file for source SHA, model digests when actually present and exact result status. One run at a time avoids accidentally multiplying private model usage.

## Interface security

Local-only bind `127.0.0.1`, exact host/origin checks, per-session CSRF token, strict allowlisted job and scenario choices, one in-flight task, bounded command output, no arbitrary shell, no remote assets, no sensitive environment-variable forwarding, restrictive Content Security Policy, and no persistence of browser session state. HTML output is inserted with `textContent`, never interpreted as HTML. Browser outputs should not include credentials or unredacted prompts; qualification CLIs are responsible for safe, limited summaries.

Tests in `test/local-operator-workspace.test.ts` use a fake runner only; they test browser routing/host/CSRF/failure status, not live model inference, provider plans or production disaster recovery. The existing Trivy release failure is tracked separately; this local UI is not production release approval.


## Simpler planning workflow and contextual help

The Home and Operations areas present a **planning context selector** with Development, Staging / non-production and Production, and AWS, Azure, GCP or private targets. Each choice explains the corresponding isolation and acceptance requirements. **This is advisory UI state only**: no selected account, stage, identity or authorization is sent as a workflow input. Stage-specific real execution is still a separately scoped, future qualification task; production is NEVER eligible for ACT solely because it is selected in a menu.

In Operations, recommended fixture-backed tasks appear first; **Show all advanced operations** reveals the full operations catalog. Technical CLI commands, evidence classifications and requirements sit behind **What does this do, and when would I use it?** on each advanced card. The source catalog and permissions remain identical. The three experience levels still apply, and expert workflows are not removed.

Crossplane is a registered preview/render adapter and is presented when choosing an infrastructure engine. Its CLI executable is not in the required core bundle: select Crossplane to see it explicitly marked REQUIRED for that choice and the vendor source if missing. Crossplane render results remain UNKNOWN until controller reconciliation is verified. An absent binary is never represented as working just because the plugin is cataloged.

The no-live-testing iteration tests selections, UI/CLI disclosure, read-only fixtures, no implicit installation, CSRF/policy invariants, ARM64 CI and encrypted recovery. It does not execute cloud provider or real local model qualifications.


## Interactive dependency installation and synthetic agent testing

`./alz` → **Dependencies** now continues to **Configure**, **Install one missing pinned tool**, **Open workspace** or **Exit**. The pinned installer (Terraform/Ollama only) independently verifies SHA-256 and requires the exact typed approval phrase on a real TTY. Unpinned tools, such as Crossplane, are listed with their dependency guidance; they are **not installed automatically** and remain unqualified until validated.

In Advanced/Expert mode, **Where are you planning to use this?** includes an expandable client-only lab: **Simulate cloud sign-in and approval safety**. Try valid, expired, wrong-scope, or denied fake sign-in, then try a mock approval or a model request for ACT. Every infrastructure verdict stays `DENIED_ACT_DISABLED`. It cannot accept credentials or contact a real provider.

Run the offline agent journey matrix and its tests:
```sh
./node_modules/.bin/tsx --test test/installer-agent-journeys.test.ts
./node_modules/.bin/tsx scripts/installer-agent-journeys.ts
```

For the complete scenario contract and safety limits, see [Installer agent journey qualification](installer-agent-testing.md). Neither the UI lab nor a green matrix report is production provider qualification.


## Optional CLIs (Crossplane, OpenTofu, Trivy and others)

The **Dependencies → Install optional CLI** path offers the eight optional tool integrations. Crossplane, OpenTofu, Trivy, Pulumi and AWS CDK have a version-gated Homebrew route with an individual exact typed approval. Bicep, Ansible and Docker remain guided manual review because their dependencies, upstream release channels, or runtime requirements differ. Missing tools for a selected engine are also surfaced when configuring a landing-zone plan.

The agent simulator includes 80 additional disconnected installation branches (eight tools × ten outcomes) covering a matching-version install, cancellation, noninteractive terminal, missing package manager, upstream formula drift, invalid metadata, wrong formula, already installed, install failure and post-install verification failure. See [optional-tool-installer.md](optional-tool-installer.md).

Homebrew installation is **separate from** ALZ's SHA-256-pinned Terraform/Ollama archive installer; the formula manager is a delegated installation trust boundary. No installer action qualifies an infrastructure provider, a Kubernetes Crossplane controller, a Docker engine, cloud authentication or ACT.
