# ALZ functional scenario matrix — existing adapters

This milestone makes the existing eight Phase E application landing-zone scenarios measurable and reproducible. It does **not** enable infrastructure ACT, install any model, introduce an adapter, change provider scope or loosen policy.

## Coverage

| Scenario | Provider | Existing IaC engine | Estate |
| --- | --- | --- | --- |
| terraform-aws-brownfield | AWS | Terraform | Brownfield |
| opentofu-aws-brownfield | AWS | OpenTofu | Brownfield |
| cloudformation-aws-existing | AWS | CloudFormation | Brownfield |
| cdk-aws-brownfield | AWS | AWS CDK | Brownfield |
| ansible-existing-hosts | AWS | Ansible | Brownfield |
| crossplane-local-render | AWS | Crossplane | Brownfield |
| pulumi-azure-greenfield | Azure | Pulumi | Greenfield |
| bicep-azure-brownfield | Azure | Bicep | Brownfield |

The authoritative scenario list is `src/qualification/phase-e.ts`. The matrix runs each in direct agent-kernel and conversational LangGraph modes; results must agree materially on DesignSpec, policy, artifact and preview hashes.

## Execute

Offline, deterministic simulated evidence (no local model calls):
```sh
npm ci && npm run build
node dist/cli/private-agent-matrix.js --offline-fixture
```

On an approved local host with Ollama loopback, installed Qwen3 1.7B, Qwen3 4B and Mistral Nemo:
```sh
node dist/cli/private-agent-matrix.js --live-models
```

For a bounded single scenario before running all eight:
```sh
node dist/cli/private-agent-matrix.js --live-models --scenario terraform-aws-brownfield
```

Successful **live mode** means real local models took part in supervisory routing, independent risk assessments and adjudication for each scenario, and the existing framework produced evidence-linked simulated Build previews without infrastructure mutation. A live-model assessment **does not** mean the generated IaC originated from the models: the existing `runBuildLoop` uses `generateMockArtifact`. The matrix records this origin explicitly as `FIXTURE_GENERATOR`.

Scenario 01 additionally supports a *strictly constrained model-proposed ADD* reviewed by both Qwen and Mistral, converted to deterministic Terraform HCL and optionally validated/planned with actual Terraform:
```sh
node dist/cli/qualify-aws-terraform-agent.js --live-models
```

No CI result or fixture test can stand in for executing real model inference on target hardware. No claims of live AWS discovery or real Terraform provider preview are made without their own execution evidence.

## Test expectations

- Eight distinct supported scenarios; direct and conversational parity.
- All stages remain preview-only and ACT disabled.
- Unknown ownership and unsupported combinations fail closed.
- Missing local models, invalid SHA or independent model disagreement cannot produce a success report.
- Evidence report includes exact source commit, model role/tag/digest where live, per-scenario hashes and status and the explicit limitation of fixture-generated IaC.
- Reports are stored under `.runs/qualification/private-agent-matrix/` with mode 0600.
- Don't run repeated full CI for documentation-only updates.

## Follow-on acceptance

Model-authored IaC generation through governed adapters, actual Terraform/Bicep/etc. tool validation and any real provider plan are separate acceptance gates. A passing matrix is **not** a production deployment or security release qualification. Do not combine unsupported provider/engine pairs into the success count.
