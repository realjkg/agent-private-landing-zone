# Unattended engineering release contract

This document defines the implementation and acceptance contract for an unattended ALZ coding runtime. It does **not** claim that a hosted model runner or separately authenticated reviewer is installed.

## Release lanes

1. **Design:** An issue describes one customer-facing outcome, owning paths, interfaces, negative cases and acceptance criteria.
2. **Build:** A coding agent operates on an isolated branch with an explicit path allowlist, limited GitHub permissions and a bounded attempt budget.
3. **Prove:** Run `node scripts/qa-affected.mjs local --base origin/main` before pushing, then use the repository's affected-code PR validation. Never treat a full regression as the normal iteration loop.
4. **Review:** An independent identity inspects the exact-head diff and submits a qualifying review where required. The coding identity never self-approves.
5. **Merge:** Native GitHub auto-merge waits for branch-required checks. The supersession veto and `automerge:approved-scope` gate remain effective.
6. **Release:** Perform consolidated qualification against an immutable candidate; retain authentic evidence for any provider or packaged-install claim.

## Runner acceptance requirements

- Explicit opt-in invocation through a scoped engineering issue or dispatch input; never start from arbitrary untrusted PR comments.
- Require `issue_number`, `base_sha`, `owned_paths`, `acceptance_criteria` and `max_attempts` (1–2). Reject empty or wildcard ownership and overlapping active claims in #39.
- Pin external actions and agent dependencies; protect secrets from untrusted issue bodies, PR branches and model outputs.
- Use a dedicated coding identity if independent `realjkg` reviews are intended; otherwise request a different independent reviewer.
- Restrict token permissions to repository code and PR operations required by the task. Never provide cloud provider credentials, apply tokens, privileged runner access or workflow-modification permissions to the coding runtime.
- Run one affected-code QA plan per candidate revision, publish concise evidence and stop on repeated failures. Never poll continuously or auto-retry indefinitely.
- A code-only runner must not modify `.github/workflows/**`, `AGENTS.md`, authorization/policy boundaries, secrets, or ACT code unless separately scoped for human review.
- Do not apply `automerge:approved-scope` to architectural, security, identity, cloud ACT or release-authority changes.
- If no authorized runtime, model credentials or independent reviewer identity is configured, leave the task pending and report the missing prerequisite; do not simulate agent execution or fabricate a GitHub approval.

## Qualification before enabling unattended execution

Use a disposable code-only issue with a small, deterministic test change. Capture runner identity, issue and branch, owned paths, exact-head SHA, affected QA output, required check conclusions, independent review and native merge result. Verify rejection of out-of-scope edits, superseded PRs and missing authorization. Log the evidence in #39.

## Current status

- Agent instruction profiles: present in `.github/agents/`.
- Protected merge admission: `.github/workflows/reviewed-auto-merge.yml` is **removed for the release freeze** (issue #39). Restore it by reverting the freeze-control commit that removed it.
- Hosted unattended coding runner: **not yet installed or qualified**.
- Separate coding/reviewer identity: **not yet configured or qualified**.
- AWS ACT: **not enabled by this contract**.
