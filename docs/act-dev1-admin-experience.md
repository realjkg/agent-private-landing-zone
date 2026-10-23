# ACT-DEV-1: Guided administrator journey

The local Sovereign ALZ console is the primary workflow for an authorized administrator. Open **Pilot apply → Set up AWS DEV**. No IAM specialist knowledge is required to understand the steps, their evidence requirements or their blocked states. The operator only needs the approved saved AWS connection and dedicated DEV account number for the initial check.

## Operator experience

1. **Connect AWS.** Using the existing protected pilot session, verify the management sign-in, active dedicated DEV member account, Workloads OU membership and Control Tower baseline. The check invokes only fixed read-only AWS API commands. Refusal explains the needed correction without exposing raw AWS errors.
2. **Confirm spending.** Owner reviews an approved maximum cost, verified budget notifications and least-privilege service bounds. AWS Budgets is not a hard spend limit.
3. **Prepare access.** A qualified account owner performs the separately protected AWS bootstrap ceremony for state, policy boundary and four distinct roles. Do not auto-assume or forge a sign-in.
4. **Verify roles.** Existing scripts independently validate the four short-lived role subjects and successful AWS STS assumptions. The local setup screen cannot create tokens or grant an AWS permission.
5. **Review exact changes.** The existing Pilot apply wizard shows additions, modifications and terminations, warns about destructive changes, explains that local policy checks and approvals still apply, and requires the normal source-bound proof. For ACT-DEV-1 the canary is CREATE-only.
6. **Approve, apply, verify.** The *existing* Pilot UI channel owns the human prompts, signatures, contract pinning, policy evaluation, execution and evidence. The new setup panel **never** starts Terraform or invents a second apply route.

## Technical boundaries

The AWS account check is a protected `POST /pilot/aws-readiness` route. Its body accepts only `{account,profile}`, with constrained characters. It requires the session token and same-origin policy used by the existing Pilot channel. It cannot return credential material, accepts no AWS operation names from the caller, and never authorizes ACT. Wrong account, missing OU/baseline, invalid local connection or failed AWS CLI command reports a blocked state. The target account cannot be the Organizations management account.

The old Operations role-preparation screen now leaves GitHub OIDC subjects **unset** until an exact actual identity claim has been observed, and links to the guided pilot. It does not create trust grants.

## Remaining connected capabilities

This iteration adds **read-only connected account verification** and **guided change review**. Owner-authorized member-account creation, account bootstrap, budget alerts and four-token broker setup remain intentionally outside this browser's execution authority. Connected verification of those later gates and guided provisioning are future implementation work, and cannot be inferred from a green account check. Production release remains separate from the DEV canary.

## Focused synthetic acceptance

- `test/act-dev1-admin.test.ts` verifies fixed read-only commands, account scope and fail-closed governance.
- `test/act-dev1-admin-ui.test.tsx` verifies a non-specialist browser journey, protected request and refusal.
- `test/ui-channel.test.ts` verifies CSRF/session/origin controls and rejection before AWS calls.
- `test/pilot-wizard.test.tsx` verifies add/modify/remove totals and governance/access warnings.

No credentials, private OIDC token, secret, or real AWS billing resource should be included in test fixtures. Issue #199 tracks authenticated DEV acceptance and the owner-run prerequisites.
