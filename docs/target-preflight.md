# Private Qwen/Mistral production target preflight

The production-target job in `.github/workflows/model-qualification.yml` runs **only on a deliberately registered self-hosted Linux runner with the label `alz-private-model`**. It does not silently fall back to GitHub-hosted runners. Job input `production_target=true` must be chosen explicitly. Run only after confirming the private machine and licensing/asset authority, disk space, model files and policy boundaries.

## Prepare the target (operator action)

1. Install a compatible Node 26 runtime and the exact pinned **Ollama 0.40.0** on the chosen customer-controlled host. The workflow requires pre-staged models `qwen3:1.7b`, `qwen3:4b`, and `mistral-nemo:latest`; the workflow **does not pull, update or replace** model weights on production hardware.
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

## Dedicated production-target workflow

**Actions → Private Model Production Qualification → Run workflow** (`.github/workflows/model-production-qualification.yml`) is the one workflow that qualifies a dedicated target. It runs on a runner labeled `self-hosted, linux, alz-private-model` and nowhere else. The older `production_target` option in *Private Model Qualification* runs similar steps; both exist until the owner agrees to retire one.

**What the host needs before you dispatch it** (check the first three with the diagnostic above, and the rest by hand):

- The runner is online, idle and carries the three labels (Settings → Actions → Runners).
- Ollama is exactly 0.40.0, and `qwen3:1.7b`, `qwen3:4b` and `mistral-nemo:latest` are already pulled. The workflow never downloads or replaces a model.
- Node 26 is available, `terraform` is on the PATH, and nothing is listening on `127.0.0.1:11435`.
- If the models live in a store other than the runner user's default, give its absolute path in `ollama_models_dir`.

**Inputs.** `target_hardware_id` is a stable, non-secret name you give this host profile (1 to 64 letters, digits, `.`, `_` or `-`; never `UNKNOWN`). `target_accelerator` describes the accelerator, or stays `UNKNOWN` for CPU only. `long_run_turns` is at least 4. `adversarial_scope` and `live_scenario_scope` choose `first` or `all`; the default is `all`, which takes much longer, so choose `first` for the first run on a new host. The model inference deadlines in the code are not changed by any input.

**What it does, in order.** It checks the inputs, checks out the exact commit, and records the host's capacity. It then verifies Terraform and Ollama, starts a private Ollama on port 11435, checks the models are pre-staged, and runs the native preflight. After one real inference, it restarts Ollama, checks the host again, qualifies the production models and compiles the code. It then runs the adversarial corpus and the Terraform agent loop, which only runs `init`, `fmt` and `validate`, and finally the scenario matrix. It requests no Terraform plan or apply and no infrastructure ACT.

**Where to find the result.** The summary on the run page shows the result, the source commit, the target and the runner. The artifact `production-private-model-<run id>-<attempt>` holds the preflight JSON (before and after the restart), the capacity, Terraform and Ollama diagnostics and logs, the model qualification JSON, the adversarial and scenario results, and the Terraform agent loop evidence. It is kept for 30 days and uploaded even when the run fails.

**If a step fails.** Read the first red step; nothing after it ran. A missing model, wrong Ollama version, missing Terraform, busy port or model store that does not exist each stop the job with a message naming the cause. Fix that prerequisite on the host and dispatch again. A model timeout stops the job as a failed qualification: investigate the case and the host's capacity, and do not raise a deadline to make it pass. The job stops its own Ollama process and removes its scratch directory in every case.

**What a pass means.** A pass qualifies the tested hardware profile, commit and configuration only. It does not explain why a hosted-runner run timed out, and it is not cloud qualification or production release evidence.

## Live private-agent functional execution (after the target preflight)

After actual production model runtime qualification succeeds on the dedicated host, the same manual workflow executes the first **AWS brownfield Terraform private-agent** scenario with live local Qwen3 router/primary and Mistral Nemo independent validation. It compiles the runtime, requires a preinstalled Terraform executable, produces a source-bound model-reviewed additive HCL candidate, and runs **actual local Terraform init/fmt/validate**. AWS discovery remains synthetic and this stage does not run an actual cloud Terraform plan or authorize deployment.

The workflow's `live_scenario_scope` input defaults to `first` to avoid spending hours on the full matrix before the first scenario passes. Selecting `all` runs the eight original Phase E direct and conversational live private-model reasoning paths after the first scenario passes. Their IaC previews remain fixture-generated; the evidence files explicitly say so. Actual Azure/AWS provider/IaC previews and real source generation remain separate production gate rows.

Artifacts include `.runs/qualification/aws-brownfield-terraform-private-agents-v1-*/qualification.json`, candidate `main.tf`, and `.runs/qualification/private-agent-matrix/*.json` when selected. Do not equate this with cloud read/preview or model-authored IaC for every engine.

The GitHub integration available in this chat does not expose workflow_dispatch or private runner controls; a repository operator must use **Actions → Private Model Qualification → Run workflow**, select `production_target=true`, provide the actual `target_hardware_id`, and choose `first` or `all`. If the labeled runner is unregistered, the job stays queued and no live inference/qualification can be claimed.
