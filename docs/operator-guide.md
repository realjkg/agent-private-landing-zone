# Operator guide

The Agentic Landing Zone has an operator-facing command surface so normal use does not require remembering npm scripts.

## First-time source checkout

From the `agentic-landing-zone` directory:

```bash
./alz bootstrap
```

This installs the locked runtime dependencies. After bootstrap, use `./alz` for day-to-day operation.

## Common commands

```bash
./alz help
./alz doctor
./alz demo
./alz design aws terraform brownfield
./alz design aws cdk brownfield
./alz design aws ansible brownfield
./alz design azure bicep brownfield
./alz inspect aws
./alz inspect azure
./alz session aws terraform
./alz session azure pulumi
./alz plugins
./alz sbom
./alz scan
./alz verify
```

### demo

Runs a deterministic, non-mutating scenario through the governed kernel:

```bash
./alz demo aws terraform brownfield
./alz demo azure pulumi greenfield
```

The demo exercises discovery, posture assessment, brownfield delta decisions, an evidence-linked DesignSpec, plug-in selection and the Build boundary. It does not modify infrastructure.

### design

Runs the same governed deterministic path with Design as the explicit operator goal:

```bash
./alz design aws terraform brownfield
./alz design aws pulumi brownfield
./alz design aws cdk brownfield
./alz design aws ansible brownfield
./alz design azure bicep brownfield
```

Terraform and Pulumi are currently implemented preview adapters. CDK, Bicep, OpenTofu, CloudFormation, Crossplane and Ansible can be selected and reviewed in Design but remain blocked from Build execution until their adapters are implemented and verified.

### inspect

Runs live read-only provider discovery:

```bash
./alz inspect aws
./alz inspect azure
```

### session

Starts the secured conversational operator session with local model reasoning:

```bash
./alz session aws terraform
./alz session azure pulumi
```

### doctor

Checks the local security preflight, plug-in compatibility catalog and toolbox availability.

### verify

Runs the operator regression suite without requiring the operator to know individual developer commands. It covers:

- TypeScript checks
- all unit/regression tests
- security preflight
- plug-in compatibility
- toolbox availability
- AWS brownfield discovery fixture
- Azure brownfield discovery fixture
- Azure greenfield discovery fixture
- unknown-environment fail-closed behavior
- dependency security audit

### sbom

Generates a CycloneDX SBOM from the locked dependency graph and writes it under `.runs/sbom/`.

### scan

Runs the package dependency audit. If Trivy is installed locally it also scans the accelerator filesystem for HIGH/CRITICAL vulnerabilities and infrastructure misconfigurations. CI always runs the full Trivy scan.

## Scenario coverage

| Scenario | Discover | Assess | Delta | Design | Build | ACT |
| --- | --- | --- | --- | --- | --- | --- |
| AWS brownfield | live read-only + fixture | supported | supported | DesignSpec | Terraform/Pulumi fixture preview; other adapters planned | disabled |
| AWS greenfield | fixture | supported | supported | DesignSpec | Terraform/Pulumi fixture preview; other adapters planned | disabled |
| Azure brownfield | live read-only + fixture | supported | supported | DesignSpec | Terraform/Pulumi fixture preview; Bicep planned | disabled |
| Azure greenfield | fixture | supported | supported | DesignSpec | Terraform/Pulumi fixture preview; Bicep planned | disabled |
| Private/edge attached assets | evidence ingestion | supported | supported | DesignSpec | Ansible/Crossplane/private adapters planned | disabled |
| Sovereign/disconnected | evidence ingestion | supported | supported | DesignSpec | signed/offline adapter bundle planned | disabled |

Private/edge is intentionally not labeled executable Build support yet. Physical and virtual assets already participate in inventory, scanner, SBOM, resiliency, delta assessment and DesignSpec generation. Ansible is now part of the Build/Configure/Manage plug-in contract for those scenarios, but its execution adapter remains planned.

## Maintenance

Every relevant pull request and push runs the supply-chain workflow:

1. locked dependency install
2. compile and regression tests
3. plug-in compatibility validation
4. dependency audit
5. CycloneDX SBOM generation
6. Trivy vulnerability/misconfiguration scan
7. evidence artifact upload

A weekly scheduled run catches newly disclosed vulnerabilities even when source code has not changed.

Dependabot separately opens update PRs for npm dependencies and GitHub Actions. The plug-in catalog tracks tested versions and review freshness for infrastructure engines.
