# Narrow real private-model BUILD — AWS brownfield/Terraform (first scenario)

The existing general BUILD loop produces `fixture-generator` artifacts for fixtures and blocks unauthorised real Build at the Design boundary. This work adds a **separate, explicitly runtime-injected trusted callback** for a real, reviewed Build Preview; it does not enable arbitrary model-generated code, generic infrastructure apply, or agent-permission creation.

## Trust and provenance boundaries

1. Exact Scenario 01 request `AWS_TERRAFORM_SCENARIO.request`; AWS + Terraform only; read-only authenticated actual AWS CLI discovery with known brownfield classification and no uncertain ownership, partial reads, delete authority or mock evidence.
2. Existing local model assessment must be OK and show independent Qwen router/primary and Mistral validator roles. Model tags and installed SHA256 digests are checked on the loopback Ollama service.
3. The models each output a **strict semantic JSON ADD proposal**, limited to one new `aws_cloudwatch_log_group` with name `/alz/preview/brownfield-audit` and 30-day retention. Disagreement, injected executable HCL, IAM permissions or unknown evidence refs stop before any tooling.
4. The trusted renderer produces deterministic HCL. The trusted runtime driver performs actual local Terraform `init -backend=false`, `fmt -check`, `validate -json`, `plan -refresh=false -lock=false`, and `show -json`. The normalized actual plan must contain **exactly one CREATE** of `aws_cloudwatch_log_group.alz_audit`. No apply/destroy/import is invoked.
5. Build evidence binds actual provider inventory hash, current DesignSpec/policy hashes, original validated artifact content hash, actual validation output hash and actual plan output hash. It explicitly records `EXTERNAL_APPROVAL_REQUIRED`; models cannot silently amend an owner's approved DesignSpec or authorize the proposed ADD.
6. The kernel accepts a real nonfixture Build only through an injected runtime callback, with matching provider, DesignSpec/policy/evidence hashes, `generatedBy=local-qwen-mistral-reviewed-template`, nonfixture scanner output, `READY_FOR_APPROVAL`, and an approval-blocked gate. The default unconfigured path is still blocked. The existing separate four-operation action registry remains the only proposed governed mutation route and must be externally leased.

## Target host execution

From an **exact clean checkout** with installed Node 24, pinned private local Ollama, independent Qwen/Mistral weights, Terraform (including pinned provider mirror/lockfile), and a federated/read-only authorized AWS identity:

```sh
npm ci
npm run build
ALZ_ALLOW_REAL_PRIVATE_BUILD=1 \
ALZ_ALLOW_TERRAFORM_PLAN=1 \
TF_VAR_aws_region=<approved-region> \
node dist/cli/real-private-build.js --live-aws-read-only
```

This generates private evidence in `.runs/qualification/real-private-build/<run-id>/` only if every actual target gate passes. The `terraform plan` path can contact approved provider APIs and download providers at init: run inside the authorized isolated target/mirror with egress controls. No general credentials, mutation or deployment are enabled.

**Status:** deterministic tests with injected providers prove the control interface only, not real AWS/GPU execution. The full eight-adapter model-authored IaC path is still NOT_RUN/UNQUALIFIED; unsupported provider/adapter combinations remain blocked until PLAN. A true production release requires this exact candidate's six signed release gates and independent approval, including final ARM64 scan and actual recovery. Do not represent CI injection fakes as live-model or cloud results.

## Optional: traceable teardown

To make the build undoable exactly (see `docs/teardown-traceability.md`), name the state container it would create into:

```sh
cat > state-ref.json <<'JSON'
{ "engine": "TERRAFORM", "backend": "s3",
  "location": "s3://<state-bucket>/builds/<build>/terraform.tfstate", "workspace": "default" }
JSON
ALZ_DELETION_UNIT_STATE=state-ref.json ALZ_DELETION_UNIT_EXPIRES=2026-12-31 \
  node dist/cli/real-private-build.js --live-aws-read-only
```

The candidate then carries `alz-managed-by`, `alz-unit` and `alz-build` tags (plus `alz-expires` if set), the real plan's tags must prove it, and `qualification.json` records the deletion unit. Without these variables nothing changes. A `local` backend is refused, and this still never applies or destroys anything.
