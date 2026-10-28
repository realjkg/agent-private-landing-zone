# ACT-DEV-1 AWS CDK canary

The CDK counterpart of the Terraform canary in [`../act-dev1-canary`](../act-dev1-canary). It creates **one CloudWatch Logs log group** with the same name scheme (`/alz/act-dev-1/<name>`), 30-day retention and the same four tags (`environment=DEV`, `managed-by=sovereign-alz`, `purpose=act-dev-1`, `owner=<owner>`). It also creates **one no-cost sentinel**, an `AWS::CloudFormation::WaitConditionHandle` with no properties, which stays in the stack (see Cleanup). It creates no compute, network, subnet, gateway or attachment, and it writes no log events.

This folder is an EXAMPLE. Nothing in it enables ACT. The reviewed pilot contract, approvals and every gate in [`docs/act-pilot-plan.md`](../../../docs/act-pilot-plan.md) still apply.

## What is committed

| File | Purpose |
| --- | --- |
| `app.js` | The CDK app: the L1 `CfnLogGroup` `ActDev1` (no `DeletionPolicy`) and the sentinel `RetainedSentinel`, in an environment-agnostic stack with termination protection declared. |
| `cdk.json` | Synthesis settings, and the EXAMPLE context values: `stackName`, `canaryName`, `owner`. |
| `package.json`, `package-lock.json` | Exact pins: `aws-cdk-lib` 2.273.0, `constructs` 10.8.1 and the CDK CLI `aws-cdk` 2.1145.0. These are the versions the repository's live CDK fixtures record (`test/fixtures/live/MANIFEST.json`). 2.273.0 is the lowest `aws-cdk-lib` 2.x whose bundled `brace-expansion` (5.0.12) is outside GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7 and GHSA-6j4f-fj2g-mc7p. `npm audit --package-lock-only` here reports 0 vulnerabilities. |
| `cdk.out/` | The **reference** cloud assembly, synthesized from the EXAMPLE values. It is not for a run: see "Inputs". |

### The synthesized template

The template holds exactly two resources:

| Logical id | Type |
| --- | --- |
| `ActDev1` | `AWS::Logs::LogGroup` |
| `RetainedSentinel` | `AWS::CloudFormation::WaitConditionHandle` |

It has no `Parameters` (no `BootstrapVersion`), no `Rules` (no `CheckBootstrapVersion`), no `Conditions`, no `Outputs` and no `AWS::CDK::Metadata`.

The legacy stack synthesizer, used with no assets, keeps the manifest free of CDK bootstrap dependencies:

- it writes no asset manifest, so nothing is published;
- it names no CDK bootstrap role ARN, so neither the pilot nor a `cdk deploy --app cdk.out` would assume one;
- so no CDK bootstrap stack is needed.

Creation stack traces are off, so the assembly does not record the build machine's paths.

## Inputs the operator supplies (one synthesis per run)

| Input | Where | Rule |
| --- | --- | --- |
| `stackName` | CDK context | Must equal the DEV target's `backend` in the reviewed contract. |
| `canaryName` | CDK context | `/alz/act-dev-1/<name>`, where `<name>` is 3 to 50 of `a-z`, `0-9` and `-`. Use a new name for each run. |
| `owner` | CDK context | The approved owner tag. |

The engine seals the `cdk.out` it is given and passes no parameter values. The stack name, log group name and owner are therefore fixed at synthesis. **Every run synthesizes its own `cdk.out`** on the build machine with the pinned packages. That folder is the one to choose in `./alz apply prepare`. The committed `cdk.out` is only the reference example; its owner tag is a placeholder.

```sh
npm ci
npx cdk synth --quiet --no-lookups --no-notices --output cdk.out \
  -c stackName=<contract backend> -c canaryName=/alz/act-dev-1/<new-name> -c owner=<approved owner>
```

The account and region come from the reviewed contract; the assembly names neither. The Terraform canary is qualified only in `us-east-2`, so use the same region in the contract.

The pilot itself never runs `cdk synth`, npm or the app. The unit tags (`alz-managed-by`, `alz-unit`, `alz-build`) are not in the template. The engine passes them as stack tags on the change set, and CloudFormation is expected to apply stack tags to the log group. That is UNVERIFIED until a live DEV run; the read-back below checks it. The reviewed APPLY policy (`scripts/act-dev1-apply-policy.py`) allows those three tag keys on the canary's create.

## Expected preview

Exactly **2 creates**:

- `ActDev1`, `AWS::Logs::LogGroup`;
- `RetainedSentinel`, `AWS::CloudFormation::WaitConditionHandle`.

Anything else (a modify, a remove, another resource) means the wrong stack or a changed assembly. Stop and do not approve.

## Read-back to verify after apply

- The stack is `CREATE_COMPLETE`. Termination protection is a person's step after the first create (`docs/act-pilot-apply.md`).
- `aws logs describe-log-groups --log-group-name-prefix <canaryName>` lists one group whose `logGroupName` is exactly `canaryName` and whose `retentionInDays` is `30`.
- The group's tags are the four above plus the three unit tags.
- The group has no stored bytes and no log streams: the canary writes nothing.
- The sentinel has no Cloud Control read mapping, so the independent observation reports it as not checkable. Confirm it in the stack's resource list instead.

## Cleanup

The governed cleanup removes resources from the stack's template. It never deletes a stack, and it refuses to empty one (`CLEANUP_WOULD_EMPTY_STACK`, `removalTemplateOf` in `src/apply/engines/cdk.ts`). The sentinel is what makes the log group removable:

1. The cleanup proposal names **`ActDev1` only**. The removal template keeps `RetainedSentinel`.
2. The cleanup deletes the log group, and the independent verification confirms it is gone.
3. The no-cost sentinel and the stack are retained. Retiring them is the owner's separate decision, outside the pilot.

A proposal that also names the sentinel would empty the stack and is refused.

## Tests

`test/act-dev1-cdk-canary.test.ts` (SYNTHETIC) covers:

- the pins, the lockfile and the bundled `brace-expansion` version;
- the template and manifest shape;
- the cleanup rule through the real `removalTemplateOf`: the log group is removable, and only the sentinel remains;
- one seal of the committed `cdk.out` through the real CDK engine with the fake `aws` of the CDK unit tests: exactly two creates.

With `ALZ_CDK_CANARY_SYNTH=1`, after `npm ci` here, it also:

- re-synthesizes and requires the committed bytes;
- synthesizes with run inputs and checks that both names change.
