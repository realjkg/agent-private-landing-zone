# Source identity, digital fingerprint and provider reuse

The original author of the Sovereign Agent Private Landing Zone accelerator is
**JK Gonzalez**. The product mark is **Sovereign ALZ®**, with registered status
asserted by the owner (`OWNER_ATTESTED_REGISTERED`), not independently verified
by this repository. See [the canonical notice](trademark-and-attribution.md).

## Source-level identity

`src/brand/identity.ts` is the single canonical identity declaration.
`src/release/provenance.ts` preserves the existing compatibility interface and
derives its author, mark, license and repository fields from that declaration:

- original author: JK Gonzalez
- project mark and claimant: Sovereign ALZ® / JK Gonzalez (owner assertion)
- license: MIT
- canonical source repository: realjkg/agent-private-landing-zone

`SOVEREIGN_ALZ_ORIGIN_SHA256` is the SHA-256 hash of the canonical JSON record.
It identifies the *declared origin*, not the unique bytes of a release.
The canonical `BRAND_FINGERPRINT` uses its separate versioned brand payload;
the two digests are not interchangeable. New packages also include the canonical
`brand-provenance.json` in the release manifest's file inventory.

Reconciling the older compatibility record's mark from ™ to ® changes its
identity digest. The validator requires the current record and rejects the old
mark even with a matching old checksum. This does not rewrite historical
artifacts: schema-v1 release manifests continue to verify their recorded bytes.
The canonical brand record, its fingerprint and the release schema are unchanged.

The existing release-manifest schema remains **version 1**. During the
TypeScript build, `src/release/provenance.ts` emits
`dist/release/provenance.js`. Release packaging includes this compiled module
in the per-file SHA-256 inventory, alongside the source commit and SBOM. The
release verifier checks those recorded bytes. This preserves compatibility
without widening the normal PR test scope or changing the release contract.

The source-identity fingerprint is checked by focused tests; it is not a
signature or an independent registry of legal ownership.

## Artifact-specific verification

The release manifest also records the exact source commit, product version,
per-file SHA-256 hashes and SBOM hash. Existing container signing and
attestation mechanisms provide stronger evidence when actually used and
verified. The attribution fingerprint is not itself a digital signature,
trademark certificate, or tamper-proof DRM.

For an installed release that includes the packaging CLI:

```sh
node dist/cli/release-package.js --root /path/to/release --verify
```

Verification checks the release manifest and artifact integrity. A downstream
fork can lawfully modify the code under MIT; a public marker is not intended to
prevent modifications. If a fork changes the declared origin, distinguish the
fork's authorship from the original author rather than misrepresenting either.

## Strategic services provider rights

The existing MIT license permits commercial use, modification, redistribution,
sublicensing, and selling copies, subject to preservation of its existing
copyright and permission notices. No new contractual limitation is introduced.
The trademark notice addresses brand confusion, not the right to use the code.
The existing Adapt Cloud copyright notice remains unchanged until the relevant
rights holder authorizes a documented change.

No ACT, cloud access, model permissions, telemetry, or operator privileges are
changed by source attribution.
