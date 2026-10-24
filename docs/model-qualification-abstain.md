# Authentic blocked model qualification evidence

## Mac evidence observed on 2026-10-24

The owner ran local Qwen3 1.7B router, Qwen3 4B primary,
Mistral Nemo validator and Qwen3 1.7B adjudicator against **synthetic AWS**
brownfield discovery. All four roles returned schema-valid outputs. The
primary's top risk was **unverified restore capability**; the validator's was
**insecure execution role**. The adjudicator returned **ABSTAIN**.
No Terraform apply, cloud mutation or infrastructure ACT occurred.

These are two **distinct unresolved findings**. Do not collapse them, assert
they conflict, declare them compatible, claim they are resolved, or re-run
repeatedly just to obtain a passing sample. Changing the shared model
adjudication policy remains a **separate explicitly qualified engineering
change**, because it has many dependent tests and must not bypass CI's
affected-QA ceiling.

## Persist source-bound blocked execution receipts

A Mac model attempt that reaches inference but fails
`INDEPENDENT_AGENT_ASSESSMENT_NOT_VERIFIED` now leaves a private JSON file at
`.runs/qualification/aws-brownfield-terraform-private-agents-v1-<id>/qualification-blocked.json`
before the CLI returns nonzero. It records:

- exact clean Git source commit and model tag/digest identities;
- observed per-role model schema participation and kernel/assessment status;
- primary and validator top-risk labels, adjudication explanation;
- explicit `BLOCKED`, approval `NOT_GRANTED` and infrastructure ACT `DISABLED`.

It does not include raw prompts, AWS credentials, Terraform state, native
plans or authorization tokens. The risk labels remain internal metadata.

The separately distributed Mac Evidence Qualification Kit v1.1 consumes this
record only after source, model, role and authorization binding checks, and
prints a **BLOCKED** attempted-run result instead of incorrectly reporting
`NOT_RUN`. A blocked result is never a model qualification pass.

The previous blocked run's ZIP cannot be retroactively upgraded. After
this code is merged and rebuilt on Mac, rerun once to acquire its new
authentic attempted-run receipt. A subsequent risk decision may still
ABSTAIN, which is valid safety behavior. Real AWS DEV evidence, native
Terraform/CDK previews and any ACT qualification remain separately gated.
