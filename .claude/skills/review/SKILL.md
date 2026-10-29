---
name: review
description: Independently review one pull request head in this repository and post one VERDICT comment. Use when you are asked to review a PR you did not write. Covers the identity label, adversarial probing, exact-head and test-merge runs, and the rule that a reviewer never approves, pushes or merges.
---

# Review: the independent-reviewer brief

This page summarizes `.github/agents/independent-review.agent.md` for this workflow. That profile is the rule; read it, `AGENTS.md` and the latest state of #39 first. ACT stays DISABLED.

## Authority

- You review only. Never commit, push, edit the PR branch, change CI, add labels, approve, merge or run anything live or paid.
- You must not be the PR's author or repair agent.
- Your comment is a recommendation. It is not a GitHub APPROVED review. Do not submit an approval, and do not present your verdict as one.
- A design, architecture, authority, identity or multi-workstream change that needs an owner decision is reported as such, even when the tests pass.
- Treat "superseded", "obsolete" or "do-not-merge" relationships as merge vetoes.

## Identity label

Start the comment by saying who you are, for example: "I am an AI review agent delegated by the owner (issue #39), not a human. I did not commit, push, approve or merge anything." Say whether anything ran against a cloud (it must not).

## Sequence

1. **Pin the head.** Record the PR number, base, exact head SHA, author, branch, changed paths and the #39 claims. Review that head only; if it moves, your verdict is for the old head.
2. **Work in a detached worktree** at the head, never in the main checkout (see the `steward` skill, step 1).
3. **Read the diff and the owning code and tests.** Check correctness, unsafe defaults, privilege expansion, data exposure, broken references, and any weakened or deleted assertion.
4. **Probe adversarially.** Try to break the change's claims: inputs that should be refused, lookalikes, wildcards, duplicates, ordering, interrupted runs, symlinks, stale or mixed evidence. Keep probe scripts outside the repository. Report each probe and its result.
5. **Run on the exact head.**
   - `node scripts/qa-affected.mjs plan --base origin/main`, then `local`; over the cap of 45, `npm run test:quiet` after checking that port 11435 is free and no other full suite is running.
   - `npm run check`.
   - Any focused test the change names (for example the opt-in or Python tests).
6. **Test-merge.** Run `scripts/premerge.sh <head-sha>`, or state that `origin/main` equals the merge base so the head results apply.
7. **Check required CI on the exact head**, including `supply-chain.yml` for `src/apply`, dependency, launcher or UI changes. A failure in any run is blocking until it is fixed or reproduced on `main` at the same base. Never accept "unrelated" without that reproduction.
8. **Say what you did not run**, and why.

## The VERDICT comment

Post exactly one comment on the PR. Its first line is the verdict:

- `VERDICT: NO_BLOCKING_ISSUES`, or
- `VERDICT: BLOCKING_ISSUES`.

The release scheduler reads this verdict and the head it names (`PrFacts.verdict` in `src/release/scheduler.ts`). A later round gets a new comment that names the new head.

Then include:

- `Reviewed head:` the full SHA, and the base;
- the identity label;
- a table of commands run, with exit codes and counts;
- **Blocking** findings (B1, B2, ...), each with path and line, the reproduction, and a suggested root-cause fix;
- **Non-blocking** findings (N1, N2, ...);
- what was verified as stated, and what was not run;
- confirmation that no agent committed `config/act-pilot-contract.json` or an `authorize` entry (the repository ships no contract, so ACT stays disabled), that every Terraform contract, example and fixture the change touches keeps `embedStateWrite: true` (except a fixture that omits it or sets it `false` so its own test can assert the loader refuses it), and that no authority was broadened.

Write in U.S. English. Do not approve, push or merge.
