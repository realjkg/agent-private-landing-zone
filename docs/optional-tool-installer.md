# Optional infrastructure and security CLI installation

This is a **macOS CLI capability installer**, not a cloud bootstrapper. Crossplane's CLI is distinct from the Kubernetes Crossplane controller; `crossplane` installed locally does not imply a working Kubernetes cluster or a reconciled control plane. `brew install docker` supplies the Docker CLI, not a Docker engine.

## Capabilities and review policy

| Optional tool | ALZ dependency ID | Reviewed adapter/tool version | Installation lane | Reason |
|---|---|---:|---|---|
| Crossplane CLI | `product:crossplane` | 2.5.0 | Homebrew when formula version exactly matches | CLI-only: no Kubernetes/Helm/controller install |
| OpenTofu | `product:tofu` | 1.13.1 | Homebrew when formula version exactly matches | Separate IaC engine and no `apply` |
| Trivy | `product:trivy` | 0.75.0 | Homebrew when formula version exactly matches | CLI scanner; image DB/network is a separate permission |
| Pulumi | `product:pulumi` | 3.267.0 | Homebrew only on exact version match | Public formula version can drift from reviewed plugin version; refuse instead of auto-upgrading |
| AWS CDK | `product:cdk` | 2.1144.0 | Homebrew only on exact version match | CLI and `aws-cdk-lib` have independent versions; no project-code execution granted |
| Bicep | `product:bicep` | 0.47.16 | Manual review | Azure Homebrew tap and standalone Bicep require separate trust/pinning qualification |
| Ansible | `product:ansible-playbook` | core 2.21.5 | Manual security/version review | Homebrew's Ansible *distribution* version is not the ansible-core version; dependencies and advisories require review |
| Docker | `product:docker` | 29.8.2 | Manual engine/runtime review | Installing a Docker CLI does not supply Docker Desktop/daemon, which has separate approvals/licensing |

Official source references: [Crossplane CLI](https://docs.crossplane.io/cli/latest/), [Homebrew Crossplane](https://formulae.brew.sh/formula/crossplane), [OpenTofu Homebrew](https://opentofu.org/docs/v1.8/intro/install/homebrew/), [Trivy Homebrew](https://www.trivy.dev/docs/latest/getting-started/installation/), [Pulumi](https://formulae.brew.sh/formula/pulumi), [AWS CDK](https://formulae.brew.sh/formula/aws-cdk), [Microsoft Bicep](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/install), [Ansible](https://formulae.brew.sh/formula/ansible).

## Guided terminal path

From your repository's parent directory:

```sh
cd agent-private-landing-zone
npm run build
./alz
```

Choose **Dependencies → Install optional CLI** and select a tool. For eligible formulae, the installer:
1. Checks that a genuine local Homebrew command exists at a fixed macOS path (does not evaluate the ambient PATH or a user-supplied executable).
2. Reads the locally installed formula metadata using an argv-only subprocess with no shell, and compares the stable formula version with the ALZ-reviewed baseline; disabled or deprecated formulae are rejected.
3. Checks for an already installed formula and refuses silent upgrade/replacement.
4. Displays a package-specific `INSTALL <FORMULA> <VERSION>` human confirmation. Anything else skips. Running on noninteractive input also skips.
5. Executes only the approved allowlisted `brew install --formula <formula>`, then checks Homebrew's installed package version again. Homebrew auto-update is disabled inside this command to reduce version drift.

**Homebrew formulae are NOT ALZ's standalone SHA-256 pinned archives.** Homebrew still resolves its own artifacts and executes its own formula logic, and this code does not independently verify downloaded bottle hashes. A successful install therefore only means the selected formula version is present, not that the installed binary has passed the adapter's security or preview qualification. Terraform and Ollama continue to use the independent, SHA-256 pinned ALZ installer.

This flow does **not** install Kubernetes controllers, Docker Desktop, cloud login tools, Git, Terraform plugins, project code, or any background services. It does not ask for cloud credentials and never invokes infrastructure mutation.

## Agent simulation

```sh
./node_modules/.bin/tsx --test test/optional-tool-installer.test.ts
./node_modules/.bin/tsx scripts/installer-agent-journeys.ts --json
```

The existing simulator now reports 293 existing onboarding/auth/ACT cases **plus 80 optional-tool installation cases** (8 tools x 10 paths): successful synthetic installation, cancel, non-TTY, missing Homebrew, version drift, malformed formula response, formula identity mismatch, already installed, package-manager failure and post-install verification failure. All Homebrew invocations in tests use a disconnected injected fake runner. Results are labeled `DISCONNECTED_OPTIONAL_INSTALL_FIXTURE` and include a deterministic SHA-256 evidence digest; no actual Homebrew, cloud, model or ACT commands run during the tests.

Real release qualification, version metadata freshness, Apple Silicon visual acceptance, cross-provider environment isolation and the actual installation packaging/rollback work remain in [Issue #149](https://github.com/realjkg/agent-private-landing-zone/issues/149).
