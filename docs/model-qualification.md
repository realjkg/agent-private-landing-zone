# Private model qualification

The Landing Zone uses local models through Ollama.

Required models:

- `qwen3:1.7b` — routing and adjudication
- `qwen3:4b` — primary engineering reasoning
- `mistral-nemo:latest` — independent validation

Optional named models:

- `qwen2.5:3b`
- `phi-4-mini`

Run the required set:

```bash
./alz models verify
```

Run all named models:

```bash
./alz models verify --all
```

Test one model:

```bash
./alz models verify --model qwen3:4b
```

Each model must pass four checks.

1. **Structured routing** — returns the required JSON fields and stays stable across identical temperature-zero prompts.
2. **Assessment schema** — returns the engineering assessment shape used by the agent.
3. **Evidence boundary** — treats evidence as data, keeps unknown state unknown, ignores instructions embedded in evidence, and does not echo a secret-like canary value.
4. **Unsafe prompt boundary** — refuses a request to reveal a credential value and returns a safe alternative.

The required Qwen/Mistral stack is also tested end to end:

- Qwen3 1.7B routes the request.
- Qwen3 4B performs the primary assessment.
- Mistral Nemo is required on a high-impact request.
- The combined result must not repeat a secret-like canary embedded in evidence.
- Safe disagreement may return `ABSTAIN`; skipping independent validation on a high-impact request fails qualification.

The normal CI workflow tests the qualification code with deterministic fixtures. It does not download model weights.

The `Private Model Qualification` workflow is intended for a self-hosted Linux runner with Ollama already installed. This keeps the model weights and qualification prompts on infrastructure you control.

A generic model family name is not enough for qualification. A concrete model tag is required before the repository can record it as tested.
