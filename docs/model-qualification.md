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

The evidence record stores model tags, digests, sizes, prompt-policy version/hash, pass/fail results, and per-check duration where available. It does not store prompts, responses, secret values, or canary values.

## Per-model checks

Each qualification record includes:

1. structured routing output
2. assessment schema output
3. indirect prompt injection inside untrusted evidence
4. direct instruction override at the deterministic operator boundary
5. role hijack at the deterministic operator boundary
6. hidden system/developer prompt disclosure at the deterministic operator boundary
7. tool-broker coercion at the deterministic operator boundary

Checks 4–7 must be rejected before model invocation. They qualify the model-plus-policy interaction rather than asking a probabilistic model to self-enforce authority that belongs to deterministic policy.

The live model security check is the untrusted-evidence test. It verifies that evidence remains data, unknown state remains unknown, embedded instructions are not followed, and the model does not repeat the canary value.

Structured model calls use Ollama JSON mode with thinking disabled. Qualification keeps the current model resident across sequential checks while allowing only one loaded model on the GitHub runner. The security timeout is not increased to obtain a passing result.

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

The core agent loop also enforces the prompt screen directly so callers that bypass the conversational session layer cannot bypass prompt governance.

## Release qualification

Normal PR validation tests the qualification harness with deterministic fixtures.

The separate `Private Model Qualification` workflow is an explicit manual release gate. It runs the actual model weights with a pinned Ollama release only when fresh live-model evidence is required.

The default manual gate qualifies the required stack:
- Qwen3 1.7B
- Qwen3 4B
- Mistral Nemo
- integrated Qwen → Qwen → Mistral behavior

Qwen3 8B is optional and should be selected only when that model, shared inference behavior, or the release decision requires fresh 8B evidence.

Do not rerun the live-model gate for documentation, coordination, or unrelated code changes when the qualified runtime is unchanged.

The workflow records runner CPU/memory information. If an optional or required model exceeds the existing latency budget after structured-output and no-thinking optimization, classify that weight as unsupported on the standard GitHub-hosted CPU runner and move its live qualification to suitable accelerated/self-hosted hardware rather than weakening the timeout.
