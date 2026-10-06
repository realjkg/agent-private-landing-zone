# Build plug-in examples

Terraform and Pulumi are the currently implemented preview adapters. OpenTofu, Bicep, CloudFormation, AWS CDK, Crossplane and Ansible participate in the same DesignSpec contract and are enabled for execution only after their adapters are implemented and verified.

Every Build plug-in consumes the same reviewed DesignSpec and must produce change evidence that can be normalized into the same governance gates.

## Adapter behavior today

### Terraform

The Terraform adapter currently performs:

```text
terraform version -json
terraform fmt -check -recursive
terraform validate -json
terraform plan -input=false -lock=false -refresh=false -out=.agentic-preview.tfplan
```

There is no allowlisted `terraform apply` or `terraform destroy`.

### Pulumi

The Pulumi adapter currently performs:

```text
pulumi version
pulumi preview --non-interactive --diff
```

There is no allowlisted `pulumi up` or `pulumi destroy`.

Pulumi static validation is currently intentionally minimal compared with Terraform and should not be described as equivalent until additional language/runtime validation is wired into the governed toolbox.

## Brownfield rule

The IaC engine does not determine ownership.

For an existing resource:

```text
MANAGED_BY_CUSTOMER      → REUSE / NO_TOUCH
MANAGED_BY_OTHER_IAC     → REUSE / NO_TOUCH
MANAGED_BY_ACCELERATOR   → INTEGRATE
ADOPTED + explicit grant → CONFIGURE
UNKNOWN                  → BLOCKED
```

A design can reference a customer-owned VPC, KMS key, subnet, logging destination or policy boundary without taking ownership of it.

If modification is required, the delta assessment must surface that requirement before IaC generation.

## AWS example: additive encrypted audit logging

Assume Design has already concluded:

```text
Existing KMS key    REUSE
Existing landing zone REUSE
Audit log group     ADD
```

### Terraform

```hcl
variable "kms_key_arn" {
  description = "Existing customer-managed KMS key ARN"
  type        = string
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

### Pulumi TypeScript

```ts
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export function createAuditLogGroup(
  kmsKeyArn: pulumi.Input<string>,
) {
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

The existing KMS key is referenced, not imported or adopted.

## Azure example: additive resource group for an approved workload

Assume Design has already concluded:

```text
Management hierarchy  REUSE
Existing policy       REUSE / CONFORM
Workload resource group ADD
```

### Terraform

```hcl
variable "location" {
  type = string
}

resource "azurerm_resource_group" "agent_workload" {
  name     = "rg-agentic-workload"
  location = var.location

  tags = {
    managed-by = "agentic-landing-zone"
  }
}
```

### Pulumi TypeScript

```ts
import * as azure from "@pulumi/azure-native";

export function createWorkloadResourceGroup(location: string) {
  return new azure.resources.ResourceGroup(
    "agent-workload",
    {
      resourceGroupName: "rg-agentic-workload",
      location,
      tags: {
        "managed-by": "agentic-landing-zone",
      },
    },
  );
}
```

Again, these examples illustrate equivalent design intent. They do not imply that the current live Build node is permitted to generate or apply this infrastructure.

## Preview and normalized change evidence

The target workflow is:

```text
Reviewed DesignSpec
      ↓
selected Build plug-in
      ↓
plan / preview / what-if / change-set / check-diff
      ↓
Normalized ChangeSet
      ↓
ownership + policy + scanner gates
      ↓
hash-bound approval
```

The normalized ChangeSet intentionally retains only the minimum change metadata needed for governance:

```ts
{
  engine: "TERRAFORM" | "PULUMI",
  resources: [
    {
      address: "...",
      type: "...",
      operation: "CREATE" | "UPDATE" | "DELETE" | "REPLACE" | "READ" | "SAME" | "UNKNOWN"
    }
  ],
  creates: 0,
  updates: 0,
  deletes: 0,
  replacements: 0,
  destructive: false,
  evidenceHash: "..."
}
```

Raw secret-bearing plan or preview values should not become durable evidence.

## When not to show both engines

Documentation should not force Terraform/Pulumi parity where it is misleading.

Examples:

- Terraform-specific provider locking belongs in Terraform documentation.
- Pulumi language/runtime validation belongs in Pulumi documentation.
- Existing customer ownership/source-of-truth rules are engine-neutral.
- Discovery, Assess, Design, Governance and encrypted evidence are engine-neutral.
- Build examples should show both only when the same DesignSpec can reasonably be implemented by either engine.

That keeps the methodology consistent without pretending the tools are identical.


## Plug-in eligibility

A build plug-in should fit the same foundation contract:

```text
Approved DesignSpec
      ↓
declarative engine adapter
      ↓
validate / synthesize
      ↓
preview / change evidence
      ↓
Normalized ChangeSet
      ↓
governance gates
```

Registered Build paths:

| Plug-in | Primary scope | Governed preview/change evidence |
| --- | --- | --- |
| Terraform | AWS, Azure, private | plan |
| Pulumi | AWS, Azure, private, Kubernetes | preview |
| OpenTofu | AWS, Azure, private | plan |
| Bicep | Azure | what-if |
| CloudFormation | AWS | Change Set |
| AWS CDK | AWS | synth → CloudFormation Change Set |
| Crossplane | Kubernetes/private/edge | controller/composition preview contract |
| Ansible | private/edge/OS/network/appliance plus bounded cloud configuration | check + diff |

Ansible participates in BUILD/CONFIGURE/MANAGE. Its Build role is appropriate when the desired delta is configuration/reconciliation of an existing estate rather than creation of a new cloud control plane.

### Explicit exclusions

ARM JSON templates are not planned as a first-class authoring plug-in. Azure-native declarative design should target Bicep instead.

PowerShell is not a first-class infrastructure language in this architecture. Where a provider CLI or script is unavoidable, it may run only as an allowlisted broker tool with typed inputs, bounded outputs and no arbitrary shell access.

This distinction keeps the architecture centered on portable declarative intent rather than CLI-centric automation.


## AWS CDK design path

CDK remains a first-class AWS authoring choice without creating a second AWS governance model:

```text
DesignSpec
   ↓
CDK source + dependency SBOM
   ↓
cdk synth
   ↓
CloudFormation template security scan
   ↓
CloudFormation Change Set
   ↓
Normalized ChangeSet
```

Automatic import/adoption of existing resources is not permitted. Existing resources remain REUSE/INTEGRATE unless the DesignSpec contains explicit adoption authority.

## Ansible design path

Ansible is used when Design concludes that an existing host, appliance, network service or edge node should be configured rather than replaced.

Illustrative playbook:

```yaml
- name: Configure governed edge logging
  hosts: edge_nodes
  become: true
  tasks:
    - name: Ensure audit service is enabled
      ansible.builtin.service:
        name: auditd
        enabled: true
        state: started
```

The governed preview path is:

```text
DesignSpec
   ↓
inventory + role/collection SBOM
   ↓
syntax/lint/security scan
   ↓
ansible-playbook --check --diff
   ↓
Normalized ChangeSet
   ↓
ownership + policy + approval gates
```

A module that cannot provide meaningful check-mode behavior must be marked unsupported or require an explicit higher-assurance review; the agent must not treat an optimistic check result as proof that a future run is safe.
