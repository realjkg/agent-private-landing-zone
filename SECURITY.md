# Security Policy

## Reporting a vulnerability

Do not open a public GitHub issue for a suspected vulnerability.

- **Preferred:** GitHub private vulnerability reporting on this repository — **Security → Report a vulnerability**. The report, coordination, and fix timeline stay private until a fix ships.
- **Fallback:** email the repository owner at jkristian.gonzalez@gmail.com with `[security]` in the subject.

Include what you can: the affected commit or release, a minimal reproduction, the component or flow involved, and any suggested fix.

## Coordinated disclosure

Reports are acknowledged and a fix is coordinated privately. Please allow a reasonable window (the 90-day industry convention) before public disclosure; earlier disclosure can be arranged for issues under active exploitation.

## Supported configurations

Security fixes target the latest `main` branch and releases built from it. Packaged releases ship with a deterministic archive, a release manifest, and a SHA-256 checksum — verify the checksum of the archive you run.
