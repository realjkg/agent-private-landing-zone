# Agent Private Landing Zone

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

Design now produces an evidence-linked, hashable `DesignSpec` with the selected build plug-in, reuse/add/no-touch boundaries, security and resiliency controls, assumptions and evidence references. Real environments still stop before generative Build until the selected adapter is implemented and the DesignSpec has completed review/approval.

### Build

Verified preview adapters currently include Terraform, Pulumi, OpenTofu, Azure Bicep, and AWS CloudFormation.

| Adapter | Validation | Governed preview | Mutation |
| --- | --- | --- | --- |
| Terraform | fmt + validate | plan | apply/destroy not exposed |
| Pulumi | runtime/version today | preview | up/destroy not exposed |
| OpenTofu | fmt + validate | plan | apply/destroy not exposed |
| Bicep | lint + build with no automatic restore | Azure what-if with ResourceIdOnly | deployment not exposed |
| CloudFormation | validate-template | existing-stack UPDATE Change Set | execute-change-set not exposed |

All implemented adapters feed the same normalized ChangeSet, ownership, policy, evidence and approval gates. CloudFormation CREATE previews remain Design-only because AWS creates a `REVIEW_IN_PROGRESS` stack shell before execution.

### Build plug-in direction

The foundation is intended to support additional declarative/cloud-native build adapters without changing the governance plane:

- OpenTofu — implemented
- Azure Bicep — implemented
- AWS CloudFormation — implemented for existing-stack UPDATE previews
- AWS CDK through CloudFormation synthesis/change evidence
- Crossplane for Kubernetes/private/edge control planes
- Ansible under BUILD/CONFIGURE/MANAGE for brownfield operating-system, network, appliance and secure-edge configuration

**ARM JSON templates and PowerShell are not first-class build engines in this architecture.** For Azure, Bicep is the preferred declarative Azure-native authoring path. CLI tools may be invoked behind the typed broker as controlled transports, but CLI/scripting interfaces do not define the infrastructure model.

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
import * as pulumi from "@pulumi/pulumi";
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

## Operator experience

Day-to-day use is exposed through a small operator launcher rather than npm scripts:

```bash
./alz bootstrap
./alz doctor
./alz demo
./alz design aws terraform brownfield
./alz design aws cdk brownfield
./alz design aws ansible brownfield
./alz design azure bicep brownfield
./alz inspect aws
./alz session aws terraform
./alz plugins
./alz prompts
./alz sbom
./alz scan
./alz verify
```

The source checkout still uses Node tooling internally, but the operator does not need to know the underlying npm script graph. `./alz prompts` and conversational `help` / `prompt guide` provide built-in self-help for unfamiliar operators. See [docs/operator-guide.md](docs/operator-guide.md).

## Operator prompt safety

Every conversational request passes a deterministic operator boundary before local-model routing. The boundary refuses secret disclosure, private-data exfiltration, governance/audit bypass, arbitrary shell execution, and clearly out-of-scope first-turn activity.

Blocked requests are educational rather than opaque: the operator sees the boundary category, why it is disallowed, and the nearest safe reframe. Safe metadata questions remain available—for example, credential age/rotation posture without revealing secret values.

Use:

```bash
./alz prompts
```

or type `help`, `prompt guide`, or `why was that blocked?` in a session.

## Secure session

The default conversational session uses live read-only provider discovery and local Qwen/Mistral reasoning:

```bash
./alz session aws terraform
```

Azure:

```bash
./alz session azure pulumi
```

Inside a session, the operator can request a different path naturally. Terraform, Pulumi, OpenTofu, Bicep, and existing-stack CloudFormation UPDATE previews have verified adapters. CDK, Ansible, and Crossplane remain Design-only until their executable-project/controller isolation is implemented and verified.

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
./alz inspect aws
```

Azure live read-only discovery:

```bash
./alz inspect azure
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

./alz bootstrap
./alz verify
```

The source implementation uses Node/npm internally for dependency locking and SBOM generation, but operators use the `./alz` surface.

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

The repository currently exposes no Terraform apply/destroy, Pulumi up/destroy, CloudFormation execute-change-set, CDK deploy, Bicep deployment, OpenTofu apply, Crossplane mutation, or Ansible non-check execution through the broker.

Implemented preview adapters are Terraform, Pulumi, OpenTofu, Bicep, and existing-stack CloudFormation UPDATE Change Sets. CDK, Crossplane, and Ansible remain visible to Design but cannot execute until their stronger runtime isolation/preview contracts are implemented, scanned, and verified.
