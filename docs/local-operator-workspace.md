# Sovereign ALZ — local browser workspace

This interface is a **local operator wrapper** over the existing, governed ALZ qualification CLIs. It is intended for people who should not need to remember npm, Ollama flags, matrix scenario IDs or evidence paths.

## Start

From a source checkout that has completed the standard one-time `./alz bootstrap`:

```sh
./alz workspace
```

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

No arbitrary command, provider/model additions, mutation, CI dispatch, cloud credential capture, production plan, recovery restore, Terraform apply, or deployment is offered by this interface. ACT remains disabled. Developer/operator CLIs remain available for qualified workflows requiring explicit approval and extra evidence.

The browser displays workflow progress and the evidence classification. Each CLI persists its hashed evidence in `.runs/qualification/`; inspect the resulting named JSON file for source SHA, model digests when actually present and exact result status. One run at a time avoids accidentally multiplying private model usage.

## Interface security

Local-only bind `127.0.0.1`, exact host/origin checks, per-session CSRF token, strict allowlisted job and scenario choices, one in-flight task, bounded command output, no arbitrary shell, no remote assets, no sensitive environment-variable forwarding, restrictive Content Security Policy, and no persistence of browser session state. HTML output is inserted with `textContent`, never interpreted as HTML. Browser outputs should not include credentials or unredacted prompts; qualification CLIs are responsible for safe, limited summaries.

Tests in `test/local-operator-workspace.test.ts` use a fake runner only; they test browser routing/host/CSRF/failure status, not live model inference, provider plans or production disaster recovery. The existing Trivy release failure is tracked separately; this local UI is not production release approval.
