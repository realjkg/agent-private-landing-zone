# Container-Native Design → BUILD Accelerator
**Initiative:** #87 · **Deployment baseline:** ARM64 MacBook hosting the ALZ Docker Compose service · **Operating mode:** PREVIEW_OPERATE · **Authority:** No generic infrastructure ACT

## Executive intent

Turn the current discovery/assessment/DesignSpec output into a governed, reproducible IaC BUILD preview, without making either the model or the Docker runtime a deployment principal. The unit of work is a **resource-level, hash-bound Design → BUILD handoff**, reviewed by a human and validated by adapter-specific local tools and normalized ChangeSet policy. This is a new capability lane inside the existing architecture, not a second agent platform.

## Verified baseline and gap

- `src/design/create.ts` emits a hashable `DesignSpec` containing delta actions, ownership restrictions, provider/adapter, policy bundle, resilience and security assumptions.
- `src/build/loop.ts` currently uses `generateMockArtifact()` even if an evidence-linked DesignSpec is supplied. Its positive offline evidence must remain `FIXTURE`.
- `src/build/private-model.ts` implements a **narrow** trusted, model-reviewed AWS brownfield/Terraform example. It is not a general code-generation interface for eight adapters.
- `src/agent/graph.ts` already requires an injected trusted host callback for nonfixture BUILD. This initiative adds a canonical DesignSpec integrity/ownership preflight before that callback. The callback still cannot grant ACT.
- `Dockerfile` ships a Node/Alpine runtime, not an Ollama service or a full IaC authoring environment. `compose.yaml` specifies a read-only ALZ filesystem, separate evidence volumes, dropped capabilities, and `no-new-privileges`; it does **not** specify an Ollama model endpoint, a model service, or shared networking.
- The MacBook is the **host**, while the application is **in a Docker container**. `127.0.0.1` **inside that container** refers to its own namespace, not the macOS host nor another container. Current model-provenance checks enforce loopback for trusted private inference. Do not set `host.docker.internal` and claim success without an explicit reviewed runtime/egress policy change and probe.

## Architectural sequence

```text
MacBook ARM64 — Docker-managed private ALZ runtime
  ╭─ DISCOVER / ASSESS ───────────────────────────────────────────────╮
  │ provider identity, discovered estate, ownership, observed risks │
  ╰────────────────────────┬─────────────────────────────────────────╯
                           ▼
  ╭─ DESIGN / DELTA ──────────────────────────────────────────────────╮
  │ REUSE · INTEGRATE · CONFIGURE · ADD · ADOPT · NO_TOUCH · BLOCKED   │
  │ DesignSpec: selected adapter, policy, forbidden scope, evidence  │
  ╰────────────────────────┬─────────────────────────────────────────╯
                           ▼
  ╭─ CANONICAL DESIGN→BUILD HANDOFF [new] ────────────────────────────╮
  │ recomputed DesignSpec hash + environment hash + policy lineage  │
  │ provider/adapter/estate + resources/ownership + no-touch         │
  │ BLOCKED | REVIEW_REQUIRED | READY_FOR_PREVIEW                    │
  ╰────────────────────────┬─────────────────────────────────────────╯
                           ▼
  ╭─ PRIVATE AGENT PROPOSAL [approved semantic schema] ──────────────╮
  │ Qwen design suggestion → independent Mistral review             │
  │ resource actions constrained to current owner-reviewed Design  │
  ╰────────────────────────┬─────────────────────────────────────────╯
                           ▼
  ╭─ TRUSTED ADAPTER COMPILER / VALIDATION ──────────────────────────╮
  │ Terraform | OpenTofu | Pulumi | Bicep | CDK/CFT | Crossplane      │
  │ Ansible (each adapter uses only its declared provider scope)    │
  │ actual local tool where available; labelled replay otherwise   │
  ╰────────────────────────┬─────────────────────────────────────────╯
                           ▼
  ╭─ NORMALIZED CHANGESET / POLICY GATES ────────────────────────────╮
  │ forbid surprise create/update/delete/adopt, unknown ownership   │
  │ scanner + builtin/local OPA + cost/resilience evidence           │
  │ exact artifact, DesignSpec, plan & policy hashes                 │
  ╰────────────────────────┬─────────────────────────────────────────╯
                           ▼
                HUMAN REVIEW (PREVIEW ONLY)
          No terraform apply / pulumi up / cdk deploy
          No generic agent/cloud-write credentials
          Any separately leased ACT action is out-of-band
```

## Handoff contract (first implementation)

