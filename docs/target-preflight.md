# Private Qwen/Mistral production target preflight

The production-target job in `.github/workflows/model-qualification.yml` runs **only on a deliberately registered self-hosted Linux runner with the label `alz-private-model`**. It does not silently fall back to GitHub-hosted runners. Job input `production_target=true` must be chosen explicitly. Run only after confirming the private machine and licensing/asset authority, disk space, model files and policy boundaries.

## Prepare the target (operator action)

1. Install a compatible Node 24 runtime and the exact pinned **Ollama 0.40.0** on the chosen customer-controlled host. The workflow requires pre-staged models `qwen3:1.7b`, `qwen3:4b`, and `mistral-nemo:latest`; the workflow **does not pull, update or replace** model weights on production hardware.
2. Register a self-hosted GitHub Actions runner under this repository and assign labels `self-hosted`, `linux` and `alz-private-model`. Ensure that the target is dedicated and no unrelated customer job shares the host. The job will otherwise remain queued rather than run on an unintended machine.
3. Verify the intended private Ollama service uses the isolated loopback port `127.0.0.1:11435` via `OLLAMA_HOST` / `OLLAMA_BASE_URL`. The workflow will refuse a port already occupied before launching Ollama and will verify the child service is running. The preflight verifies Ollama `/api/version` and `/api/tags`, requires all three correct model tags, nonempty valid SHA256 digests and sizes, exact source commit and runner/target identity.
4. Trigger the **Private Model Qualification** GitHub Actions workflow with `production_target=true`, a stable nonsecret `target_hardware_id`, target accelerator description, and bounded `long_run_turns`. Only this target job exercises actual inference, local model service restart and session checkpointing. No cloud credentials should be put in model prompts or preflight variables. Production infrastructure ACT is disabled.
5. Inspect the run and its `production-private-model-qualification-<target_hardware_id>` artifact: `.runs/qualification/production-target-preflight.json` and `.runs/model-qualification/*.json`. Confirm precise source commit, Ollama version, model digests, real runner identity, independent validator, restart and memory/workload evidence before crediting the live-model release gate.

## Diagnostic command on the same checked-out target source

```sh
npm ci
RUNNER_NAME=alz-private-model-01 \
OLLAMA_BASE_URL=http://127.0.0.1:11435 \
./node_modules/.bin/tsx src/cli/target-preflight.ts \
  --target-hardware-id alz-private-node-01 \
  --output .runs/qualification/production-target-preflight.json
```

This command **only validates metadata/connectivity**; it does not run an inference task, pulumi/terraform preview, provider read, cloud restore, model download, or mutation. It fails with a nonzero status if models/runtime/host identity are missing. Never present its green result as proof that the production inference workload passed.

If the dedicated runner does not exist or is offline, the production-target job must remain QUEUED/NOT_RUN. A passing hosted baseline is insufficient to qualify the target hardware. Do not publish a production release in that state.

The AWS/Azure provider production workflows remain separate, use explicit authorized OIDC identities, and must produce real cloud evidence. Real model-assisted BUILD and all approved IaC preview scenarios remain independent release blockers until exercised on the target, not solely with fixtures. Production security findings remain a separate gate; no scanner thresholds are changed here.
