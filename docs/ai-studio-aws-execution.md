# AI Studio ↔ Sovereign ALZ — early AWS execution

## Decision

Early **real AWS infrastructure execution** is in scope for an explicitly authorized internal DEV pilot. The prior read-only MCP-only architecture is insufficient as the final capability. Do not bypass existing sealed-plan and human authorization boundaries.

## Existing implementation to reuse

- `src/apply/driver.ts`, `src/cli/apply.ts`, and `src/cli/ui-channel.ts`
- Terraform sealed-plan apply and AWS CDK sealed CloudFormation change-set execution
- Pinned contract, environment-bound identities, signed approval, kill switch, encrypted evidence
- See `docs/act-pilot-plan.md`, `docs/act-pilot-apply.md`

## First new code slice

`src/integrations/ai-studio/aws-execution.ts` implements conservative capability negotiation. An eligible Terraform/CDK internal DEV case is **only a routing recommendation to the existing human pilot driver**, not a permit to execute. All existing driver checks remain authoritative. The MCP agent may request and inspect an operation but cannot directly apply via this facade.

It does **not** expose an HTTP listener, implement MCP transport, validate a JWT, deploy AWS resources, qualify an engine, or enable the pinned pilot contract. Each is a separate gate. AI Studio can only connect after an authenticated remote MCP gateway is implemented.

## Engineering sequence

1. Run tests for this change and existing apply contract: `npm run build && npm run test:node`.
2. Verify exact-source CI and CodeQL and reconcile with auth-provider PR #163.
3. Qualify **real Terraform and AWS CLI/CDK binaries** against an isolated owner-supplied AWS DEV account: discovery, preview, identity separation, state/lock, scoped IAM, asset and rollback behavior.
4. Operator enables only the audited and pinned pilot contract after this qualification. Keep the existing human interactive approval requirement.
5. Execute a reversible minimal AWS DEV resource, collect authenticated signatures and encrypted evidence, verify state and resource, then exercise recovery.
6. Complete separate CloudFormation-direct and Pulumi execution engines and their own denial/approval/rollback tests. Do not accidentally treat CDK's CloudFormation change-set apply as a generalized CloudFormation direct driver.
7. Implement MCP Streamable HTTP and OAuth/OIDC resource-server verification; publish read-only and proposal tools first. Add human workflow handoff/status; **never make token possession equivalent to infrastructure approval**.
8. Confirm hosted AI Studio handshake and end-to-end agent → MCP → operator-reviewed pilot → AWS evidence.

## Acceptance

No unrestricted AWS permissions, no customer-resource adoption, no secret serialization, no CI failure, no ungrounded PASS claim. Every ACT requires the sealed artifact, signed approval, exact target, valid contract, qualified engine, distinct identities, working kill switch, and authoritative cloud result. Production authorization remains a separate phase.
