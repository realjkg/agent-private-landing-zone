---
name: steward
description: Drive a pull request in this repository from claim to merge. Use when you implement a change, prepare a head for review, test-merge it, or merge a reviewed head. Covers claims on #39, the QA gate, supply-chain runs, the merge conditions, stacked PRs, escalation and worktree hygiene.
---

# Steward: drive a PR to merge

This page documents the workflow that already exists. It grants no authority. `AGENTS.md` is the rule; where this page and `AGENTS.md` differ, `AGENTS.md` wins. ACT stays DISABLED.

## 1. Work in a worktree, never in the main checkout

- Create a new worktree from `origin/main` in your scratch directory: `git fetch origin && git worktree add -b <branch> <dir> origin/main`.
- Run every command inside that worktree. In the main checkout, run only `git fetch` and `git worktree add`.
- Link the installed dependencies instead of reinstalling: `ln -s <main-checkout>/node_modules node_modules`. Use Node 26 (`export PATH=/root/.cache/node26/node_modules/.bin:$PATH` in the agent sandbox).
- Remove the worktree when the work is merged or abandoned.

## 2. Claim before editing (#39)

Issue #39 is the coordination ledger (`AGENTS.md`, "No-collision check-in").

- Post an `AGENT CHECK-IN` with phase, workstream, branch, base SHA, claimed paths, related issue or PR, and `status: ACTIVE`.
- Before claiming, read the ACTIVE claims on #39 and the changed files of every open PR. Do not edit a path another ACTIVE claim holds; sequence after it or re-scope.
- Shared integration files (workflows, central catalogs, package manifests, common entry points) have one owner at a time.
- Before the first push and again before handoff, refresh `origin/main`, repeat the overlap check, and confirm no claimed path changed underneath you.
- When the work merges, is abandoned or is handed off, post `AGENT CHECK-OUT` with `status: RELEASED`.

## 3. The QA gate

Defined in `AGENTS.md` ("Required affected-QA agent cycle") and `.github/agents/qa.agent.md`.

1. `node scripts/qa-affected.mjs plan --base origin/main` shows the selected tests (`.runs/qa/plan.json`).
2. `node scripts/qa-affected.mjs local --base origin/main`, then `npm run check`.
3. A coverage gap blocks. Add an owning test, or an ownership rule in `scripts/qa-affected.mjs` with a selector test in `test/qa-affected.test.mjs`. Never relax an assertion.
4. **Over the cap.** The selector refuses more than 45 affected test files (`MAX_AFFECTED_TESTS` in `scripts/qa-affected.mjs`). When that is the only gap, run the full quiet suite, `npm run test:quiet`, and record its counts. Its full logs are kept under `.runs/tests/`. A real coverage gap is never hidden behind the full suite.
5. Record the changed paths, selected tests, counts and the tested commit in the PR.

### The shared Ollama test port (11435)

The full suite binds `127.0.0.1:11435` (`test/model-production-workflow.test.ts`), so two full suites on one host collide.

- Before a full suite, check that port 11435 (hex `2CAB`) is not in `/proc/net/tcp` or `/proc/net/tcp6`, and that no other `test:quiet` is running. Serialize full suites; never run two at once.
- Disposition every failure on the exact commit you tested: fix it, or reproduce it on `origin/main` at the same base and record both results. Never waive a failure as "unrelated" (#39, 6443232624).

## 4. supply-chain.yml on the exact head

`.github/workflows/supply-chain.yml` runs the full `npm test`, the build, the audit, the SBOM and the Linux ARM64 image tests. On `pull_request` it triggers only for its listed paths, which include `alz`, `package.json`, `package-lock.json`, `Dockerfile` and `src/release/**`, but not `src/apply/**` or `src/operator-ui/**`.

- For a change to `src/apply`, dependencies, the launcher (`alz`) or the UI, make sure a `supply-chain.yml` run exists on the exact head. Where the path filter does not start one, dispatch it (`workflow_dispatch`) on that head.
- Its ARM64 test stage copies only some directories (`Dockerfile`, `test` stage). A test that reads a file outside them passes locally and fails there (#293, review 6442107608, B1).

## 5. Test-merge before handoff and before merge

Run `scripts/premerge.sh <head-sha>`. It:

- fetches `origin`, reports the files both `main` and the head changed since their merge base,
- test-merges the head onto current `origin/main` in a temporary worktree,
- runs the affected QA there (or, over the cap, the full quiet suite after the port check) and `npm run check`,
- removes the worktree and keeps logs under `.runs/premerge/<head>/`.

Exit 0 means every check passed. Exit 1 means a check failed or the merge conflicts. Exit 3 means a full suite is already running; wait and rerun.

Required CI repeats part of this: `pr-validation.yml` runs the same affected selector on each PR push. It does not run `npm run check` or the full-suite fallback, which is why the local test-merge stays required.

## 6. The nine merge conditions

`mergeBlockers` in `src/release/scheduler.ts` (described in `docs/release-scheduler.md`) lists them. A head merges only when none blocks:

1. within the declared release scope (`config/release/scope.json`) and its task;
2. independent review complete on the current head (see the `review` skill);
3. required checks and affected QA green on that head, with no check failed;
4. findings resolved: no blocking verdict and no later blocking comment;
5. compatible with current `main`;
6. the evidence names the current head;
7. no new security exception or policy change (those go to the owner);
8. not on hold (#228 is held);
9. branch protection permits the merge.

The head must be a full commit SHA. The task must not be BLOCKED, and every task it depends on (`config/release/work-graph.json`) must be DONE. Merge one head at a time.

## 7. Merging

- Merge only when the workstream is explicitly authorized to merge. Otherwise report `REVIEW REQUESTED: #N at <SHA>` and stop.
- Use a merge commit, with the expected head SHA set, so a head that moved after review is refused.
- Never force-push over another agent's work, and never bypass protection.
- The existing `.github/CODEOWNERS` routes every review request to the owner (`* @realjkg`).
- After the merge, record the PR, reviewed head and merge commit on #39 and in `config/release/work-graph.json` (then `npm run docs:release`).

## 8. Stacked PRs

When a PR's base branch merges, retarget the dependent PR to `main`, merge `origin/main` into it (no force push), rerun the QA gate on the new head and ask for review of that head. A review of the old head does not carry over.

## 9. Escalation

A failed check, a blocking review or a later blocking comment goes back to the owning lane for a root-cause fix (`AGENTS.md`, item 6). After two failed repair rounds on the same root problem, stop and escalate to the owner on #39 instead of starting a third (`OWNER_BUDGET.maxRepairRounds` in `src/release/scheduler.ts`). Only that task and its dependents stop.

## 10. Record on #39

Post check-ins, handoffs (`REVIEW REQUESTED: #N at <SHA>` with the gate results), repair rounds and check-outs on #39. Keep the work graph current; `docs/work-graph.md` is generated from it and is never edited by hand.
