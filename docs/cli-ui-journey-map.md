# CLI commands and their UI callers

Which `./alz` commands the browser console can start, which it cannot, and which tests cover each. The console is deliberately small: it launches four bounded, read-only or synthetic workflows and reports their result. Everything else is an operator CLI command with **no UI caller**. That is a decision recorded here, not an oversight, and a test (`test/cli-ui-journey-map.test.ts`) fails if a command or console workflow is added without an entry below.

## How the console calls the CLI

The console (`./alz workspace`) posts `mode`, `scenario` and a CSRF token to `POST /run`. `chooseOperatorJob` (`src/operator-ui/server.ts`) maps the mode to one fixed job script; the browser cannot supply a script, arguments or a command. `GET /models` reports whether local models are installed and never gates a run.

| Console mode | Runs | CLI equivalent |
| --- | --- | --- |
| `matrix-offline` | `cli/private-agent-matrix.js --offline-fixture` | `./alz matrix --offline-fixture` |
| `matrix-live` | `cli/private-agent-matrix.js --live-models` | `./alz matrix --live-models` |
| `aws-review` | `cli/qualify-aws-terraform-agent.js --live-models` | `npm run`/`tsx src/cli/qualify-aws-terraform-agent.ts` (no `./alz` alias) |
| `chaos` | `cli/chaos-pillars.js` | `./alz chaos` |

## The map

`UI` = which console mode (or the console itself) calls it. `NONE` = operator-only. `Covered by` = the tests that exercise the command or its UI journey.

```journey-map
alz bootstrap | NONE | test/local-operator-workspace.test.ts
alz demo | NONE | test/operator-cli.test.ts
alz design | NONE | test/operator-cli.test.ts
alz inspect | NONE | test/operator-cli.test.ts
alz session | NONE | test/operator-cli.test.ts
alz debug | NONE | test/debug-diagnostics.test.ts
alz target | NONE | test/operator-cli.test.ts
alz recovery | NONE | test/operator-cli.test.ts
alz control-plane | NONE | test/control-plane-recovery.test.ts
alz economics | NONE | test/operator-cli.test.ts
alz teardown | NONE | test/teardown-traceability.test.ts
alz health | NONE | test/observability-health-server.test.ts
alz doctor | NONE | test/operator-cli.test.ts
alz verify | NONE | test/operator-cli.test.ts
alz plugins | NONE | test/operator-cli.test.ts
alz prompts | NONE | test/operator-cli.test.ts
alz prompt-guide | NONE | test/operator-cli.test.ts
alz models | UI:models-probe | test/operator-cli.test.ts, test/local-operator-workspace.test.ts, test/operator-ui-journey-fixes.test.tsx
alz sbom | NONE | test/operator-cli.test.ts
alz scan | NONE | test/operator-cli.test.ts
alz workspace | UI:host | test/local-operator-workspace.test.ts, test/operator-ui-react.test.tsx
alz matrix | UI:matrix-offline,matrix-live | test/local-operator-workspace.test.ts, test/operator-ui-react.test.tsx
alz chaos | UI:chaos | test/local-operator-workspace.test.ts, test/operator-ui-journey-fixes.test.tsx
console aws-review | UI:aws-review | test/local-operator-workspace.test.ts, test/aws-terraform-agent.test.ts
```

`alz models` is the one command with a partial UI relationship: the console shows whether the models `./alz models verify` would check are installed, using its own probe (`src/operator-ui/model-availability.ts`). It does not run `models verify`.

## What this means for teardown

`./alz teardown record | check-plan | destroy-preview | orphans` has **no UI caller and no browser journey**. It is covered by backend tests only (`test/teardown-*.test.ts`, including real-output fixtures), not by a UI journey test, because there is no UI journey to test. This is consistent with the recorded decisions for the destroy-preview driver: it is human-invoked, the operator authorizes each preview, and no agent or browser initiates one. If a teardown view is ever added to the console, it should be a read-only display of a verdict the CLI already produced, with its own journey tests; it must not gain a button that runs a preview or anything that changes infrastructure.

## Gaps this map does not close

- The `NONE` rows have CLI tests, not journey tests. A command being covered means its behavior is tested, not that an end-to-end operator journey (install, run, read the result, act on it) is exercised.
- The console journeys are covered with component tests and a server test against a fake runner. No committed real-browser journey check exists; adding one needs a decision on a browser-automation dependency.
- `aws-review` has no `./alz` alias, so its CLI equivalent is the script itself.
