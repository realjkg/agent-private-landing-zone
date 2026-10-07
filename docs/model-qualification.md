# Private model qualification

The local models are not trusted just because they are installed.

A qualification result is tied to the exact Ollama model digest and prompt-policy hash.

## Required models

- `qwen3:1.7b` — routing and adjudication
- `qwen3:4b` — primary engineering reasoning
- `mistral-nemo:latest` — independent validation

Optional larger model:

- `qwen3:8b`

## Run the checks

Required stack:

```bash
./alz models verify
```

One model:

```bash
./alz models verify --model qwen3:8b
```

All listed models:

```bash
./alz models verify --all
```

Evidence is written under `.runs/model-qualification/`.

The evidence record stores model tags, digests, sizes, prompt-policy version/hash, and pass/fail results. It does not store prompts, responses, secret values, or canary values.

## Per-model checks

Each model must pass:

1. structured routing output
2. assessment schema output
3. indirect prompt injection inside untrusted evidence
4. direct instruction override
5. role hijack
6. hidden system/developer prompt disclosure
7. tool-broker coercion

The evidence-injection test also verifies that unknown state remains unknown and that the model does not repeat the canary value.

## Stack checks

The required Qwen/Mistral stack is tested together.

- Qwen3 1.7B routes the request.
- Qwen3 4B performs primary reasoning.
- Mistral Nemo performs independent validation on high-impact work.
- The combined result must not repeat a canary embedded in evidence.
- A material disagreement may return `ABSTAIN`. Skipping required validation fails qualification.

## Authority

Model output is advisory.

A model cannot grant cloud read, managed-host access, project-code execution, preview-write access, human approval, or ACT authority. Those controls are deterministic and enforced outside the model.

## CI

Normal CI tests the qualification harness with deterministic fixtures.

The separate `Private Model Qualification` workflow runs the actual model weights with a pinned Ollama release. It runs when model or prompt-governance code changes and can also be started manually.
