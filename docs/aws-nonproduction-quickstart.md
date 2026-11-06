# Start with AWS DEV

Use the private runtime on your workstation and a dedicated AWS development member account. This is the shortest supported first-run path: **open the workspace → rehearse one AWS workflow → prepare DEV → review, apply, verify and clean up one canary**.

LangChain and LangGraph are already installed with the application. No OpenAI, Bedrock or LangSmith account is needed. Qwen and Mistral run locally through Ollama. The first rehearsal can run entirely offline while the real AWS prerequisites are prepared.

## 1. Open the workspace

Install Git and Node 26, then run:

```sh
git clone https://github.com/realjkg/agent-private-landing-zone.git
cd agent-private-landing-zone
./alz bootstrap
./alz
```

Bootstrap installs the locked dependencies and builds the runtime and browser UI. It does not install models or create AWS resources. Keep the source checkout clean: evidence-producing workflows require a committed source identity. If you change source or configuration, review and commit those changes, then rebuild with `./alz bootstrap`.

On an interactive Mac, `./alz` opens the workspace. If no browser opens, run `./alz workspace` and open the printed loopback URL on that same machine. Select **AWS DEV**, or **Start with AWS DEV** on Home. Bookmark `http://127.0.0.1:8788/#aws-dev` when using the default port.

## 2. Rehearse once

Choose **Rehearse offline**. This runs just the AWS Terraform scenario, including its direct and conversational LangGraph paths. The reasoning and AWS inventory are fixtures; no model service, AWS account or cloud sign-in is needed. A passing result proves only this rehearsal.

For private inference, install the pinned Ollama version using the existing `./alz deps` guidance. Deliberately start Ollama on this machine, then install these models (downloads use bandwidth and disk space):

```sh
ollama pull qwen3:1.7b
ollama pull qwen3:4b
ollama pull mistral-nemo:12b
```

**Model release pins are a remaining prerequisite.** At the evaluated base, the three `config/tool-pins.json` → `isolatedOllama.modelDigests` values are `null`. A maintainer must independently verify each upstream manifest SHA-256 against the installed model and commit the reviewed pins. Pulling weights alone does not establish release readiness; never substitute a guessed hash or turn off the check. The source and verification procedure are described in that file. `./alz models verify` checks the installed models against the committed pins.

Return to **AWS DEV → Check private models again**, then choose **Rehearse with private models** when available. The readiness check checks installed model versions; the rehearsal actually exercises inference. Its AWS inventory and previews remain simulated.

The defaults already select the correct three model tags and `http://127.0.0.1:11434`. An environment file is optional. If you need overrides, copy `.env.example` to `.env`, review it, and explicitly export its settings in the shell that starts `./alz`; the launcher does not automatically load `.env`. Do not use `mistral-nemo:latest`, which is not the pinned release tag. The separate qualification service uses port 11435; do not confuse it with the ordinary Ollama endpoint.

## 3. Connect the development account

Choose **Continue to AWS account setup → Set up AWS DEV**. Use the saved AWS profile provided by your administrator and the 12-digit dedicated DEV member account number. The existing account check is read-only and expects the repository's governed Workloads/Control Tower enrollment. An arbitrary standalone sandbox is not automatically equivalent to that account setup.

If your profile uses IAM Identity Center, sign in from a terminal first:

```sh
aws sso login --profile YOUR_PROFILE
```

Use your actual profile name, not the example. Keep AWS access keys, session tokens and private approval keys out of the browser. Your SSO profile supports the setup/account check; it does not replace the four isolated identities required by the live deployment driver.

If you do not already have the required member account, ask your AWS administrator to prepare one. Account Factory is an optional, separately confirmed provisioning workflow; it is not required for the offline rehearsal. Do not deploy workloads into an organization management account.

## 4. Prepare the first live change

Have the AWS administrator and pilot owner complete the [AWS Terraform execution brief](act-aws-terraform-execution-brief.md). That is the authoritative deployment procedure; this page does not replace its checks.

For the smallest first deployment, use the committed [single CloudWatch log-group canary](../qualification/aws/act-dev1-canary/main.tf). Keep DEV isolated from production and use Terraform. Defer the optional cost-baseline payload and other engines until this lifecycle is proven.

| Prerequisite | Who supplies it | Where it is checked |
| --- | --- | --- |
| Dedicated DEV member account and AWS region | AWS administrator | Account setup and pilot preflight |
| Short-lived DISCOVERY, STATE, STATE_WRITE and APPLY identities | AWS administrator | Identity delivery and `./alz apply preflight` |
| Versioned S3 state bucket, locking and separation of state access | AWS administrator | [AWS bootstrap](act-pilot-bootstrap.md), qualification and sealed backend checks |
| Exact AWS CLI/Terraform versions | Operator | `./alz deps` and pilot qualification; use `config/tool-pins.json` |
| DEV-only reviewed contract, exact target and resource allowlist | Pilot owner | `./alz apply contract-check --file PATH_TO_DRAFT`; the owner authors the authorization |
| Ed25519 approval key, public key on the allowlist, and spending decision | Pilot owner / DEV approver | Sealed request and approval checks |
| Encrypted evidence setup and a qualified execution host | Operator | Execution brief and `./alz apply qualify` |

The repository ships no enabled pilot contract. The workstation operator can also be the DEV approver where the reviewed contract permits it. No agent, UI stage selection or passing rehearsal supplies missing authorization.

## 5. Apply, verify and close

Follow the execution brief in one channel throughout: either the terminal sequence or **Pilot apply** with its one-time local session token. Review the precise plan, approve it, then explicitly execute it. Independently observe the created resource. Review and approve cleanup separately, then verify that nothing remains from the canary.

A model-assisted proposal does not deploy infrastructure by itself. The pilot enforces the reviewed contract, isolated identities, qualification, signatures, sealed plan, single-use ledger and kill switch even for DEV.

Budgets send alerts; they do not cap charges. Agree on the allowed resource, retention, time window and cost before applying. If an apply is interrupted or reports a partial result, inspect recorded evidence and observed resources before any new plan. Do not blindly repeat the original apply or delete Terraform state.

## When setup stops

| Message or symptom | Next action |
| --- | --- |
| No local model server / missing models | Start the pinned Ollama service and deliberately install the listed models; recheck |
| Missing release digest / wrong model version | Review the upstream model pins and installed digests; do not bypass the comparison |
| Readiness unknown | Check the local workspace and model service, then retry the read-only readiness check |
| Source worktree dirty / workspace needs build | Review and commit intended source changes, then `./alz bootstrap` |
| AWS account cannot be verified | Check SSO session, profile, account ID and governed enrollment with the administrator |
| Contract, identity or qualification refused | Use the exact next step in the execution brief and the pilot's diagnostic; changing the stage selector cannot fix it |
| Lost local browser session | Restart `./alz`, reopen its URL and inspect the existing run status before starting another run |

For the evaluated gaps and the distinction between local checks and authentic AWS acceptance, see [the non-production evaluation](aws-nonproduction-evaluation.md).
