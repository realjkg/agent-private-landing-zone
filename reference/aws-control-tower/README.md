# Control Tower AWS DEV reference

This folder defines a **reference template**, not live AWS evidence. It creates one additive stack in an already-enrolled Control Tower DEV member account. It does not create or update an organization, landing zone, OU, SCP, account enrollment, shared VPC, production account, custom domain, or organization-wide control.

## What the stack creates

- A new, isolated two-AZ VPC with private subnets, no internet gateway, NAT gateway, public IP, or default internet route.
- Private Bedrock Runtime and API Gateway interface endpoints. The API accepts signed IAM requests through its endpoint only.
- A Node.js Lambda that uses the existing `@langchain/core` runnables package and AWS Bedrock Converse. It has no tools. It accepts one bounded prompt, uses one regional on-demand model, disables hosted LangChain tracing, makes one bounded inference request, and redacts provider errors and request text from logs.
- A versioned Bedrock Guardrail for content, profanity, prompt attacks, credentials and common PII. The Lambda role can invoke only the configured model when the request names that guardrail. A separate explicit deny blocks missing or different guardrail identifiers.
- A private, IAM-signed verification Lambda with three fixed smoke requests. Its output contains HTTP statuses, never prompts or answers.
- A monthly account budget with actual and forecast email alerts, plus function error/throttle alarms. By default, a 100% **actual-cost** budget action automatically attaches an inference-deny policy to this Lambda role. It does not stop other charges. AWS cost data is delayed, so this is a brake after usage appears, not a spend cap. Set `PauseInferenceOnBudget=false` only if the owner has approved notification-only behavior.
- A versioned, KMS-encrypted, public-access-blocked pipeline artifact bucket with 30-day expiration and retained bucket/key safeguards.
- Separate source, build, and deployment roles. CodeBuild installs from the committed lock file and runs unit tests. **A human must approve** the source revision and package SHA-256. The fixed deployment buildspec verifies the artifact and updates only this Lambda's code. It cannot run repository scripts with deployment permissions, change IAM, change the guardrail or budget, or deploy CloudFormation.

The first stack starts with an explicit 503 stub. The first reviewed pipeline execution replaces the stub only after tests and manual approval. Model availability and account service quotas are prerequisites for the live request check.

## Supported sources

- **GitHub (default):** finish an AWS CodeConnections consent flow and pass an `AVAILABLE` connection ARN in the same account and region as the pipeline. The template uses `owner/repository`, branch `main` by default, and CodeStarSourceConnection. No long-lived repository token is stored in AWS.
- **GitLab:** finish the equivalent CodeConnections consent flow and pass `owner/group/repository` plus the connection ARN.
- **CodeCommit:** pass an existing repository name. An EventBridge rule starts only this pipeline for branch create/update events. The template does not create a repository or credentials.

## Local checks

```sh
node reference/aws-control-tower/stack.mjs
npm ci --offline --ignore-scripts --no-audit --no-fund --prefix reference/aws-control-tower/function
node --test test/aws-control-tower-reference.test.mjs
```

For a new workstation without the npm registry content cached, drop `--offline` from the install command; the checked-in lock file still fixes every package version and integrity digest.

The schema snapshots come from AWS CloudFormation Linter v1.59.0's `schemas-draft7.zip` release asset. The local manifest records the archive source and SHA-256 plus each schema checksum. The checks resolve template parameters and intrinsic functions for all three providers and both budget modes, compare every property to the pinned AWS resource schema, and check dependency cycles, trust boundaries, and the code-only deploy role. These are offline contract checks, not `cloudformation validate-template`, live IAM evaluation, real-model qualification, or Control Tower acceptance.

The schema files are AWS CloudFormation Linter data provided under the MIT-0 license. Their source and per-file digests are in `tests/schemas/manifest.json`.

## Deployment boundary

This template has not been applied to AWS and is not approved by a Control Tower administrator. A member-account administrator must verify OU enrollment, region/model availability, a non-overlapping VPC range, the budget recipient, CodeConnections status, artifact retention, and the change set in the intended DEV account before deployment. The repository does not store an account ID, connection secret, approval key, or AWS credential.

After the template is independently reviewed, deploy it as a dedicated administrator operation using a DEV-only CloudFormation execution role and an exact account allowlist. Review all IAM, VPC endpoint, KMS, budget-action, CodePipeline and billing permissions in the change set. Then review the first pipeline's source revision and package checksum before approving the Lambda-only release. Do not deploy this foundation from the application pipeline.

The stack intentionally retains its KMS key, artifact bucket and artifact bucket policy at deletion. Budget actions must be reversed or allowed to expire before stack cleanup; the action may have attached an inference-deny policy to the Lambda role. Never empty a billing or pipeline bucket as part of routine teardown.
