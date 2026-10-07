# Sovereign Agent Private Landing Zone

Portable, private and sovereign accelerator for governed agentic infrastructure workflows across AWS, Azure and private/edge environments.

The current implementation is intentionally conservative: it can discover, assess, reason, compile governed recovery intent, design toward a delta, generate preview-only candidates across all eight registered adapters, automate recovery evidence/verification workflows, and enforce policy boundaries. **ACT remains disabled.**

## Five-pillar methodology

```text
DISCOVER → DESIGN → BUILD → GOVERN → MANAGE
    ▲         ▲        ▲        ▲        ▲
    └──────── ASSESS / REASON / VERIFY ────────┘
```

Assess is embedded across the pillars rather than exposed as a sixth pillar.

Engineering and orchestration use one deterministic sequence:

```text
PLAN → parallel DO → CONVERGE / VERIFY → single ACT boundary
```

Parallel work is limited to non-overlapping DO scopes. Infrastructure ACT remains disabled.

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

Implemented preview adapters cover all eight registered build paths.

| Adapter | Validation | Governed preview | Important limit |
| --- | --- | --- | --- |
| Terraform | fmt + validate | plan | apply/destroy are not exposed |
| Pulumi | runtime/version | preview | project-code execution must be granted |
| OpenTofu | fmt + validate | plan | apply/destroy are not exposed |
| Bicep | lint + build | Azure what-if | deployment is not exposed |
| CloudFormation | validate-template | existing-stack UPDATE Change Set | CREATE preview remains Design-only |
| AWS CDK | synth + CloudFormation validation | temporary CloudFormation Change Set | project-code, cloud-read, and preview-write grants are required |
| Ansible | syntax check | check + diff | managed-host and project-code grants are required; check mode is not proof of runtime behavior |
| Crossplane | validate | local render | rendered resources remain UNKNOWN until controller reconciliation is observed |

All adapters feed the same normalized ChangeSet, ownership, policy, evidence, and approval gates.

### Build plug-ins

The current build plug-ins are Terraform, Pulumi, OpenTofu, Bicep, CloudFormation, AWS CDK, Crossplane, and Ansible.

CDK reuses the CloudFormation evidence path rather than creating a second AWS change model. Ansible is used for bounded configuration work on existing systems. Crossplane render output is treated conservatively until a controller has reconciled it.

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
  name              = "/agent-private-landing-zone/audit"
  retention_in_days = 30
  kms_key_id        = var.kms_key_arn

  tags = {
    ManagedBy = "agent-private-landing-zone"
  }
}
```

Pulumi TypeScript:

```ts
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export function createAuditLogGroup(kmsKeyArn: pulumi.Input<string>) {
  return new aws.cloudwatch.LogGroup("agent-audit", {
    name: "/agent-private-landing-zone/audit",
    retentionInDays: 30,
    kmsKeyId: kmsKeyArn,
    tags: {
      ManagedBy: "agent-private-landing-zone",
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

The resiliency implementation now supports compiled recovery targets, unattended capture/verify/drill/drift cycles, explicit AWS/Azure provider-recovery evidence classification, encrypted evidence, and read-only conversational inspection of automated target state. A manifest is still not treated as a backup, and provider-native recovery is only claimed when explicit provider evidence exists.

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
./alz target init <target-id> <owner> <aws|azure> <scope-id> <startup|enterprise> <development|production> <non-critical|business|critical>
./alz target check <intent-file>
./alz target explain <intent-file>
./alz recovery status [target-file]
./alz recovery test [target-file]
./alz plugins
./alz prompts
./alz models list
./alz models verify
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

Inside a session, the operator can request any registered build path. All eight adapters are implemented. Their capability gates still apply. No adapter can mutate infrastructure.

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
./alz models verify
```

`./alz verify` tests the model qualification harness with deterministic fixtures. `./alz models verify` tests the installed Qwen and Mistral weights against the local Ollama endpoint. Use `./alz models verify --all` to include the optional named models.

See [docs/model-qualification.md](docs/model-qualification.md) for the exact checks. Additional private-model candidates are tracked separately for architecture fit; they are not part of the active runtime until they complete the same qualification contract.

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

All eight preview adapters are implemented and have completed the Phase E direct-versus-LangGraph simulated convergence qualification. ACT remains disabled. Adapter-specific capability grants control what can be previewed, and none of those grants enable deployment or mutation.
