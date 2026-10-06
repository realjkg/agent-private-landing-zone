# Adapt Cloud Agentic Landing Zone

Portable accelerator for governed agentic workloads that can run locally, in private cloud, sovereign-connected environments, or disconnected environments.

## Initial capability

This first cut implements a local agentic execution loop with:

- Qwen3 1.7B as the supervisory/router model
- Qwen3 4B as the primary reasoning model
- Mistral Nemo as an independent validator
- localhost Ollama as the inference runtime
- deterministic evidence gating and abstention behavior
- a CLI demo that can be run without public model APIs

The F1 prediction workload discussed during development is intentionally **not embedded into the core**. It belongs under an examples or capabilities layer so the accelerator remains reusable for Presidio and other customer environments.

## Architecture

```text
Request
  |
  v
Router / Supervisor
(qwen3:1.7b)
  |
  v
Policy + Evidence Gate
  |
  +--> DATA_REQUIRED / ABSTAIN
  |
  v
Primary Analysis
(qwen3:4b)
  |
  +------------------+
  |                  |
  v                  v
Independent      Validator
evidence         (mistral-nemo)
  |                  |
  +--------+---------+
           |
           v
      Adjudication
           |
           v
        Response
```

The validator does not receive the primary model's answer until the adjudication step.

## Local demo

Prerequisites:

- Node.js 20+
- Ollama running locally
- the following models pulled:

```bash
ollama pull qwen3:1.7b
ollama pull qwen3:4b
ollama pull mistral-nemo
```

Install and run:

```bash
cd agentic-landing-zone
npm install
npm run check
npm run demo -- "Summarize the strongest operational risk in a private agentic landing zone."
```

For a request that requires current evidence, supply a demo evidence snapshot:

```bash
DEMO_EVIDENCE="Validated snapshot: service health green; local inference latency 420ms." \
  npm run demo -- "Assess the current deployment risk."
```

The default inference endpoint is:

```text
http://127.0.0.1:11434
```

No hosted inference provider is required for the demo.

## Configuration

Copy `.env.example` values into your environment as needed:

```text
OLLAMA_BASE_URL=http://127.0.0.1:11434
ROUTER_MODEL=qwen3:1.7b
PRIMARY_MODEL=qwen3:4b
VALIDATOR_MODEL=mistral-nemo:latest
```

## Accelerator direction

The repository is intended to grow along these boundaries:

```text
agentic-landing-zone/
├── core/
│   ├── orchestration/
│   ├── policy/
│   ├── evidence/
│   ├── inference-gateway/
│   └── observability/
├── providers/
│   ├── aws/
│   ├── azure/
│   ├── azure-local/
│   └── on-prem/
├── runtimes/
│   ├── ollama/
│   ├── vllm/
│   └── foundry-local/
├── profiles/
│   ├── private/
│   ├── sovereign-connected/
│   └── sovereign-disconnected/
└── examples/
```

## Presidio use

The goal is a cloneable reference implementation that can be bound to approved infrastructure and models without rewriting the governance plane.

Typical flow:

```text
clone accelerator
  -> select deployment profile
  -> bind approved inference runtime
  -> attach customer capability
  -> observe / evaluate
  -> promote through production controls
```

## Next increments

- LangGraph state-machine implementation
- LangSmith self-hosted/BYOC tracing and eval hooks
- provider adapters for Azure Local / Foundry Local and AWS private inference
- immutable evidence snapshots and audit metadata
- capability plug-in contract
- CI regression tests for routing, abstention, disagreement, and privacy boundaries
