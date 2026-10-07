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

The required set is Qwen3 1.7B, Qwen3 4B, and Mistral Nemo. Qwen3 8B is the optional larger model. Qualification checks structured output, repeatability, evidence isolation, indirect prompt injection inside untrusted evidence, and secret-canary leakage. Direct override, role hijack, hidden-prompt disclosure, and tool-coercion attempts are rejected by the deterministic operator boundary before model invocation.

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

Runs the package dependency audit. If Trivy is installed locally it also scans the accelerator filesystem for HIGH/CRITICAL vulnerabilities and infrastructure misconfigurations. The full Trivy/SBOM supply-chain workflow is an explicit release gate rather than an automatic per-PR or per-merge job.

## Agent-assisted build sequence

The simulated landing-zone build program is exercised through chat as well as direct adapter invocation.

A normal guided sequence is:

1. **Intent** — describe the platform outcome in natural language.
2. **Discover** — inspect or load the simulated estate and identify known vs UNKNOWN evidence.
3. **Assess** — review security, resiliency, ownership, and operational constraints.
4. **Design** — explain the delta using REUSE / INTEGRATE / CONFIGURE / ADD / NO_TOUCH / BLOCKED decisions.
5. **Adapter selection** — choose or compare the preview adapter for the scenario.
6. **Build preview** — generate the governed, non-mutating adapter preview.
7. **Evidence review** — review the normalized ChangeSet, hashes, assumptions, grants, and safety blocks.
8. **Next step** — explain what would be required to proceed while keeping ACT disabled.

The operator can ask follow-ups such as `status`, `what should we do next?`, `why was that blocked?`, `compare IaC`, or request a different supported preview engine.

This is **agent-assisted**, not autonomous deployment. The conversational agent guides the build process, but deterministic policy and capability gates remain authoritative.

For simulated adapter qualification, compare the direct adapter result with the chat-guided result. They should converge on materially consistent design intent and normalized ChangeSet semantics.

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

Routine pull requests use the fast deterministic gate:

1. locked dependency install
2. TypeScript type-check
3. unit/integration tests
4. plug-in catalog/runtime consistency

Heavyweight qualification is reserved for actual release needs.

The private-model workflow and the full supply-chain workflow are manual release gates. They are not automatically started by every pull request or merge to `main`.

Use existing qualification evidence when the runtime under release has not changed. Run the required Qwen/Mistral model gate, optional Qwen3 8B gate, SBOM/Trivy scan, or broader release scenarios only when the release phase materially requires fresh evidence.

Dependabot separately opens update PRs for npm dependencies and GitHub Actions. The plug-in catalog tracks tested versions and review freshness for infrastructure engines.
