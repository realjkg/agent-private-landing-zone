# Release-candidate readiness

This document is the operator handoff for the current release candidate and the next simulated landing-zone build phase.

## Current release posture

Private-model hardening is complete.

Existing qualification evidence demonstrates that the standard GitHub-hosted runner can qualify:

- Qwen3 1.7B
- Qwen3 4B
- Mistral Nemo
- the integrated required Qwen/Mistral stack
- optional Qwen3 8B

The successful live qualification used a standard hosted runner with 4 CPUs and 15 GiB of memory. The security timeout was not relaxed to obtain the passing result.

The release retains these boundaries:

- ACT is disabled
- model output is advisory
- direct prompt attacks are rejected before model invocation
- hostile imported evidence remains a live-model security test
- arbitrary shell is unavailable
- adapter previews do not grant mutation authority
- operator approvals and capability grants remain deterministic

## Release validation policy

Use the smallest check needed during implementation.

Do not run full end-to-end qualification for every PR or merge.

Heavyweight release gates are manual:

- Private Model Qualification
- Agent Private Landing Zone Supply Chain

Run them only when fresh evidence is actually required for the release decision.

The required Qwen/Mistral stack is the default private-model release gate. Qwen3 8B is opt-in.

## Agent coordination

All coding agents follow the root `AGENTS.md` protocol and use Issue #12 as the ownership ledger.

Before editing:

1. check ACTIVE claims
2. inspect open PR changed files
3. claim a branch and path scope
4. avoid shared-file edits unless one integration owner has explicit ownership
5. refresh the base before handoff

This keeps parallel workstreams from colliding at code level.

## Agent-assisted simulated landing-zone builds

After release-candidate readiness closes, the next phase exercises the adapters in parallel using both direct adapter invocation and conversational guidance.

Each lane follows the same chat sequence:

### 1. Intent

Example:

> Review this simulated AWS brownfield landing zone. Preserve existing ownership, identify the minimum safe platform delta, and use Terraform for the preview.

### 2. Discover

The agent summarizes:

- provider and environment classification
- observed resources
- ownership/source of truth
- evidence present
- evidence still UNKNOWN

The operator can ask:

> What do we know, and what are you refusing to assume?

### 3. Assess

The agent identifies the strongest current risks and constraints.

The operator can ask:

> Which security, resiliency, ownership, or recovery issue should affect the design first?

### 4. Design

The agent proposes the delta using:

- REUSE
- INTEGRATE
- CONFIGURE
- ADD
- NO_TOUCH
- BLOCKED

The operator can ask:

> Explain why each existing resource is being reused, changed, or left alone.

### 5. Adapter selection

The operator can keep the assigned lane adapter or ask for a comparison:

> Why Terraform here instead of Pulumi or CloudFormation?

The agent may explain or compare supported preview paths, but it cannot grant itself new capabilities.

### 6. Build preview

The selected adapter generates a governed preview only.

No apply, deploy, destroy, execute-change-set, or equivalent mutation is permitted.

### 7. Evidence review

The agent reports:

- normalized ChangeSet
- artifact/preview hashes
- required capability grants
- assumptions
- UNKNOWN state
- safety blocks
- adapter-specific limitations

The operator can ask:

> Show me the evidence for this preview and anything that would stop release.

### 8. Next step

The agent explains what evidence, approval, or design change would be needed next.

Every sequence ends with the same authority statement:

> No infrastructure changes were made. ACT remains disabled.

## Adapter lanes

The queued simulated build program covers:

- Terraform
- Pulumi
- OpenTofu
- Bicep
- CloudFormation
- AWS CDK
- Ansible
- Crossplane

Each lane gets its own branch and adapter-specific ownership. Shared runtime, policy, catalog, workflow, package, or common ChangeSet files require explicit integration ownership before editing.

## Comparison requirement

For each simulated build, capture both:

- direct adapter result
- agent-assisted conversational result

They should converge on materially consistent:

- desired outcome
- ownership boundaries
- DesignSpec intent
- normalized ChangeSet semantics
- assumptions and UNKNOWNs
- safety decisions

A mismatch is a product defect or design inconsistency to investigate; it is not a reason to make the conversational path more permissive.

## Release evidence already available

The current phase already produced:

- private-model security-boundary hardening
- successful required-stack live qualification
- successful optional Qwen3 8B qualification
- fast deterministic PR validation
- no-collision agent coordination rules
- manual-only heavyweight release workflows

Do not regenerate those artifacts unless the runtime or release decision actually requires fresh evidence.
