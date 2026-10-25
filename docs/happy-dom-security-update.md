# Happy DOM security dependency update

The test DOM dependency is pinned to `happy-dom` **21.0.4** in both the package
manifest and npm lockfile. This addresses
[GHSA-834v-8h66-3h79](https://github.com/advisories/GHSA-834v-8h66-3h79), a HIGH
severity unsanitized import-alias code-execution finding affecting versions
17.0.0 through 21.0.3. The previous locked version was 20.14.6. The supply-chain
job for PR #211 failed at dependency audit; that failure must not be waived.

The upgrade changes only Happy DOM's direct version, tarball URL and integrity
entry. Its transitive dependency graph is unchanged. Happy DOM remains a
**development dependency** used by Vitest's UI environment. It is not a private
inference runtime or a provider adapter.

Before merging, run the repository's affected-QA plan and local check, the full
UI regression suite (justified by a major DOM-engine version change), and a fresh
npm audit against the generated lockfile. Confirm the exact-head CodeQL and
supply-chain checks and obtain independent review. A clean npm audit means no
known advisories were reported at that time; it does not replace native image
scanning, SBOM/provenance, recovery qualification or Milestone 1 admission.

No audit severity threshold, assertion, workflow permission, model selection,
cloud authority or infrastructure ACT gate is changed.
