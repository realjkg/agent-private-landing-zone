# Full AWS/Azure offline qualification — Layer 1 then Layer 2

The supported application scope is AWS and Azure, eight implemented adapters, three estate classifications (greenfield, brownfield, UNKNOWN). Preserve existing policy, typed broker, compromise lifecycle, evidence lineage, and no unrestricted ACT.

## Layer 1: deterministic contract and fault coverage

| Adapter | AWS greenfield | AWS brownfield | Azure greenfield | Azure brownfield |
| --- | --- | --- | --- | --- |
| Terraform | Fixture preview | Fixture preview | Fixture preview | Fixture preview |
| Pulumi | Fixture preview | Fixture preview | Fixture preview | Fixture preview |
| OpenTofu | Fixture preview | Fixture preview | Fixture preview | Fixture preview |
| AWS CDK | Design-only denial | Fixture preview | N/A | N/A |
| CloudFormation | Design-only denial | Fixture preview | N/A | N/A |
| Bicep | N/A | N/A | Fixture preview | Fixture preview |
| Crossplane | Fixture preview | Fixture preview | Fixture preview | Fixture preview |
| Ansible | Fixture preview | Fixture preview | Fixture preview | Fixture preview |

Every compatible provider/adapter pairing adds an **UNKNOWN ownership denial**. The full provider catalog produces 78 labeled combinations: 24 positive preview scenarios, 13 unknown-ownership denials, two existing-stack-only greenfield denials, nine unsupported pairs recorded **N/A**, and 30 advertised Private/Kubernetes/Edge cases marked **PLAN_REQUIRED**, never invoked.

Every positive scenario is run through direct kernel and conversational LangGraph, all eleven applicable synthetic chaos conditions and seven Well-Architected policy postures. The source-bound report records individual expected/observed verdicts, evidence hashes, runner classifications and live-stage NOT_RUN markers. Operational Excellence UNKNOWN is a recorded assessment, not proof of acceptable operating practice.

## Execute and inspect

From a clean source checkout:

```sh
npm ci && npm run build
node dist/cli/full-offline-matrix.js
```

Writes both JSON and CSV under `.runs/qualification/full-offline-matrix/` with exact source SHA and per-row SHA256. No model download, provider connection, cloud mutation or Terraform/Pulumi deployment.

CI checks the in-memory matrix and negative conditions. A passing assertion does not prove the CLI produced retained artifacts unless the artifact is actually captured. Do not mark Layer 1 complete until full matrix tests pass on the exact source revision. No N/A case is sent to an agent or provider.

## Layer 2: actual local providers and private models against synthetic estates

Layer 2 is a **separate qualification campaign** with real Ollama Qwen/Mistral inference and native IaC tools/SDK preview where available, but versioned synthetic/replayed AWS/Azure inventories. Model digests, tool versions and target host are required. Synthetic discovery evidence cannot satisfy a cloud-authentication gate. Example tools include Terraform/OpenTofu validate/plan replay, Pulumi program execution with replay/mock providers, CDK synth/CloudFormation validate, Bicep build/lint, Crossplane render against local controller schemas, and Ansible check/diff against disposable local hosts. If an executable or model is unavailable, record NOT_RUN; do not substitute a fixture and call it real.

Layer 2 must run only after Layer 1 passes. Run outputs must be stored with source, tool/model/fixture/preview digests, pillar and chaos evidence; no generic Terraform apply, Pulumi up, CDK deploy or broad-write identity. Maintain the four externally leased ACT operations under a separate approved boundary only.

**Production scope:** Layer 1 and Layer 2 can support an independently approved **offline/private-preview** release claim. They do not qualify customer AWS/Azure access, production-grade DR RPO/RTO, real cloud economics or deployment-specific external action handlers.
