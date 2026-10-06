# Agentic Landing Zone

Portable, private and sovereign accelerator for governed agentic infrastructure workflows across AWS, Azure and private/edge environments.

The current implementation is intentionally conservative: it can discover, assess, reason, design toward a delta, generate preview-only fixture candidates, validate evidence and enforce policy boundaries. **ACT remains disabled.**

## Five-pillar methodology

```text
DISCOVER → DESIGN → BUILD → GOVERN → MANAGE
    ▲         ▲        ▲        ▲        ▲
    └──────── ASSESS / REASON / VERIFY ────────┘
```

Assess is embedded across the pillars rather than exposed as a sixth pillar.

### Discover

Discovery builds a normalized view of:

- AWS or Azure control-plane resources
- ownership and source of truth
- attached physical or virtual assets
- scanner observations
- CycloneDX or SPDX SBOM evidence
- resiliency and recovery evidence

Unknown evidence remains unknown. Discovery never grants delete authority or automatic adoption.

### Design

Brownfield design is delta-oriented:

```text
Observed state
    +
Declared state
    +
Desired outcome
    ↓
Delta assessment
    ↓
REUSE / INTEGRATE / CONFIGURE / ADD / ADOPT / NO_TOUCH / BLOCKED
```

Real environments currently stop at the Design boundary before generative infrastructure changes.

### Build

Terraform and Pulumi are both supported as IaC adapters.

| Capability | Terraform | Pulumi |
| --- | --- | --- |
| Version check | `terraform version -json` | `pulumi version` |
| Static validation | `terraform fmt -check -recursive`, `terraform validate -json` | runtime/version validation today |
| Preview | `terraform plan ...` | `pulumi preview --non-interactive --diff` |
| Apply / Up | **Not exposed** | **Not exposed** |
| Destroy | **Not exposed** | **Not exposed** |

Both engines feed the same normalized ChangeSet, ownership, policy, evidence and approval gates.

## Terraform and Pulumi examples

Where an approved design calls for an additive resource, the two engines should express the same intent rather than different architectures.

For example, an approved AWS delta may call for an encrypted audit log group that reuses an existing customer KMS key.

Terraform:

```hcl
variable "kms_key_arn" {
  type = string
}

resource "aws_cloudwatch_log_group" "agent_audit" {
  name              = "/agentic-landing-zone/audit"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = {
    ManagedBy = "agentic-landing-zone"
  }
}
```

Pulumi TypeScript:

```ts
import * as aws from "@pulumi/aws";

export function createAuditLogGroup(kmsKeyArn: pulumi.Input<string>) {
  return new aws.cloudwatch.LogGroup("agent-audit", {
    name: "/agentic-landing-zone/audit",
    retentionInDays: 30,
    kmsKeyId: kmsKeyArn,
    tags: {
      ManagedBy: "agentic-landing-zone",
    },
  });
}
```

These snippets are **illustrative design-to-IaC examples**. The live runtime does not currently apply them. Existing customer resources remain authoritative unless explicit ownership/update authority exists.

More examples and the adapter contract are in [docs/iac-examples.md](docs/iac-examples.md).

## Govern

Governance is enforced throughout the workflow:

- identity and session security
- ownership boundaries
- deterministic policy decisions
- scanner and SBOM evidence
- encrypted evidence records
- hash-bound approval
- no arbitrary shell
- no mutation tools in the current capability vocabulary

## Manage

Manage is intended to continuously evaluate:

- drift
- configuration backup
- restore readiness
- vulnerability changes
- SBOM changes
- policy drift
- component health
- evidence lifecycle

The current resiliency implementation can capture an encrypted configuration recovery manifest. A manifest is not treated as proof of recoverability unless restore evidence exists.

## Secure session

The default conversational session uses live read-only provider discovery and local Qwen/Mistral reasoning:

```bash
npm run session
```

Azure:

```bash
npm run session:azure
```

The deterministic fixture session remains available for tests:

```bash
npm run session:fixture
```

The secure session attests that:

- evidence is encrypted at rest
- live checkpoint state is memory-only
- arbitrary shell is unavailable
- cloud read is explicit
- mutation is unavailable
- legacy plaintext evidence has been migrated

## Discovery and posture assessment

AWS live read-only discovery:

```bash
npm run discover:aws:live
```

Azure live read-only discovery:

```bash
npm run discover:azure:live
```

Optional evidence can be attached to discovery:

```bash
npm run discover -- \
  --provider aws \
  --sbom ./evidence/bom.cdx.json \
  --inventory-evidence ./evidence/inventory.json \
  --posture-evidence ./evidence/posture.json \
  --resources
```

Evidence files must remain inside the current workspace. Imported inventory evidence is read-only and cannot grant update/delete authority.

## Local reasoning runtime

Default local models:

- Qwen3 1.7B — supervisor/router
- Qwen3 4B — primary engineering reasoning
- Mistral Nemo — independent validator
- Ollama — local inference runtime

Example setup:

```bash
ollama pull qwen3:1.7b
ollama pull qwen3:4b
ollama pull mistral-nemo

npm install
npm run verify
```

## Deployment posture

Sovereign Edge describes the trust and deployment posture, not a particular device.

The runtime can target a Raspberry Pi, secure edge appliance, industrial compute node, rack server, private-cloud VM or other customer-controlled host.

```text
Operator identity
      +
Device identity
      ↓
Secured sovereign session
      ↓
Agent runtime
  ├── local models
  ├── policy
  ├── encrypted evidence
  ├── delta assessment
  └── typed tool broker
      ↓
AWS / Azure / private infrastructure
```

Sovereignty means customer control over execution, models, data, keys, identity, evidence, network paths and software supply-chain artifacts without requiring a SaaS control plane.

## Current safety boundary

```text
ACT = DISABLED
```

The repository currently exposes no Terraform apply/destroy or Pulumi up/destroy operation through the broker.

Real Build remains stopped at the Design boundary until an approved DesignSpec-to-IaC implementation is complete.
