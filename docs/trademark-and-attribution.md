# Origin, authorship, trademark and provider reuse

**Product identifier:** `agent-private-landing-zone`

**Product mark:** **Sovereign ALZ®** (registered designation supplied by the owner).
**Original author:** **JK Gonzalez**.
**Copyright notice in the existing MIT `LICENSE`:** Copyright (c) 2026 Adapt Cloud.

These refer to different concepts and should not be conflated. The author's credit
does not change the identity of the current copyright holder. The owner's
registration assertion is recorded as `OWNER_ATTESTED_REGISTERED`; this
repository does not contain a trademark registry certificate, jurisdiction,
classes, or registration number. The product does not assert independent
verification of those facts.

## Strategic services providers and open-source licensing

The accelerator's existing MIT license permits use, modification, distribution,
sublicensing, and commercial sale by **any strategic services provider**, customer,
consultancy or other operator, subject to retaining the copyright and license
notice in copies/substantial portions as required by MIT.

Accurate attribution and references to the original product are welcome. The
MIT copyright license does not itself grant permission to misrepresent a
derivative product as officially endorsed by JK Gonzalez or Adapt Cloud, or
to imply that a partner is an authorized trademark licensee. Trademark
licensing and brand co-marketing are separate from the right to use the code.
Do not introduce a runtime license server, vendor lock, account registration,
telemetry or partner eligibility check. No product behavior depends on brand
or trademark verification.

## Digital origin fingerprint

`src/brand/identity.ts` is the canonical, frozen identity declaration.

- `BRAND_FINGERPRINT` is a reproducible SHA-256 hash of the versioned
  declaration's exact bytes; it is not a signature or proof of trademark ownership.
- New Preview/Operate release packages embed `brand-provenance.json`,
  containing the original author, mark, license, repository URL,
  owner-attestation basis and hash. The existing release manifest includes
  that file's SHA-256 in its normal file inventory. The release verifier
  therefore rejects modifications to the embedded declaration. Historic
  schema-v1 manifests remain readable; the release schema is unchanged.
- The source SHA, SBOM hashes, container provenance, signatures and release
  admission checks remain independently authoritative. A fork may update its
  identity claims, but must not claim to be an official upstream release or
  replace upstream signing/provenance authority.
- No secret or customer identifier belongs in the brand fingerprint.

**Operational security remains unchanged:** Milestone 1 Preview/Operate
continues with infrastructure ACT DISABLED. Attribution does not grant any
model, operator or provider new permissions. See Issue #39 and `AGENTS.md`.
