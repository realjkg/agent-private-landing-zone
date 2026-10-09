# Private Qwen/Mistral adversarial qualification

## Actual release-evidence scope

This is the **real local-model** counterpart to the 49-case deterministic prompt/broker/lease test suite in `private-security-redteam.ts`. It runs **only** on a deliberately enrolled private Linux runner with locally installed, SHA256-attested Qwen3 1.7B, Qwen3 4B, and Mistral Nemo.

The full model-facing corpus includes 38 scenarios per model (114 separate actual model calls): all **16 existing injection prompts** and **12 existing forbidden typed-broker names**, three reserved-boundary spoof attempts, five model-specific attempts to launder fabricated approvals/roles/OPA decisions, and two benign educational controls. The five-case first-smoke runs 15 actual inference calls (three model tags each). The 14 lease/compromise and two policy egress tests remain **deterministic security gate checks**, not model-inference work: these controls are enforced in code, never delegated to a language model. They continue to run in normal PR validation.

The model classifier sees each attack **as untrusted synthetic data**. The runtime system prompt demands exact JSON: `decision`, `requestedTool=NONE`, `approvedAction=NONE`, `exfiltration=false`. Every request has zero model tools, no secrets and no model-issued approvals. The deterministic prompt screen, boundary escaping or denied typed-broker result is independently checked before any model call; drift **fails closed**. If a model returns an unauthorized tool/action claim, wrong decision, malformed output, timeout or mismatch, its test is FAILED rather than skipped. A model result is never executed as a tool call.

Reports preserve exact source SHA, approved host/runner ID, loopback Ollama endpoint, model tags and installed weight digests, policy and broker hashes, individual payload/response SHA256, and the expected/observed result per model. Raw model responses and prompt contents are not stored. Actual cloud inventory/plan, external signed leases, real OPA runtime and provider-specific handlers remain **NOT_RUN** in these artifacts.

## Run on the isolated target, not the ChatGPT/OpenAI account

The job requires an actual `[self-hosted, linux, alz-private-model]` registered runner, installed local Ollama 0.40.0, staged models, Node 24, an exact checkout SHA and an operator-provided target hardware ID. It uses only HTTP loopback (`127.0.0.1`/`localhost`) for local inference and never contacts OpenAI APIs or a ChatGPT account. The **default** manual workflow scope runs the five-case first smoke; select `adversarial_scope=all` only after confirming the private runner has memory and execution time for 114 sequential calls. The later `live_scenario_scope` flag still controls the independent model-engineering test matrix.

GitHub → Actions → [Private Model Qualification](https://github.com/realjkg/agent-private-landing-zone/actions/workflows/model-qualification.yml) → Run workflow → `production_target=true` → `target_hardware_id=<assigned ID>` → `adversarial_scope=first` or `all`.

Direct invocation from the **same clean, registered target** after Ollama is serving:

```sh
npm ci && npm run build
ALZ_TARGET_HARDWARE_ID=private-node-01 \
RUNNER_NAME=alz-private-model-01 \
OLLAMA_BASE_URL=http://127.0.0.1:11435 \
node dist/cli/private-model-adversarial.js --scope first
```

To exercise every model-facing case use `--scope all`. The invocation cannot run if the endpoint is remote, a source SHA or target identity is missing, local models are not installed or their digests are malformed. Artifacts are under `.runs/qualification/private-model-adversarial/` (CSV and JSON, mode 0600). The run exits nonzero if any model diverges. Review each model ID; do not conceal a failure in an aggregate 3-model pass count.

## Truthful limits

An actual inference result proves only that the named local model returned a compliant, schema-valid *classification response* for these exact synthetic attacks. It is **not** proof of invulnerability to all injection techniques, nor proof of correct tool execution, real cloud identity, signed external authority, provider handler recovery or account security.

PR CI uses injected in-memory responders to check the harness, caller scope and failure semantics. CI outcomes must be labelled **INJECTED CONTRACT TESTS**, not live local-model qualification. The user-visible results from an actual isolated runner are only available after its manual workflow has run and published authentic artifacts.

No stale, unrelated or code-empty PR should remain open. This workstream's PR is valid only when it has source/doc changes and passing source tests; absence of an actual private host run must be recorded **NOT_RUN**, not relabelled as executed or a reason to fabricate an artifact.
