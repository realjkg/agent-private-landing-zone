# AWS non-production deployment evaluation

Evaluated source: `cd3a04ec97f3345ebc6cc93561fd9baa3d3b24e2` (2026-11-03).

**Assessment:** the repository already has the LangChain/LangGraph runtime, AWS Terraform execution driver and a supervised DEV lifecycle. It is suitable for a local rehearsal and preparation of a governed DEV pilot. It is not yet evidenced as a successfully deployed AWS environment, and it is not a one-click AWS-hosted runtime.

## Findings and disposition

| Finding | Deployment effect | Disposition |
| --- | --- | --- |
| LangChain core, LangGraph and SQLite checkpoint packages are already locked dependencies; `src/session/graph.ts` runs the conversational graph | Adding another agent framework would duplicate the existing runtime | Reuse the existing graph; the AWS rehearsal includes its conversational lane |
| Home leads into broad multi-provider matrices; AWS instructions are scattered between terminal setup, account checks and the pilot brief | First-time operators cannot readily identify the shortest AWS path | Add a dedicated AWS DEV page and a single quickstart; select one existing AWS Terraform scenario |
| `.env.example` selects `mistral-nemo:latest`, while runtime defaults and release pins select `mistral-nemo:12b` | Copying the example causes a model readiness refusal | Correct the example and add a regression test against release model tags |
| All three model manifest digests are `null` in `config/tool-pins.json` | Live-model readiness refuses even when weights are installed | Keep the refusal visible; upstream digests still require independent verification and a reviewed commit. The registry was not resolvable from the evaluation environment |
| No enabled deployment contract is shipped; the first live AWS Terraform run remains owner supervised | Account, region, role delivery, state backend, signatures and qualification cannot be inferred from green unit tests | Document one exact handoff to the existing execution brief and its DEV-only contract |
| The existing DEV account checker expects governed Workloads/Control Tower enrollment | A standalone account cannot be advertised as immediately supported by this setup check | State the prerequisite and reuse the existing administrator path |
| AWS execution identities are separate from the setup SSO profile | A successful browser account check does not make Terraform ready to apply | Explain the four-role handoff explicitly |
| The cost-baseline payload has partially unverifiable resources and a documented nonempty-export-bucket cleanup hazard | It adds uncertainty to a first live pilot | Recommend the one-log-group canary first. For the cost payload, follow the existing brief; this change does not repair that separate cleanup path |
| UI and model endpoints are deliberately loopback-only | Publishing the UI or deploying it behind a public load balancer would change its trust model | Recommend a workstation runtime first. AWS-hosted runtime packaging/access requires a separate deployment design |

## Existing trust boundaries retained

- LangGraph sessions remove hosted LangSmith/LangChain tracing variables before graph execution (`src/session/hosted-tracing.ts`). Models use local Ollama.
- The browser reuses the existing job route, scenario allowlist and session CSRF token; navigation does not run a model or contact AWS.
- Model availability describes installed versions, not successful inference or AWS qualification.
- Offline and live-model rehearsals both use synthetic AWS discovery and infrastructure previews. Neither enables ACT.
- The existing protected pilot remains the only browser bridge to infrastructure execution, with its own owner-authored authorization and gates.

## Acceptance boundary

Local verification covers the AWS route, one-scenario requests, model readiness/refusal states, retry, session loss, blocked requests, run restoration, existing UI/security tests, the environment example and build. The rehearsal exercises the existing LangGraph code using fixtures. These are **synthetic/local** checks.

Validation on 2026-11-03 selected 17 test files with no coverage gaps:

| Check | Result |
| --- | --- |
| Runtime build and affected UI TypeScript check | Passed |
| Browser bundle and prerender | Passed; prerender used `node --import tsx` because the `tsx` CLI's IPC socket is denied by the execution sandbox |
| Six affected React test files | 76 passed |
| Configuration and QA-selector tests | 67 passed |
| Nine selected boundary/packaging test files | 1,559 passed; three packaging subprocess tests blocked by the same IPC restriction |
| One AWS Terraform offline rehearsal | Direct PASS, conversational LangGraph PASS, parity PASS |
| Standard affected-QA command | Attempted; blocked at the `tsx` prerender subprocess. The selected tests were run separately; this is not a complete green QA gate |

Full local logs are retained under `.runs/aws-nonprod/` in the implementation checkout. Re-run the standard affected QA on an unrestricted developer host or normal CI before merge. The three packaging failures were not suppressed or treated as passes.

Authentic acceptance still requires the intended execution host, verified model pins and real inference, the configured DEV account and identities, successful engine qualification, a reviewed plan, human-authorized apply, independent observation, separately approved cleanup and leftover verification. No AWS resources are created by this change. No production release status or live evidence is upgraded.

Start at [AWS non-production quickstart](aws-nonproduction-quickstart.md); use [the execution brief](act-aws-terraform-execution-brief.md) for the real deployment.
