# Pilot bootstrap: account owner runbook

Status: **offline-validated only; unverified until run by an account owner.** On 2026-10-12, with Terraform 1.16.4 and no cloud credentials, `terraform fmt -check`, `init -backend=false` and `validate` passed for `bootstrap/aws` (provider `hashicorp/aws` 6.68.0) and `bootstrap/azure` (`hashicorp/azurerm` 4.81.0, `hashicorp/azuread` 3.10.0). That confirms the resource and attribute names against those provider schemas, nothing more: no `plan` or `apply` has run, no resource has been created, and the IAM, Entra and storage behavior (trust conditions, role scopes, the state lock, the network rules) is untested. `validate` reports one deprecation warning for the Azure state container's `resource_manager_id`; the provider removes it in 5.0, so the `~> 4.0` pin stays. The provider binaries came from a local mirror with no signature check, so rerun `terraform init` against the registry on your machine. The remaining assumptions are listed at the end.

This page provisions the cloud side of the pilot once, by hand, before anyone can qualify or apply. It is separate from `docs/act-pilot-apply.md` and `docs/act-pilot-plan.md`, which define what the identities must be and how the driver uses them: this page does not repeat that. Nothing in `src/` references the bootstrap, `./alz apply` never runs it, and agents never run it. It does not enable ACT. `config/act-pilot-contract.sha256` stays empty until the owner pins a reviewed contract.

## What it creates

Roles are least privilege by design but the final scope is the owner's decision (`docs/act-pilot-apply.md`, "What the owner supplies").

| Identity | Azure (Terraform engine) | AWS Terraform engine | AWS CDK engine |
| --- | --- | --- | --- |
| DISCOVERY | Reader on the pilot resource group (or subscription); nothing on state. Reader holds only control-plane `*/read` actions and no data actions, so it cannot read blob contents or Key Vault secret, key or certificate values, and it cannot call `listKeys` | `ViewOnlyAccess` by default, plus the inline `act-pilot-discovery-scope` policy (see "Read-only discovery scope" below); the bucket policy denies it the state bucket | The same `discovery_managed_policy_arns` and `act-pilot-discovery-scope` policy as the Terraform engine, plus `cloudformation:DescribeStacks` on the stack inline. The observation after an apply runs `describe-stack-resources`, `cloudcontrol get-resource` and `tag:GetResources` as this role (`docs/observe-and-cleanup.md`) |
| STATE | Storage Blob Data Reader on the state container | Get the state object; get, put and delete the `.tflock` object; list the bucket. Denied writes to the state object | not used |
| STATE_WRITE | Storage Blob Data Contributor on the state container only | Get, put and delete the state object and the lock object; list the bucket. Denied `DeleteObjectVersion` | not used |
| APPLY | Contributor on the pilot resource group (or subscription); no role on state | The policies you name in `apply_managed_policy_arns` (no default). Denied the state bucket and edits to the bootstrap roles | `ExecuteChangeSet`, `DescribeStacks`, `DescribeStackEvents`, `CancelUpdateStack` on the stack, plus your resource policies. Denied `CreateChangeSet` and `DeleteStack` |
| CHANGESET | not used | not used | `CreateChangeSet`, `DescribeChangeSet`, `DeleteChangeSet`, `GetTemplate`, `DescribeStacks` on the stack. Explicit deny of `ExecuteChangeSet`, `CancelUpdateStack` and `DeleteStack` |

### Read-only discovery scope

