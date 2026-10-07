# Operator guide

The Agent Private Landing Zone has an operator-facing command surface so normal use does not require remembering npm scripts.

## First-time source checkout

From the repository root:

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
./alz prompts
./alz models list
./alz models verify
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

All eight build adapters are implemented. CDK reuses the CloudFormation Change Set path. Ansible uses check/diff with explicit managed-host access. Crossplane uses local render and keeps changes UNKNOWN until controller reconciliation is observed.

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

### prompts

Shows the built-in prompt guide for unfamiliar operators:

```bash
./alz prompts
```

The same guide is available conversationally by typing `help` or `prompt guide`.

Requests are checked before local-model routing. The operator is redirected when a prompt asks to reveal credentials/secrets, move private evidence outside the trust boundary, bypass approvals/policy/audit/security controls, invoke arbitrary shell execution, or perform clearly unrelated work outside the Landing Zone scope.

A denied request includes a plain-language reason and a safe alternative. For example, instead of asking for a secret value, ask for its owner, scope, age, reference, or rotation posture without revealing the value. Instead of asking to bypass an approval, ask which control is blocking progress and what evidence or authorized change would satisfy it.

After a denial, `why was that blocked?` explains the recorded boundary, while `prompt guide` shows working examples.

### models

Lists or qualifies the local private models:

```bash
./alz models list
./alz models verify
./alz models verify --all
```

The default qualification set is Qwen3 1.7B, Qwen3 4B, and Mistral Nemo. The optional set also includes Qwen2.5 3B and Phi-4 Mini. The checks cover JSON structure, repeatability, evidence isolation, and refusal to echo secret-like values.

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
- private-model qualification harness tests

### sbom

Generates a CycloneDX SBOM from the locked dependency graph and writes it under `.runs/sbom/`.

### scan

Runs the package dependency audit. If Trivy is installed locally it also scans the accelerator filesystem for HIGH/CRITICAL vulnerabilities and infrastructure misconfigurations. CI always runs the full Trivy scan.

## Scenario coverage

| Scenario | Discover | Assess | Delta | Design | Build | ACT |
| --- | --- | --- | --- | --- | --- | --- |
| AWS brownfield | live read-only + fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, CloudFormation UPDATE, CDK, Ansible, Crossplane | disabled |
| AWS greenfield | fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, CDK synthesis; CloudFormation CREATE remains Design-only | disabled |
| Azure brownfield | live read-only + fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, Bicep, Ansible, Crossplane | disabled |
| Azure greenfield | fixture | supported | supported | DesignSpec | Terraform, Pulumi, OpenTofu, Bicep, Crossplane | disabled |
| Private/edge attached assets | evidence ingestion | supported | supported | DesignSpec | Ansible and Crossplane preview paths | disabled |
| Sovereign/disconnected | evidence ingestion | supported | supported | DesignSpec | local/offline preview where adapter dependencies are present | disabled |

Preview support does not mean deployment authority. ACT remains disabled.

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
