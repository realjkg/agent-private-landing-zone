# Release scheduler

The release mandate needs a scheduler. Each tick it picks a dependency-ready task, assigns one owner, verifies the output, integrates eligible work and moves on. A blocked task stops only the work that depends on it, never the whole release. This page describes how that runs, and how it resumes after an interruption.

## Parts

| Part | Where | What it holds |
| --- | --- | --- |
| Work graph | `config/release/work-graph.json`, rendered to `docs/work-graph.md` | Tasks, dependencies, owners, branches, PRs, gates and status. It is the plan of record. |
| Decision step | `src/release/scheduler.ts` | `schedule(graph, prFacts, state)` returns one tick's actions: `MERGE`, `REVIEW`, `FIX`, `DISPATCH`, `ESCALATE` or `WAIT`. It decides; it executes nothing. |
| Checkpoint | A comment on the coordination issue (#39) starting with `<!-- alz-release-scheduler-checkpoint -->`, edited in place after each tick | The tick number, `main`'s head, the active workers and reviews, and the outcome of each action from the last tick. |
| Runner | A scheduled task that fires into the coordinating session every hour | It runs one tick, carries out the actions, and writes the checkpoint back. |

## The rules

The decision step enforces these rules in code, and `test/release-status.test.ts` tests them.

- **Merge:** a head is merged only when `mergeBlockers` returns nothing. It checks the nine mandate conditions, one fact each:
  1. in scope (`inScope`);
  2. independent review complete on the current head (`verdict.head`);
  3. required checks and affected QA green on that head, with no check failed;
  4. findings resolved: no blocking verdict and no later blocking comment;
  5. compatible with main;
  6. the evidence names the current head (`evidenceHead`);
  7. no new security exception or policy change;
  8. not on hold;
  9. branch protection permits the merge (`protectionsPermit`).

  A head that is not a full commit SHA never merges. The task must also not be BLOCKED, and every task it depends on must be DONE. Integration is serialized, with at most one merge per tick. The merge records the reviewed head and the merge commit.
- **Budget:** the owner's budget is one implementation lane and one concurrent reviewer (`OWNER_BUDGET`). A green, unreviewed head waits for the reviewer slot.
- **Repair:** a failed check, a blocking review or a later blocking comment goes back to the task's owner as `FIX`. After two repair rounds on the same root problem, the next finding escalates instead of starting a third. Only that task and its dependents stop.
- **Dispatch:** a task runs only after its dependencies are done, and only with one owner. Tasks owned by `OWNER`, `EXTERNAL` or `DEPENDABOT` are never dispatched to an agent. A task with a PR the tick has no facts for, or with more merged PRs than the graph records, waits for the record instead of getting a second owner.

## Resume

Every tick starts from the checkpoint, never from memory.

1. Read the checkpoint and the work graph, and fetch the current state of every PR in the graph from GitHub.
2. Compute `resumeState(checkpoint, liveWorkers)`. A worker named in the checkpoint that the session can no longer reach is presumed lost. Its task goes back to the scheduler, which dispatches it again with an instruction to resume from the task's branch. Nothing is redone from scratch while a branch exists.
3. Run `schedule(...)` and carry out the actions, then edit the checkpoint.

A container restart or a lost session therefore costs at most one tick. The next firing, or a new session reading the checkpoint, picks up where the last one stopped.

## Boundaries

The runner acts only within the release mandate:
- it never runs anything live or paid;
- it never enables ACT;
- it never touches held PRs (#228);
- it never creates agents beyond the owner's budget.

Anything that needs the owner is escalated, and the runner keeps scheduling the work that doesn't depend on it.