`src/design/handoff.ts` is a pure deterministic validator shared by adapter lanes. Inputs are the exact `EnvironmentState`, `DesignSpec`, provider and engine. It recomputes the DesignSpec content hash as `createDesignSpec` does, confirms the policy hash is referenced, binds the discovered environment snapshot, checks adapter registration/compatibility and resource action lists, and produces a distinct hash for the resulting handoff. It rejects changed policies, illicit ADD/NO_TOUCH overlap, unknown ownership and provider/engine/estate mismatches.

**Classification is deliberate:** `BLOCKED` for violations; `REVIEW_REQUIRED` for incomplete/externally authorized resource intent or unresolved Design assumptions; `READY_FOR_PREVIEW` when the evidence is structurally ready. A reviewed but incomplete recovery/cost posture can still support a **bounded preview**—it cannot authorize deployment. An unlisted ADD or a proposed modification of an existing resource without independent authority cannot proceed.

The agent kernel executes this preflight **only for actual nonfixture BUILD** and checks for a genuine discovery source before invoking the trusted callback. Fixture Layer 1 behavior remains unchanged, and any attempt to pass mock evidence into the real lane fails closed. The handoff itself is **not a signature** or human approval; release evidence later must bind the git source SHA, model digests, tool versions and artifact/ChangeSet hashes.

## Docker runtime topology: verify before enabling model inference

Do not change the deployed Compose topology until the actual container inventory and health probes identify where Ollama runs. There are three defensible patterns, requiring different permission boundaries:

1. **Ollama process shares the ALZ container network namespace:** `127.0.0.1:<pinned port>` can remain valid. Check process identity, isolation, attached volumes and update lifecycle; do not assume this is current.
2. **Separate private Ollama service/container:** prefer a restricted internal Docker network with no public model port. The currently loopback-only model trust check must first be replaced by an explicitly pinned service identity and network policy; avoid generic remote URLs. This is a separate reviewed PLAN.
3. **Ollama runs natively on the macOS host:** Docker's host gateway can be considered only if the customer accepts the cross-boundary host service, egress policy and provenance changes. On Apple Silicon, native macOS inference may use host acceleration that a Linux VM container cannot expose equivalently; verify actual throughput and network rules.

**No current container → model connection has been observed.** A healthy `curl` from macOS does not prove the ALZ container can reach, trust or identify the same service.

Operator diagnostic capture (read-only, no credentials):
```sh
docker compose config --services
docker compose ps
docker compose exec alz node -p "process.platform+' '+process.arch"
docker compose exec alz node -p "process.env.OLLAMA_BASE_URL || 'NOT_SET'"
```
The model endpoint should be checked **from inside the ALZ container** after a reviewed network topology is configured. The standard runtime image has no dependency on `curl`: use a bounded Node HTTP probe or the existing runtime preflight. Do not run Docker setup, inference, model pulls or cloud commands merely to test the blueprint.

## Ordered delivery and acceptance gates

| Stage | Deliverable | Acceptance evidence |
| --- | --- | --- |
| P1: Canonical handoff | Pure typed DesignSpec/estate/policy binding + comprehensive negative tests | Hash replay, stale design/policy, resource mismatch, no-touch, unknown ownership and N/A provider all fail closed |
| P2: Trust-bound kernel | Real-only handoff preflight before callback; no legacy fixture bypass | PR source CI; no synthetic artifact promoted to real BUILD |
| P3: ARM64 model connection | Exact container/model topology, signed/pinned identity and runtime probe | Inside-container network and model digest evidence tied to image and source SHA |
| P4: Bounded generators | Per-adapter semantic templates & native toolchain preview drivers | Terraform/OpenTofu/Pulumi/Bicep/CDK/CFT/Ansible/Crossplane version, output hashes and normalized ChangeSet per supported pair |
| P5: Test layers | All 24 supported greenfield/brownfield previews, applicable denials, faults; native toolchain + real Qwen/Mistral passes | Layer 1 / Layer 2 separated; unsupported Azure CFT/CDK N/A with **zero executions** |
| P6: Release verification | ARM64 image/SBOM/Trivy, rollback/restore and explicit incomplete cloud gates | Exact source commit and image digest, independent review, release-profile-specific claims |

**Thin implementation:** no new general scheduler, agent fleet, stateful policy proxy, remote LLM connector or blanket IaC authority. Existing builtin/local OPA, typed broker, evidence store and compromise lifecycle remain owners of their respective gates.

### Risk / rollback

Reject a handoff mismatch before a BUILD adapter or external tool sees the payload. If the new validator blocks a formerly accepted real request, inspect the DesignSpec and ownership/policy evidence; do not change assertions to suppress missing resource intent. Roll back this isolated P1/P2 preflight if it proves incompatible with valid reviewed designs, without changing ACT or the Docker service's existing data volumes. Real model networking and toolchain packaging have independent change plans.
