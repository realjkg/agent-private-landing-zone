# D3/D4 offline qualification rehearsal

This work adds deterministic synthetic fault cases for private-model preflight behavior and AWS provider qualification admission. The AWS cases call existing identity and provider validators using constructed test evidence. D3 cases use a synthetic state model, not real inference.

A passing campaign does not qualify real target hardware or AWS access. Every case reports SIMULATED, NOT_RUN for real model/provider operations, and releaseAdmission false. Infrastructure ACT is disabled.

Use `node --import tsx --test test/d3-d4-simulation.test.ts` for an offline development check. D3 and D4 acceptance in Issue #39 remains pending actual dedicated Linux model-runner evidence and an authorized OIDC AWS discovery/preview run.

The simulation does not open network connections, obtain credentials, or authorize changes.