# Functional scenario 01 — AWS brownfield with Terraform and private agents

This is a **real local-model qualification against a synthetic AWS inventory**, not a live AWS deployment test. It does not replace customer-specific discovery, state ownership confirmation, or provider plan verification.

## Intent and acceptance

**Requirement:** Propose one new isolated ALZ CloudWatch audit log group with 30-day retention in a customer-managed AWS brownfield estate. Reuse existing Control Tower and Organizations boundaries; do not modify, adopt, delete, or apply them.

Existing ALZ components are reused, not replaced:

- Qwen3 1.7B supervisory router, Qwen3 4B primary reviewer, Mistral Nemo independent validator and Qwen adjudicator via Ollama.
- Existing `runAgentKernel` discovery/assessment/DesignSpec and deterministic safety boundary.
- Existing registered Terraform adapter for optional **actual Terraform fmt, validate and plan**, with no `apply`.
- Synthetic AWS fixture contains existing Control Tower, Organizations, external appliances and an accelerator role with incomplete boundary evidence.

## What runs

1. Require a clean committed checkout and explicit `--live-models`.
2. Require loopback Ollama, correct Qwen/Mistral model identities, and capture all three installed model SHA-256 digests.
3. Execute the **real** Qwen/Mistral analysis kernel with synthetic AWS brownfield discovery. Verify router, primary, validator and adjudicator participation; abort on abstention, missing evidence, errors or mutation.
4. Ask Qwen and Mistral independently for **structured intent**, not arbitrary Terraform source. Validate each against a strict schema: exactly one ADD for the new CloudWatch group, 30-day retention, verified evidence keys, NEW_RESOURCE_ONLY ownership.
5. Require independent agreement. Deterministically render HCL, bind it to the discovered environment's DesignSpec/policy hashes and the source commit. The original DesignSpec is **REVIEW_REQUIRED**: this new ADD is not silently incorporated into an approved customer design.
6. Save `main.tf` and `qualification.json` in a unique, private `.runs/qualification/<scenario>-<run-id>/` directory, with source/model/design/policy/artifact hashes and explicit stages that were NOT_RUN.
7. Optionally run actual Terraform `init -backend=false`, `fmt -check` and `validate -json`. Optionally run the existing adapter's `terraform plan` and normalize its ChangeSet, accepting only one CREATE and no updates/deletes/replacements. The plan stage must be explicitly enabled and needs AWS read-only credentials and region inputs. **There is no infrastructure apply.**

## Operator execution

From a clean repository checkout with the configured local Ollama running and Qwen3 1.7B, Qwen3 4B, and Mistral Nemo installed:

```sh
npm ci
npm run build
node dist/cli/qualify-aws-terraform-agent.js --live-models
```

The command deliberately refuses missing models rather than silently falling back to a fixture. Check `qualification.json` for model digests and `terraformValidation: NOT_RUN`; the generated HCL is a **review candidate**, not a Terraform plan.

To run the actual Terraform CLI syntactic validation (Terraform binary and registry availability required):

```sh
node dist/cli/qualify-aws-terraform-agent.js --live-models --terraform-validate
```

Only after explicitly selecting an AWS test account with appropriate **read-only discovery/preview identity** and defining a region (for example `TF_VAR_aws_region`) may an operator opt in to a *real provider plan*:

```sh
ALZ_ALLOW_TERRAFORM_PLAN=1 \
  node dist/cli/qualify-aws-terraform-agent.js \
  --live-models --terraform-validate --terraform-plan
```

This is still **not** live AWS brownfield discovery. Real account inventory and Terraform remote state ownership require a separately gated scenario before any deployment or adoption can be contemplated. Do not put passwords, keys, raw `terraform show` output or model transcripts into qualification evidence.

## Acceptance evidence

- Exact `git rev-parse HEAD` of a clean working tree; hashes of the candidate HCL and restricted model proposal.
- Installed model identities/digests and successful real model routing, independent assessment, structured reviews and adjudication.
- Synthetic discovery evidence, existing resource preservation, DesignSpec and policy hashes.
- Actual Terraform tool validation/plan statuses, if opted into, including normalized one-resource CREATE proof.
- Status remains REVIEW_REQUIRED, approval NOT_GRANTED, infrastructure ACT DISABLED even after a successful preview.
- Negative tests: unexpected or ungrounded proposals, arbitrary fields/IaC, nonadditive choices, missing digest, agent ABSTAIN, invalid source identity.

`test/aws-terraform-agent.test.ts` uses injected offline **test doubles only**; green CI is contract-test evidence, **not** proof that local models were invoked. Run the above live-model command on the target hardware for that evidence.

## Permutation roadmap (future work, not yet qualified)

Complete the first live local-model AWS/Terraform scenario before generating combinations of provider (AWS/Azure), estate (brownfield/greenfield/unknown), adapter (existing eight), private model role, evidence completeness, approval state, and tool availability. Enumerate only valid provider-adapter combinations; unsupported combinations must terminate with a typed BLOCKED/NOT_APPLICABLE result rather than being counted as passing workflows. Gate each scenario by model, artifact, policy, preview and mutation evidence; do not multiply expensive live-model runs without product value.

**Invariant:** ACT is disabled; security verification is an independent release concern and not a substitute for functional qualification.
