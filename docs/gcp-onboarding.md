# Google Cloud Platform onboarding — Sovereign Landing Zone

**Status (G1):** read-only Cloud Asset Inventory *contract*, backed by injected transport and synthetic negative tests. This module is not yet a bound production provider, a runnable live GCP CLI, or a qualified PLZ/ALZ BUILD path. See [Issue #141](https://github.com/realjkg/agent-private-landing-zone/issues/141).

## First-class hyperscaler objective

GCP is part of the primary cloud estate alongside AWS and Azure. The finished scope covers enterprise Platform Landing Zones (organization/folder/project hierarchy, policies, IAM, network, billing, logging, observability and recovery) and AI Application Landing Zones (GKE or Vertex AI, service identities, inference isolation, evidence, sovereignty and budgets).

The MacBook ARM64 remains the development/operator host. Local model reasoning may operate in a separate approved private inference boundary. A model is not a GCP IAM principal, a source of truth, or a Terraform deployer.

## G1: typed Cloud Asset Inventory read-only seam

The new `src/providers/gcp/asset-inventory.ts` exposes:

```ts
discoverGcpInventory(
  "projects/sovereign-lz-dev",
  trustedHostProvidedReadOnlyTransport,
);
```

The trusted host transport must be explicitly authorized and tested **before** live use. It receives only:

- `GET` to the fixed `https://cloudasset.googleapis.com` origin;
- `/v1/{scope}:searchAllResources` with a narrow response mask;
- page size 100, at most 10 pages, 2 MB per page and an 8-second request budget.

Allowed scopes are project IDs/numbers, folder numbers and organization numbers; raw URLs, query strings, resource paths and credentials are rejected. Response JSON, fields, duplicates, page tokens, overflows and HTTP statuses are checked. A failed or truncated search throws an explicit `GCP_*` error instead of manufacturing complete or greenfield evidence. The response is normalized to resources with `UNKNOWN` ownership, `READ_ONLY` mutation policy and `UNKNOWN` source of truth. Page-response and snapshot SHA-256 values support provenance; raw credentials are not accepted or persisted.

The response states `identityAttestation: NOT_ATTESTED` and `posture: UNKNOWN`: a successful injected GET confirms *only* that the supplied transport returned schema-valid inventory. It does not prove live GCP access, inventory completeness across unsupported services, policy compliance, an authorized service identity, or control-plane recovery.

This PR deliberately does not alter the common AWS/Azure `Provider` union, the `./alz inspect` menu, shared operation catalog, build plug-ins, approval registry, tool broker, secrets, or the ACT pilot. Existing AWS/Azure `inspect` flows must not silently route GCP to Azure.

## Next gated integration stages

1. **G2 — Authenticated binding.** Establish Google Workload Identity Federation / ADC for named customers, the exact authorization scope and transport identity, approved egress and secret reference handling. Add authenticated probe evidence from the MacBook/Docker runtime with no credentials entering model prompts, test fixtures or logs. Cloud Asset Inventory resource search requires `cloudasset.assets.searchAllResources` on the scope and `serviceusage.services.use` in the calling context.
2. **G3 — Enterprise PLZ.** Enrich inventory with read-only organization-policy, IAM, network, KMS, logging, security and billing evidence using individually reviewed API permissions. Observed assets are not automatically “owned” or “adopted”.
3. **G4 — Governed BUILD.** Pin and review Google Cloud Foundation Fabric/FAST reference modules; bind the same DesignSpec/ownership/policy hashes to Terraform/OpenTofu or Pulumi preview and normalized ChangeSet output. Native tool validation and real module checks must run before marking the adapter implemented.
4. **G5 — AI ALZ.** Qualify GKE private inference and Vertex AI/Model Garden as alternative deployment models, subject to tenant, residency, data and key boundary decisions. Measure infrastructure economics and observability separately.
5. **G6/G7 — Provider parity and sandbox evidence.** Extend all explicit AWS/Azure selectors and denial gates in a coordinated workstream. Run complete regression and negative-path scenarios followed by authorized GCP sandbox read-only verification and a separate release decision.

## MacBook development path

Use the existing clean `agent-private-landing-zone` checkout, Node 26 and the repository's operator tooling. `./alz bootstrap` and `./alz doctor` validate the existing product; they do **not** test live GCP. Run the G1 contract tests with:

```sh
node --version
npm ci
npx tsx --test test/gcp-asset-inventory.test.ts
npm run build
```

The Docker Compose image currently does not establish a trusted connection to host-native Ollama. That is a separate reviewed runtime integration, not a reason to embed cloud access tokens in the container or widen network egress.

## Authoritative references

- [Cloud Asset Inventory v1: searchAllResources](https://docs.cloud.google.com/asset-inventory/docs/reference/rest/v1/TopLevel/searchAllResources)
- [Cloud Asset Inventory IAM permissions](https://docs.cloud.google.com/asset-inventory/docs/roles-permissions)
- [Google Cloud Foundation Fabric / FAST](https://github.com/GoogleCloudPlatform/cloud-foundation-fabric)
- [Google Cloud Enterprise Foundations Blueprint](https://docs.cloud.google.com/architecture/blueprints/security-foundations)

**Safety invariant:** no source, fixture, model, user prompt or successful inventory read grants `ACT`, `apply`, `destroy` or expanded cloud authorization.
