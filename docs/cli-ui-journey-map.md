# CLI commands and their console equivalents

Which `./alz` commands the browser console covers, and which tests cover each. Every operator-callable capability has an entry in the operation catalog (`src/operations/`); the console runs the safe ones and shows a guided handoff for the rest. The generated table in [operator-console.md](operator-console.md) lists every entry with its safety class. `test/operations-parity.test.ts` fails when a command or script has no catalog entry, and `test/cli-ui-journey-map.test.ts` checks this map against the dispatcher and the catalog.

## How the console calls the CLI

The console (`./alz workspace`) posts either the legacy `mode`, `scenario` and a CSRF token, or `operation`, `inputs` and the token, to `POST /run`. `chooseOperatorJob` and the catalog (`src/operations/`) map the request to one fixed job script; the browser cannot supply a script, arguments, a path or a command. Pasted JSON is validated, written by the server to a private `0700` directory and deleted afterward. `GET /operations` lists the public descriptors and `GET /models` reports whether local models are installed; neither gates a run.

| Console mode | Runs | CLI equivalent |
| --- | --- | --- |
| `matrix-offline` | `cli/private-agent-matrix.js --offline-fixture` | `./alz matrix --offline-fixture` |
| `matrix-live` | `cli/private-agent-matrix.js --live-models` | `./alz matrix --live-models` |
| `aws-review` | `cli/qualify-aws-terraform-agent.js --live-models` | `npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models` (no `./alz` alias) |
| `chaos` | `cli/chaos-pillars.js` | `./alz chaos` |

## The map

One row per `./alz` command word or catalog command group. `Covered by` = the tests that exercise the command or its console journey. `bootstrap` (shell wrapper) and `workspace` (the console host) have no catalog entry by design. `enterprise` and `qualify` are catalog command groups for the enterprise libraries and the release qualification checks.

```journey-map
alz bootstrap | test/local-operator-workspace.test.ts
alz demo | test/operator-cli.test.ts
alz design | test/operator-cli.test.ts
alz inspect | test/operator-cli.test.ts
alz session | test/operator-cli.test.ts
alz debug | test/debug-diagnostics.test.ts
alz target | test/operator-cli.test.ts
alz recovery | test/operator-cli.test.ts
alz control-plane | test/control-plane-recovery.test.ts
alz economics | test/operator-cli.test.ts
alz teardown | test/teardown-traceability.test.ts
alz apply | test/apply-cli.test.ts, test/apply-boundary.test.ts
alz health | test/observability-health-server.test.ts
alz deps | test/deps-cli.test.ts, test/deps-install.test.ts
alz doctor | test/operator-cli.test.ts
alz verify | test/operator-cli.test.ts
alz plugins | test/operator-cli.test.ts
alz prompts | test/operator-cli.test.ts
alz prompt-guide | test/operator-cli.test.ts
alz models | test/operator-cli.test.ts, test/local-operator-workspace.test.ts, test/operator-ui-journey-fixes.test.tsx
alz sbom | test/operator-cli.test.ts
alz scan | test/operator-cli.test.ts
alz account-factory | test/account-factory.test.ts, test/operations-parity.test.ts
alz enterprise | test/operations-core.test.ts, test/operations-parity.test.ts
alz qualify | test/operations-qualification.test.ts, test/operations-parity.test.ts
alz workspace | test/local-operator-workspace.test.ts, test/operator-ui-react.test.tsx
alz matrix | test/local-operator-workspace.test.ts, test/operator-ui-react.test.tsx
alz chaos | test/local-operator-workspace.test.ts, test/operator-ui-journey-fixes.test.tsx
console aws-review | test/local-operator-workspace.test.ts, test/aws-terraform-agent.test.ts
```

## What this means for teardown

`./alz teardown record | check-plan | destroy-preview | orphans` are read-only verdicts; the console can show what the CLI already produced. `./alz teardown destroy-preview-run` and `preview-run`, the human-invoked entry to the preview driver (`docs/destroy-preview-driver.md`), are never run by the console: they need a real terminal on stdin and stdout where a person types the exact target (Decision 1 in `docs/teardown-broker-review.md`). In the console they are a guided handoff: what the command does, why it needs a terminal, the exact command filled in from the form, and a read-only viewer for the redacted evidence it wrote. The rules are enforced by `test/cli-ui-journey-map.test.ts`: the console server and `src/operations/` never import or spawn the driver, no runnable entry's job points at it, and no job argument list can contain `destroy`, `preview-only`, `apply` or `auto-approve`.

## Gaps this map does not close

- A covered command has tests for its behavior, not necessarily an end-to-end operator journey (install, run, read the result, act on it).
- The console journeys are covered with component tests and a server test against a fake runner. No committed real-browser journey check exists; adding one needs a decision on a browser-automation dependency.

## What this means for the pilot apply

`./alz apply qualify | seal | approve | apply | status` is the human-invoked entry to the pilot apply driver (`docs/act-pilot-apply.md`). The Operations catalog shows it as one guided handoff (the command, that it needs a person, the identity variable names) and never runs it. A person can instead run the whole workflow in the console's Pilot apply wizard (`docs/act-pilot-walkthrough.md`), which uses the same commands through `src/cli/ui-channel.ts` after the person pastes the session token printed in the terminal; a workflow runs in one channel only. `test/apply-boundary.test.ts` pins that nothing the broker, agents, orchestration or the catalog can reach imports `src/apply`, `src/cli/apply.ts` or the adapter, that from the console side only the adapter does (mounted only by the console server), that only the CLI calls the driver, and that the catalog validator refuses a job whose script is `cli/apply.js` or `cli/ui-channel.js`.