The owner decided on 2026-10-27 that read-only discovery defaults to control-plane metadata and excludes application data and secret contents, and that any exception needs an explicit scope and purpose (issue #39, comment 6440801434, item 2). This applies to both AWS engines and to every provider's read-only identity. **This scope is not live-verified:** it was checked offline only (below), and the live DEV qualification confirms it against real AWS.

**AWS.** DISCOVERY gets three layers, all in `bootstrap/aws/discovery.tf` and `bootstrap/aws/discovery-policy.json`:

1. `discovery_managed_policy_arns`, default `arn:aws:iam::aws:policy/job-function/ViewOnlyAccess`: lists and describes, no data reads. Only three AWS-managed policies are accepted, compared exactly (no case folding, no trimming): `arn:aws:iam::aws:policy/job-function/ViewOnlyAccess`, `arn:aws:iam::aws:policy/SecurityAudit` and `arn:aws:iam::aws:policy/ReadOnlyAccess`. Variable validation refuses every other ARN, including customer-managed policies and `SecretsManagerReadWrite`.
2. An inline allow of exactly the reads the product makes as DISCOVERY (the inventory below), so the product does not depend on what `ViewOnlyAccess` happens to contain.
3. An inline deny of data-plane and secret reads. It is on the role itself, so it applies whatever `discovery_managed_policy_arns` names, **but only to the actions it lists**. It does not make a broader managed policy metadata-only: `ReadOnlyAccess` still grants every data read the list does not name, which is why it draws a plan warning. The deny covers:
   - object, archive and media contents: `s3:GetObject*`, `s3-object-lambda:GetObject*`, `s3express:CreateSession`, Glacier job output, ECR image layers, CodeCommit blobs, files and `GitPull`, and Kinesis Video media (`GetMedia`, `GetClip`, `GetMediaForFragmentList`, `GetImages`);
   - items and query results: `dynamodb:GetItem`, `BatchGetItem`, `Query`, `Scan`, `PartiQLSelect`, `GetRecords`; DAX `GetItem`, `BatchGetItem`, `Query`, `Scan`; `rds-data:*`; Redshift Data and Athena results; `cassandra:Select`; `es:ESHttpGet`;
   - log events: `logs:GetLogEvents`, `FilterLogEvents`, `StartQuery`, `GetQueryResults`, `StartLiveTail`, `GetLogRecord`, `Unmask`, and the RDS log file downloads;
   - messages and stream records: `sqs:ReceiveMessage`, `kinesis:GetRecords`, `GetShardIterator`, `SubscribeToShard`;
   - execution data and user records: Step Functions `DescribeExecution` and `GetExecutionHistory` (input and output), `ssm:GetCommandInvocation` and `ListCommandInvocations` (command output), and Cognito `ListUsers`, `ListUsersInGroup` and `AdminGetUser` (PII);
   - secrets and settings that carry them: `secretsmanager:GetSecretValue`, `BatchGetSecretValue`, `ssm:GetParameter`, `GetParameters`, `GetParametersByPath`, `GetParameterHistory`, `kms:Decrypt`, Glue connections (`GetConnection`, `GetConnections`: JDBC passwords), Lambda function configuration and code (`lambda:GetFunction`, `GetFunctionConfiguration`, `ListFunctions`, `ListVersionsByFunction`, `GetLayerVersion`), EC2 user data (`ec2:DescribeInstanceAttribute`, `DescribeLaunchTemplateVersions`), plaintext environment variables (`ecs:DescribeTaskDefinition`, `codebuild:BatchGetProjects`, `elasticbeanstalk:DescribeConfigurationSettings`), and `ec2:GetPasswordData`, `GetConsoleOutput`, `GetConsoleScreenshot`;
   - API Gateway API key values: `apigateway:GET` is one action for every API Gateway read, so it is denied only on the key paths (`/apikeys`, `/apikeys/*`, `/usageplans/*/keys`, `/usageplans/*/keys/*`), and the rest of API Gateway configuration stays readable.

   None of these is a read the product makes as DISCOVERY (the inventory below; `test/discovery-scope.test.ts` checks that no allowed action matches a denied one). Under the default, the residual risk is whatever `ViewOnlyAccess` itself contains. Its policy document was not fetched for this change (offline), so the list above is the control, not `ViewOnlyAccess`.

What DISCOVERY reads (the inventory the allow is built from):

| Path | Calls as DISCOVERY | IAM actions |
| --- | --- | --- |
| CDK preview and qualification (`src/apply/engines/cdk.ts`) | `cloudformation describe-stacks` | `cloudformation:DescribeStacks` |
| CDK blueprint after an apply | `cloudformation describe-stack-resources` | `cloudformation:DescribeStackResources` |
| Independent observation and leftover verification (`src/observe/aws-cli.ts`, `verify.ts`) | `cloudcontrol get-resource` for the types in `CLOUD_CONTROL_TYPES`; `resourcegroupstaggingapi get-resources` | `cloudformation:GetResource`, `tag:GetResources`, and each type's read-handler permissions from its CloudFormation resource schema (log group, bucket, role, OIDC provider, topic, queue, KMS key, DynamoDB table, VPC, subnet, security group): describe, list-tags and configuration reads, plus the two recorded exceptions below |
| Preview discovery (`src/providers/aws/discover.ts`) | `sts get-caller-identity`, `organizations describe-organization` and `list-policies`, `controltower list-landing-zones` and the operation reads, `configservice describe-configuration-recorders`, `cloudtrail describe-trails` | the matching describe and list actions; `sts:GetCallerIdentity` needs none |
| Terraform engine preview and seal (`src/apply/engines/terraform.ts`) | `terraform plan`, whose refresh calls the provider's read for every resource and data source in the project | the project's own types. The pilot canary's log group is covered by the allow. **Under the default, a plan that refreshes an `aws_lambda_function` is refused** (`lambda:GetFunction` is denied), so is one that refreshes an `aws_ssm_parameter` (`ssm:GetParameter` is denied, and `kms:Decrypt` too for a `SecureString`), and so is one that refreshes an `aws_cognito_user`, a cleanup plan included (`cognito-idp:AdminGetUser` is denied). All three are on the pilot journey's leaf allowlist, so this is the expected consequence of the decision, and it fails closed with AccessDenied at plan time. The path is a `discovery_data_read_exceptions` entry for exactly those resources, with its purpose. A type that needs a read `ViewOnlyAccess` lacks needs `SecurityAudit` or `ReadOnlyAccess` (with its warning), with a recorded scope and purpose, or a reviewed change to the inventory |

Cloud Control reads three types only through data-bearing permissions, so the verifier never reads them (`DATA_BEARING_TYPES` in `src/observe/verify.ts`): `AWS::Lambda::Function` (the read handler returns environment variables and needs `kms:Decrypt`), `AWS::SSM::Parameter` (`ssm:GetParameters` returns the value) and `AWS::SecretsManager::Secret` (`secretsmanager:GetSecretValue`). Each is `NOT_CHECKABLE` with `DATA_BEARING_READ_EXCLUDED`. A cleanup proposal lists a run-created one as `UNVERIFIABLE`, and it still needs the contract's human approvals. After the cleanup the leftover check reports it `UNKNOWN`, so the record stays `INCOMPLETE`. No step in the product confirms its deletion (`docs/observe-and-cleanup.md`).

**Recorded exceptions in the default allow (the owner must accept them).** Two read-handler permissions return more than configuration. They cannot be scoped to the pilot's own resources: a blueprint names its buckets and topics freely, and the pilot apply sets no deletion-unit tag yet, so neither a name prefix nor a tag condition can select them. They stay in the default, recorded in `discovery-policy.json` (`allow.recordedExceptions`) with this scope and purpose:

| Action | Scope | Returns | Purpose |
| --- | --- | --- | --- |
| `s3:ListBucket` | every S3 bucket in the account (`Resource: "*"`) | object key names, never object contents. Key names can themselves be application data, such as PII in file names | the Cloud Control read handler of `AWS::S3::Bucket` needs it, so the verifier cannot confirm that a run-created bucket exists or is gone without it; it also authorizes `HeadBucket` |
| `sns:ListSubscriptionsByTopic` | every SNS topic in the account (`Resource: "*"`) | subscription endpoints: email addresses, phone numbers and HTTPS URLs that can carry tokens. Never messages | the Cloud Control read handler of `AWS::SNS::Topic` needs it, so the verifier cannot confirm that a run-created topic exists or is gone without it |

**Exceptions need an explicit scope and purpose.**

- A choice other than the default for `discovery_managed_policy_arns` is an exception: write its scope (which resource types and resources) and its purpose (which DISCOVERY read needs it) beside the value, as `terraform.tfvars.example` shows. `ReadOnlyAccess` draws a plan warning (a `check` block, an exact comparison), because the inline deny blocks only the data reads it lists.
- A data read is lifted only through `discovery_data_read_exceptions`. Each entry names actions the blanket deny lists, exact resource ARNs, and a purpose of at least 20 characters. Variable validation accepts a resource only when:
  - it has no `*` or `?` anywhere;
  - it has no `$` anywhere, so no IAM policy variable: IAM substitutes a variable such as `${aws:UserAgent}` from the request, so the caller would choose the resource, as with a wildcard;
  - it has no whitespace or control character (such a resource never matches, so it would be a silent no-op);
  - its partition is `aws`;
  - it has a region and a 12-digit account, unless the service has none (S3 has neither; API Gateway has no account);
  - its resource part has no empty segment (no `//` or `::`, and no trailing `/` or `:`).

  So `arn:aws:s3:::*/*`, `arn:aws:s3:::<bucket>/${aws:UserAgent}`, `arn:aws:secretsmanager:<region>:<account>:secret:*`, `arn:aws:ssm:*:*:parameter/*`, `arn:aws:kms:*:*:key/*` and `arn:aws:dynamodb:<region>:<account>:table/*` are all refused (`bootstrap/aws/tests/discovery.tftest.hcl`). The action stays denied on every other resource (a `NotResource` deny), an action the blanket deny does not list is refused at plan time, and the API key deny is never lifted.

**Azure.** DISCOVERY holds the built-in Reader role on the pilot scope and no role on the state container. Reader grants control-plane `*/read` actions and no data actions, so it cannot read blob, queue or table data, Key Vault secret, key or certificate values (reading a secret's ARM resource returns its attributes, not its value), or call `listKeys`. The observation reads Azure Resource Manager only, with a token for `management.azure.com`, which no data plane accepts. ARM still returns resource configuration, and deployment history records non-secure parameter values; a `secureString` parameter is not returned. This was checked against the role's definition only, not on a live subscription.

**GCP.** The G0 package records the same alignment for the DISCOVERY row (`docs/act-pilot-gcp-terraform-g0.md`); its proposals are unchanged and held.

Offline evidence for this section, all synthetic: `terraform fmt -check`, `init -backend=false`, `validate` and `terraform test` (`bootstrap/aws/tests/discovery.tftest.hcl`, a mocked provider: the default, the deny with and without an override, the managed-policy allowlist and its lookalikes, and the exception rules with every wildcard form) with Terraform 1.16.4 and hashicorp/aws 6.68.0; `test/discovery-scope.test.ts` and `test/act-dev1-automation.test.py` read the policy as written. None of this shows that AWS evaluates the policy as intended.

If the contract sets `embedStateWrite` (opt-in, Terraform engine only, `docs/act-pilot-apply.md`), sealing and `qualify` also carry the STATE_WRITE principal's non-secret settings, so STATE_WRITE must be usable on the machine that seals: its role or client, and its OIDC token file path, must be configured there, and its trust conditions (and any required reviewers on its environment) apply to sealing as well as applying. Sealing is then write-capable at the backend. This is unverified on a real backend.

Other properties:

- **Azure:** four app registrations, one client per identity for all three subscriptions (the Azure provider spec requires the same client ids everywhere). Each has one federated credential per environment, bound to the issuer, the audience and one exact subject. No client secret or certificate is created. The storage accounts have versioning, 30 day blob and container soft delete, TLS 1.2, no public blob access, and account keys and SAS disabled, so only Entra authorization works. The accounts also deny every network except the runner's egress IPs or CIDRs, which you list in `state_allowed_ip_ranges` (required; an empty list would lock the runner out). The AWS state bucket uses SSE-S3; a customer-managed key is your choice and needs key-policy access for the STATE and STATE_WRITE roles.
- **AWS:** one OIDC provider per account (or your existing one), roles with `sts:AssumeRoleWithWebIdentity` trust conditioned on `<issuer>:aud` and `<issuer>:sub`. The bucket has versioning, SSE-S3, all four public access blocks, owner-enforced ownership, TLS-only access, and a policy that denies every principal except STATE, STATE_WRITE and the administrators you list. Role names are lowercase because the pilot requires lowercase role ARNs.
- Every identity needs its own subject in each environment. With GitHub that means one GitHub environment per identity and stage, for example `dev-state-write` and `dev-apply`.

## Prerequisites: what the account owner needs

- Terraform 1.10 or later, the Azure CLI (`az`) for Azure, the AWS CLI v2 for AWS, `jq`, and `node` (to read token claims).
- **Azure:** in the tenant, the Entra role Application Administrator or Cloud Application Administrator (to create app registrations, service principals and federated credentials). On each of the three subscriptions, Owner, or Contributor plus Role Based Access Control Administrator (to create the resource groups, storage accounts, role assignments and budget). The storage resource provider registered in each subscription.
- **AWS:** in each of the three accounts, an administrator role that can create IAM roles, role policies and an OIDC provider, create and configure S3 buckets and bucket policies, and create budgets. In a member account of an organization, IAM access to Billing must be activated for the budget. Name that role in `state_admin_principal_arns`, or the bucket policy locks the bootstrap out of its own bucket.
- The values the owner supplies in `docs/act-pilot-apply.md`: tenant and subscription IDs or the 12 digit account IDs, the region, the GitHub repository and environment names (or the issuer and subjects of your self-hosted runner), the APPLY policy decision, and the budget.
- Three separate subscriptions or accounts. The contract refuses a chain that does not differ in account and backend.

## Step 1: Azure

```bash
az login --tenant 00000000-0000-0000-0000-000000000000
az account show --query '{tenant:tenantId, subscription:id, user:user.name}' -o table
az ad signed-in-user show --query id -o tsv

# For each of the three subscriptions:
az account set --subscription 00000000-0000-0000-0000-000000000001
az provider register --namespace Microsoft.Storage --wait
az role assignment list --assignee "$(az ad signed-in-user show --query id -o tsv)" \
  --scope /subscriptions/00000000-0000-0000-0000-000000000001 --query '[].roleDefinitionName' -o tsv

cd bootstrap/azure
cp terraform.tfvars.example terraform.tfvars   # replace every fake value
terraform init
terraform fmt -check && terraform validate
terraform plan -out=bootstrap.plan             # read it: three environments, four apps, twelve federated credentials
terraform apply bootstrap.plan
terraform output -json                          # tenant, client ids, contract_targets, apply_scopes
```

The `.gitignore` in `bootstrap/` keeps state, `.terraform/` and `*.tfvars` out of version control.

## Step 2: AWS

Run once per account, each in its own workspace and each with credentials for that account only. The provider refuses any other account (`allowed_account_ids`).

```bash
export AWS_PROFILE=example-dev-admin
aws sts get-caller-identity                       # the Account must be the environment's

cd bootstrap/aws
cp terraform.tfvars.example dev.tfvars            # engine, subjects, apply policy, bucket or stack name
terraform init
terraform workspace new dev
terraform fmt -check && terraform validate
terraform plan -var-file=dev.tfvars -out=dev.plan
terraform apply dev.plan
terraform output -json                            # role_arns and contract_target

# Repeat with qa and prod.
```

A given account uses one engine. Use `engine = "CDK"` and `cdk_stack_name` for the CDK engine; it creates no bucket and no STATE or STATE_WRITE role, and the driver refuses an identity the engine does not use.

## Step 3: GitHub environments or your issuer

- **GitHub OIDC:** create the environments named in your subjects. Put required reviewers on the APPLY and STATE_WRITE environments. A required-reviewer list needs only one reviewer, so it does not replace the two-person production rule, which the pilot enforces with signed approvals (`docs/act-pilot-plan.md`). Restrict which branches may deploy to each environment.
- **Self-hosted issuer:** the cloud must reach the issuer's discovery document (`/.well-known/openid-configuration`) and keys over public HTTPS. Set `oidc_issuer` (Azure) or `oidc_issuer_host` (AWS) and the audience, and give each identity a different `sub`.

## Step 4: Runner setup

The driver reads each identity's token from a file (`ALZ_<IDENTITY>_ARM_OIDC_TOKEN_FILE` or `ALZ_<IDENTITY>_AWS_WEB_IDENTITY_TOKEN_FILE`), which must be an absolute path made of plain characters. How the file gets there is the execution host's job; the variables and their rules are in `docs/act-pilot-apply.md` ("Identities", "Providers"). Do not export `AZURE_*`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE` or the other fallback variables on the host that runs `./alz apply`.

- **Operator terminal (the default):** GitHub OIDC is not available on an arbitrary terminal. Use a self-hosted issuer or a workload identity mechanism of your own that writes one token file per identity, mode 0600, outside the working tree.
- **GitHub-hosted or self-hosted runner:** the job needs `permissions: id-token: write` and one job per GitHub environment, because a job's token carries a single subject. Write the token to a file, for example:

```bash
umask 077
token="$(curl -sSf -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=api://AzureADTokenExchange" | jq -r .value)"   # AWS: audience=sts.amazonaws.com
echo "::add-mask::$token"
printf '%s' "$token" > "$RUNNER_TEMP/apply.jwt"
```

A job can request a token for any audience, so inside one job the identities are separated by the driver's checks and the role scopes, not by the credentials themselves. Real credential isolation needs each identity's token to come from a different job, or from an issuer you control that releases a token only to the process that may hold it. This is the owner's decision; the bootstrap provides the cloud half (a subject per identity) and nothing more. Workflow files are not part of this package.

## Step 5: Fill the configuration

Copy the `terraform output` values into the template that matches your provider (`bootstrap/config.azure.template.json`, `bootstrap/config.aws.template.json`) to keep your own record, and then:

1. Copy the `contractTargets` block into `config/act-pilot-contract.json` by hand, starting from the matching `config/act-pilot-contract*.example.json` (for the Azure Terraform DEV-only pilot, `config/act-pilot-contract.azure-dev.example.json`; see `docs/act-pilot-azure-terraform-g0.md`). Add the approvers per `docs/act-pilot-apply.md`. Leave `enabled: false`.
2. Set the `ALZ_<IDENTITY>_<VAR>` variables on the execution host from `identityVariables` (client ids or role ARNs, tenant and subscription or region, token file paths).
3. Do **not** write the pin. Enabling the pilot and committing the hash is a separate reviewed change (`docs/act-pilot-apply.md`, "The contract and its pin").

The template files hold identifiers and paths only. Keep your filled copy out of the repository.

## Step 6: Credential preflight

Run these in a separate shell, never the one that runs `./alz apply`: the driver refuses `AZURE_*` and `AWS_*` fallback variables. None of them creates infrastructure.

**Azure** (token exchange, scope check):

```bash
export AZURE_CONFIG_DIR="$(mktemp -d)"            # keeps your own az login untouched
az login --service-principal -u 00000000-0000-0000-0000-0000000000d3 \
  -t 00000000-0000-0000-0000-000000000000 --federated-token "$(cat /var/run/alz/dev/state-write.jwt)"
az account show                                   # the service principal, the tenant
az storage blob list --account-name examplealzstatedev --container-name tfstate --auth-mode login -o table
az logout; rm -rf "$AZURE_CONFIG_DIR"

# As the owner, list what each client holds. Expect exactly the table above:
az role assignment list --all --assignee 00000000-0000-0000-0000-0000000000d4 -o table
```

Repeat the login for each identity. STATE listing the container works and an upload fails with an authorization error; APPLY and DISCOVERY listing the container fail. A failure where success is expected is a trust or scope problem (see below).

**Azure DISCOVERY scope.** What DISCOVERY may read is stated in "Read-only discovery scope" above (**Azure**): Reader on the pilot scope, control-plane `*/read` actions and no data actions, nothing on the state container. Within the control plane, a few reads return more than names and settings: Log Analytics and Application Insights queries, the activity log, deployment-history non-secure parameters and outputs, and non-secure configuration values. The scope bounds them, so keep DISCOVERY on the pilot resource group (`apply_resource_group_name`). For DEV that is the accepted setup (issue #39, comment 6444382695, item 4); a narrower custom role for QA and PROD is documented in `docs/act-pilot-azure-terraform-g0.md`, "DISCOVERY scope review".

To check what was assigned, run as the owner:

```bash
az role definition list --name Reader --query '[].permissions[].{actions:actions, dataActions:dataActions}' -o json   # expect ["*/read"] and []
az role assignment list --all --assignee 00000000-0000-0000-0000-0000000000d1 --query '[].{role:roleDefinitionName, scope:scope}' -o table
```

**AWS** (token exchange, role assumption, policy check):

```bash
# Assume with the token alone. Print only the ARN, never the returned credentials.
aws sts assume-role-with-web-identity --role-arn arn:aws:iam::111111111111:role/alz-pilot-dev-state \
  --role-session-name preflight --web-identity-token "file:///var/run/alz/dev/state.jwt" \
  --query AssumedRoleUser.Arn --output text

# The same path the pilot uses, with a clean environment:
env -i PATH="$PATH" HOME="$HOME" AWS_ROLE_ARN=arn:aws:iam::111111111111:role/alz-pilot-dev-state \
  AWS_WEB_IDENTITY_TOKEN_FILE=/var/run/alz/dev/state.jwt AWS_REGION=us-east-1 AWS_EC2_METADATA_DISABLED=true \
  aws sts get-caller-identity

# As the owner, simulate without changing anything (identity policies only; not the bucket policy):
aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::111111111111:role/alz-pilot-dev-changeset \
  --action-names cloudformation:ExecuteChangeSet --resource-arns "arn:aws:cloudformation:us-east-1:111111111111:stack/ExamplePilotStack/*" \
  --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text      # expect explicitDeny
```

With the Terraform engine, STATE should be able to `aws s3api head-object` the state key (a not-found answer is fine before the first state exists), and a `put-object` of a canary key as STATE or APPLY must be denied. Do not write a canary as STATE_WRITE: its policy covers only the state and lock keys, and the first `./alz apply qualify` is the real test. The pilot's cloud-log attestation (CloudTrail or Azure sign-in and storage logs) is a person's job at qualification, not part of this step.

## Budget and cost alerts

Set `budget_monthly_amount`, `budget_start_date` and `alert_emails` (Azure) or `budget_monthly_usd` and `alert_emails` (AWS) in the tfvars. Each creates a monthly budget per subscription or account with alerts at 80 and 100 percent of actual spend. Budgets alert; they do not stop spend, and the alert can lag by hours. Check them:

```bash
az consumption budget list --subscription 00000000-0000-0000-0000-000000000001 -o table
aws budgets describe-budgets --account-id 111111111111 --query 'Budgets[].[BudgetName,BudgetLimit.Amount]' --output text
```

Set a cost anomaly alert in each cloud's billing console as well; this package does not.

## Failure handling

**Partial bootstrap.** Terraform applies are not transactional. Read the error, fix its cause (a taken storage account or bucket name, a missing permission, a role assignment that raced the identity's creation), and run `terraform plan` and `apply` again; they converge. `terraform state list` shows what exists. If the local state is lost, the created resources still exist: import them (for example `terraform import 'aws_iam_role.identity["APPLY"]' alz-pilot-dev-apply`) or tear them down by hand, and never create a second set under the same names. New Entra objects and role assignments can take minutes to propagate; wait before treating a 401 or 403 as a misconfiguration.

**Trust misconfiguration.** The usual cause is a `sub`, `aud` or issuer that is not the token's. Read the claims (the payload only; the whole token is a credential, so never paste it):

```bash
node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8").trim().split(".")[1];console.log(JSON.stringify(JSON.parse(Buffer.from(t,"base64url")),null,2))' /var/run/alz/dev/apply.jwt
```

Compare `iss`, `sub` and `aud` with the trust: `az ad app federated-credential list --id <client id>` or `aws iam get-role --role-name alz-pilot-dev-apply --query Role.AssumeRolePolicyDocument`. Azure usually reports no matching federated identity record (AADSTS70021) for a subject or issuer mismatch; AWS reports not authorized to perform `sts:AssumeRoleWithWebIdentity` for a `sub` or `aud` mismatch, and an invalid identity token for an issuer the provider cannot validate. Fix the tfvars subject and re-apply; do not widen the condition to a wildcard.

**State access denied during the pilot.** The pilot's open question (`docs/act-pilot-apply.md`, "Backend and identity ordering at apply") is which principal actually reads and writes state at plan and apply. The bootstrap fails closed: DISCOVERY and APPLY have no state access, and on AWS the bucket policy denies them. If `qualify` or the first DEV apply shows one of them denied on state, that is the open question appearing. Do not loosen the policy to make a run pass; stop, record the finding, and make it an owner decision under a reviewed change. A first DEV apply that fails at the state write may have changed resources: follow "When an apply fails" in the apply runbook (the recovery files are in the evidence vault).

**Bucket policy lockout (AWS).** The policy denies everyone but its list. If you omitted the administrator role, sign in as the account's root user and run `aws s3api delete-bucket-policy --bucket examplefake-dev-state`, then add the role to `state_admin_principal_arns` and re-apply.

**State lock stuck.** First make sure no apply is running and read `./alz apply status`; after `KILLED` or `PARTIAL_REQUIRES_REVIEW` review state and resources before touching the lock (apply runbook). Then, as an administrator:

```bash
# AWS: the lock is an object next to the state object.
aws s3api get-object --bucket examplefake-dev-state --key pilot/dev.tfstate.tflock /dev/stdout   # who and when
aws s3api delete-object --bucket examplefake-dev-state --key pilot/dev.tfstate.tflock

# Azure: the lock is a lease on the state blob. Break it with a temporary data role for yourself on that container only.
az storage blob show --account-name examplealzstatedev --container-name tfstate --name dev.tfstate \
  --auth-mode login --query properties.lease
az storage blob lease break --account-name examplealzstatedev --container-name tfstate --blob-name dev.tfstate --auth-mode login
```

Remove your temporary role assignment afterward. The pilot never uses `-lock=false` or force-unlock.

## Teardown

1. Remove the pilot's own resources first, by the approved manual procedure (`docs/act-pilot-apply.md`, "Cleanup"). The state buckets and containers hold their state; destroying them first strands the resources.
2. Disable the pilot: a reviewed commit that sets `enabled: false` and clears the pin.
3. Remove the runner side: delete the GitHub environments or stop the issuer, and delete the token files.
4. AWS, per workspace: `terraform apply -var-file=dev.tfvars -var force_destroy_state=true`, then `terraform destroy -var-file=dev.tfvars`. An OIDC provider you passed as `existing_oidc_provider_arn` is not destroyed.
5. Azure: `terraform destroy`. The pilot resource group is not deleted while it still holds resources (the provider's default protection); finish step 1 first. Deleted app registrations stay recoverable for about 30 days (check the Entra portal's deleted applications) before they are gone.
6. Delete the bootstrap's local state, tfvars and any filled config copy.

## Assumptions not verified

None of these was checked against provider schemas or cloud documentation. Each fails closed or at plan time unless noted.

- **Provider schemas** (checked offline on 2026-10-12 with `terraform validate`): every attribute and block name in the templates is accepted by hashicorp/azurerm 4.81.0, hashicorp/azuread 3.10.0 and hashicorp/aws 6.68.0. Older or newer provider versions inside the pins may differ, and the other assumptions below remain untested.
- **Azure authorization:** the backend works with Entra authorization (`use_azuread_auth` or `ARM_STORAGE_USE_AZUREAD`), which the apply runbook says is not yet on the runner profile; with account keys disabled nothing else can work. STATE's data reader role may not permit the lease a lock takes (a lease is a write action), in which case STATE's lock fails with an authorization error; widening it is the owner's decision. Entra accepts the federated credential subject and audience as written. Built-in role names are as named.
- **AWS DISCOVERY scope:** `ViewOnlyAccess` plus the inline allow is enough for the product's reads; IAM evaluates the inline deny over `ViewOnlyAccess` and any accepted managed policy; the `apigateway:GET` resource paths cover API key values; Cloud Control's read handlers need only the permissions their schemas list (read on 2026-10-27). A Terraform plan for a type outside the inventory may be refused until an accepted managed policy or an exception covers its reads.
- **AWS authorization:** the S3 backend's native lock needs get, put and delete on `<key>.tflock` only, and workspace selection needs `s3:ListBucket` on the bucket; `aws:PrincipalArn` is the role ARN for an assumed-role session; `NotResource` is valid in a bucket policy; CloudFormation actions authorize against the stack ARN (a change set action may need more, see the CDK list in the apply runbook).
- **Cost:** budgets work in your billing setup (AWS member accounts need billing access activated for IAM; Azure budgets need a subscription type that supports them).
- **GitHub OIDC:** the default subject is `repo:OWNER/REPO:environment:NAME`; customized subject templates change it.
