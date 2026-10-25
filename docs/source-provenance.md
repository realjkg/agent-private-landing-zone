# Source identity, digital fingerprint and provider reuse

The original author of the Sovereign Agent Private Landing Zone accelerator is
**JK Gonzalez**. The claimed project mark is **Sovereign ALZ™**. The trademark
claimant reports a filing; this document does not assert registration.

## Source-level identity

`src/release/provenance.ts` holds a stable, public source-identity record:

- original author: JK Gonzalez
- project mark and claimant: Sovereign ALZ™ / JK Gonzalez
- license: MIT
- canonical source repository: realjkg/agent-private-landing-zone

`SOVEREIGN_ALZ_ORIGIN_SHA256` is the SHA-256 hash of the canonical JSON record.
It identifies the *declared origin*, not the unique bytes of a release.

New release manifests use **schema version 2** and include `origin`, with the
identity hash. Validation rejects missing, changed, or extended origin metadata
for v2. Previously published schema-v1 manifests remain readable for
compatibility. Do not interpret legacy compatibility as proof of attribution.

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
