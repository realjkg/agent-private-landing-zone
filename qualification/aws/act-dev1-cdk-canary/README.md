# ACT-DEV-1 AWS CDK canary

The CDK counterpart of the Terraform canary in [`../act-dev1-canary`](../act-dev1-canary). It creates **one CloudWatch Logs log group** with the same name scheme (`/alz/act-dev-1/<name>`), 30-day retention and the same four tags (`environment=DEV`, `managed-by=sovereign-alz`, `purpose=act-dev-1`, `owner=<owner>`). It creates no compute, network, subnet, gateway or attachment, and it writes no log events.

This folder is an EXAMPLE. Nothing in it enables ACT. The reviewed pilot contract, approvals and every gate in [`docs/act-pilot-plan.md`](../../../docs/act-pilot-plan.md) still apply.

## What is committed

| File | Purpose |
| --- | --- |
| `app.js` | The CDK app: one `AWS::Logs::LogGroup` (L1 `CfnLogGroup`, no `DeletionPolicy`), in an environment-agnostic stack with termination protection declared. |
| `cdk.json` | Synthesis settings, and the EXAMPLE context values: `stackName`, `canaryName`, `owner`. |
| `package.json`, `package-lock.json` | Exact pins: `aws-cdk-lib` 2.272.0, `constructs` 10.8.1 and the CDK CLI `aws-cdk` 2.1144.0, the versions `src/plugins/catalog.ts` records as tested. |
| `cdk.out/` | The pre-synthesized cloud assembly the CDK engine reads. Synthesized from the EXAMPLE values. |

The synthesized template holds exactly one resource, `ActDev1` of type `AWS::Logs::LogGroup`. It has no `Parameters` (no `BootstrapVersion`), no `Rules` (no `CheckBootstrapVersion`), no `Conditions`, no `Outputs` and no `AWS::CDK::Metadata`. The `BootstraplessSynthesizer` writes no asset manifest, so nothing is published and no CDK bootstrap stack is needed. Creation stack traces are off, so the assembly does not record the build machine's paths.

## Inputs the operator supplies

| Input | Where | Rule |
| --- | --- | --- |
| `stackName` | CDK context | Must equal the DEV target's `backend` in the reviewed contract. |
| `canaryName` | CDK context | `/alz/act-dev-1/<name>`, where `<name>` is 3 to 50 of `a-z`, `0-9` and `-`. Use a new name for each run. |
| `owner` | CDK context | The approved owner tag. |

The account and region come from the reviewed contract; the assembly names neither. The Terraform canary is qualified only in `us-east-2`, so use the same region in the contract.

The engine passes no parameter values, so the inputs are fixed at synthesis. For a run, synthesize once on the build machine with the pinned packages, then choose the new `cdk.out` folder in `./alz apply prepare`:

```sh
npm ci
npx cdk synth --quiet --no-lookups --no-notices --output cdk.out \
  -c stackName=<contract backend> -c canaryName=/alz/act-dev-1/<new-name> -c owner=<approved owner>
```

The pilot itself never runs `cdk synth`, npm or the app. The unit tags (`alz-managed-by`, `alz-unit`, `alz-build`) are not in the template: the engine passes them as stack tags on the change set, and CloudFormation is expected to apply stack tags to the log group. That is UNVERIFIED until a live DEV run; the read-back below checks it.

## Expected preview

Exactly **1 create**: `ActDev1`, `AWS::Logs::LogGroup`. Anything else (a modify, a remove, a second resource) means the wrong stack or a changed assembly. Stop and do not approve.

## Read-back to verify after apply

- The stack is `CREATE_COMPLETE`. Termination protection is a person's step after the first create (`docs/act-pilot-apply.md`).
- `aws logs describe-log-groups --log-group-name-prefix <canaryName>` lists one group whose `logGroupName` is exactly `canaryName` and whose `retentionInDays` is `30`.
- The group's tags are the four above plus the three unit tags.
- No stored bytes or log streams: the canary writes nothing.

## Cleanup

The governed cleanup removes resources from the stack's template and never deletes a stack. Removing `ActDev1`, the only resource, would leave the stack empty, so the CDK engine refuses that cleanup with `CLEANUP_WOULD_EMPTY_STACK` (`removalTemplateOf` in `src/apply/engines/cdk.ts`). The stack and its log group are retained. Retiring the stack is the owner's separate decision, outside the pilot.

## Tests

`test/act-dev1-cdk-canary.test.ts` (SYNTHETIC): the pins, the template and manifest shape, the cleanup refusal, and one seal of the committed `cdk.out` through the real CDK engine with the fake `aws` of the CDK unit tests (exactly one create). With `ALZ_CDK_CANARY_SYNTH=1`, after `npm ci` here, it also re-synthesizes and requires the committed bytes.
