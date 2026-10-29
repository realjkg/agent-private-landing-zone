---
name: act-pilot
description: The ACT DEV pilot journey and who may do each step. Use when you work on src/apply, the pilot console, bootstrap, the pilot contract, qualification or cleanup, or when you are asked what is needed to enable ACT for a DEV path. Separates agent engineering from the owner's steps.
---

# ACT pilot: the DEV journey and its boundary

ACT is DISABLED. The only exception is the owner-approved pilot for the internal reference build, governed by `AGENTS.md`, [`docs/act-pilot-plan.md`](../../../docs/act-pilot-plan.md) and its gates. The step-by-step checklist with exact commands is [`docs/act-dev-enablement.md`](../../../docs/act-dev-enablement.md). This page does not repeat them; read both before working on the pilot.

## Paths are separate capabilities

Each execution path is its own capability, with its own contract scope, qualification and evidence. One never implies another.

| Path | Code today | Release gate |
| --- | --- | --- |
| AWS Terraform | `src/apply/engines/terraform.ts`, `src/apply/providers/aws.ts` | `act:aws-terraform` |
| AWS CDK / CloudFormation | `src/apply/engines/cdk.ts`, `src/apply/providers/aws.ts` | `act:aws-cdk` |
| Azure Terraform | `src/apply/engines/terraform.ts`, `src/apply/providers/azure.ts` | `act:azure-terraform` |
| Azure Bicep / ARM (DEV only) | `src/apply/engines/bicep.ts`, `src/apply/providers/azure.ts` | `act:azure-bicep` |
| GCP Terraform | PLAN and G0 docs only (`docs/act-pilot-gcp-terraform-g0.md`) | none yet |
| GCP API-native | none yet | none yet |

The gates come from `ACT_RELEASE_PATHS` in `src/qualification/release-admission.ts`. The current blockers, owners, required evidence and next actions for each path are in [`docs/work-graph.md`](../../../docs/work-graph.md), generated from `config/release/work-graph.json` (`path-*` nodes).

## What an agent may do

- **Engineering:** code, tests and docs for the driver, engines, providers, contract validation, readiness, cleanup and the console wizard, through the normal PR workflow (`steward` skill).
- **Synthetic evidence:** fake-engine tests and the opt-in emulated simulations (G1b: `docs/act-pilot-simulation-aws.md`, `docs/act-pilot-simulation.md`). Label it SYNTHETIC. It never counts as live provider qualification or release approval.
- **Read-only helpers:** commands that compute, check or report without changing anything, for example `./alz apply contract-check --file <draft>`, `./alz apply status`, `./alz apply preflight`. Run them on fixtures or the owner's draft only when asked.

## What only the owner may do

An agent never does these, never writes their inputs, and never holds their keys:

- **Bootstrap** the cloud accounts or subscriptions (`bootstrap/aws`, `bootstrap/azure`; `docs/act-pilot-bootstrap.md`).
- **Federated identity:** create the OIDC or workload identity trusts and the per-identity roles.
- **Live qualification:** `./alz apply qualify` on a host with the real engine, bound to the DEV target (G2).
- **Authorization:** the owner's reviewed commit of `config/act-pilot-contract.json` with a non-empty `authorize` entry. That entry names, default deny, the operations (`APPLY`, `CLEANUP`, `REMOVE`) ACT may run per environment for the contract's provider, engine and account (owner decisions of 2026-10-27, #39; `docs/act-pilot-apply.md`, "The contract is the authorization"). The shipped product (its image and field package) carries no contract, and an absent contract or an absent or empty `authorize` keeps ACT disabled. A Terraform contract must set `embedStateWrite: true` or it does not load (owner decision 6486426552). The old hash pin `config/act-pilot-contract.sha256` is removed with no fallback. Agents never write the contract or its `authorize` entry.
- **Approvals:** the requester's and approvers' Ed25519 signatures (`src/apply/approval.ts`). Agents never sign, never hold or read an approver or requester key, and never fabricate an approval or a typed confirmation, in every channel.
- **Starting applies and cleanups:** a person at the terminal, or a person in the console's Pilot apply wizard with the one-time session token. The console's job table never starts one (`test/apply-boundary.test.ts`). The agent channel proposed in [`docs/act-plan-2.md`](../../../docs/act-plan-2.md) (an agent starts the apply of a sealed plan that a person has signed) does not exist until that PLAN's lanes are implemented, reviewed and merged and the owner's contract authorizes `AGENT_APPLY`. Until then agents and automation never start one, and an engineering agent working in this repository never does.
- **Recording live evidence and admission:** `./alz apply record-live`, `./alz apply record-recovery`, `./alz qualify admission`.

## Kill switch

The contract's `killSwitchPath` names a file (`.runs/apply/KILL` in the examples). While it exists, seal, qualify and apply refuse, and a running apply is stopped. A switch that cannot be read counts as on. Only the owner removes it; the code never does. Details: [`docs/act-dev-enablement.md`](../../../docs/act-dev-enablement.md), "Kill switch", and `docs/act-pilot-apply.md`.

## Rules that do not bend

- Never enable ACT, write `config/act-pilot-contract.json` or an `authorize` entry, or initiate an apply or cleanup.
- Never run anything against a real cloud, and never spend money.
- Never weaken a gate: contract admission, qualification evidence, signatures, quorum, ledger, kill switch, typed phrases, channel binding.
- `src/cli/ui-channel.ts` stays the console's only bridge to `src/apply`.
