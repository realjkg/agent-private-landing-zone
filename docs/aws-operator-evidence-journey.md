# AWS operator evidence journey (read-only)

Audience: AWS Control Tower administrators evaluating ALZ without development or IAM engineering experience.

## What this run proves

A run has four independent gates. Never combine a green fixture test with a live-cloud qualification claim.

| Gate | Required input | Evidence | Failure behavior |
| --- | --- | --- | --- |
| Local readiness | Checked-out ALZ, Node/npm, Terraform, Ollama, models | Version and model digest records | STOP; provide a specific remediation |
| Private-model inference | Running loopback Ollama and installed Qwen/Mistral models | `.runs/model-qualification/` records | STOP; no candidate promotion |
| Offline orchestration | ALZ source checkout | `./alz matrix --offline-fixture` output | Mark SYNTHETIC, not cloud-qualified |
| AWS inventory | Explicit authorized AWS CLI profile, selected account and region | STS identity and read-only inventory records | STOP on wrong identity, denied API, or missing permissions |

## Step 1: prerequisites

Open Terminal on the operator's machine. Check:

```sh
node --version
npm --version
terraform version
ollama --version
ollama list
aws --version
```

The current required baseline tags are `qwen3:1.7b`, `qwen3:4b`, and `mistral-nemo:latest`. Granite and Nemotron are **comparison candidates**, not required defaults. Use the exact tags printed by `ollama list`; never type placeholder strings such as `YOUR_GRANITE_TAG`. If a candidate is missing, mark its comparison NOT_RUN rather than treating it as failed or inventing a tag. On the dedicated production qualification runner, follow `docs/target-preflight.md` for pinned Node/Ollama versions, model digests, and hardware identity.

## Step 2: local tests

From the ALZ checkout:

```sh
npm ci
./alz doctor
./alz models list
./alz models verify
./alz matrix --offline-fixture
```

Run `./alz matrix --live-models` only after Ollama is available and the installed baseline models pass. The offline matrix is fixture-based. The live matrix uses local inference but still has synthetic IaC previews. Neither command authenticates to AWS.

## Step 3: authorize the exact AWS identity

Use an approved read-only or discovery-scoped AWS IAM Identity Center profile. Do not paste credentials into prompts, logs, or issue comments.

```sh
aws configure list-profiles
aws sso login --profile PROFILE_NAME
AWS_PROFILE=PROFILE_NAME aws sts get-caller-identity --output json
```

The operator must check that the returned account ID and ARN correspond to the intended **management or member account** before proceeding. Record account ID, role ARN, region, timestamp, and any denied APIs in the private evidence packet. AWS Control Tower discovery can require management-account permissions; member-account results must not be presented as organization-wide inventory.

## Step 4: evidence acceptance

For every test, record `PASS`, `FAIL`, `SKIPPED`, or `NOT_RUN`, along with source commit, target account, host identity, command, exit code, output checksum, and whether the input was LIVE_CLOUD, LOCAL_MODEL, or SYNTHETIC. Redact account-sensitive inventory before sharing externally. A command's exit code alone does not prove its asserted scope.

The following are **separate** gates and remain unqualified until authentic evidence exists: authenticated AWS discovery-to-DesignSpec lineage, real Terraform/CDK preview with provider credentials and immutable source hashes, separate OIDC execution identities, governed ACT lease and authorization, and production admission.

## Operator decision

- **Proceed to the next read-only gate** only when prerequisites and identity match.
- **Stop and remediate** if permissions, installed models, source revision, or evidence are missing.
- **Never promote an agent model** based solely on a synthetic matrix or one successful prompt.
- **Never run `terraform apply`, `cdk deploy`, cloud mutations, or ACT** as part of this journey.

## Future guided UX acceptance criteria

The interactive wizard should (1) discover installed model tags and AWS profiles; (2) ask for an account/region only when AWS is selected; (3) show expected read-only API calls and explicit consent; (4) present a resource inventory summary; (5) display proposed ADD/MODIFY/TERMINATE operations without executing them; (6) export a redacted and a private evidence bundle; and (7) offer actionable fixes for every blocked gate. Until those controls are implemented and tested, this document is an operator runbook, **not** a claim that the wizard already supports them.
