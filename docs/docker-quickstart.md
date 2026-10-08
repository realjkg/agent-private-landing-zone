# Docker quickstart for operators

This is a **preview-only**, local Docker experience. It is not production qualification. Infrastructure ACT remains disabled.

## What you need

Docker Desktop with Compose and Git. No host Node.js/npm installation, cloud credentials, or model weights are required for the synthetic demo.

From a **clean, reviewed Git checkout** containing the Docker runtime:

```sh
bash scripts/alz-docker.sh setup
bash scripts/alz-docker.sh doctor
bash scripts/alz-docker.sh demo
```

The operator launcher provides understandable setup failures, checks Docker availability, builds a release-manifest-protected image for the exact committed revision, and prepares two named Docker volumes. Setup never deletes existing volumes or displays encryption keys. A short-lived root helper changes ownership on the two named Docker volumes only; the application itself remains UID 1000, read-only, without Linux capabilities or privilege escalation.

**Setup needs network access for image and npm dependency retrieval at build time.** Normal application operation does not require hosted inference. The launcher does not automatically install or configure Ollama.

The **doctor** command checks security controls. If repository attestation or another control fails, do not bypass it; the runtime is not yet qualified. The **demo** command uses deterministic synthetic AWS brownfield information rather than production data.

## Current limits

- Trivy and npm audit are part of the governed supply-chain process; running this launcher alone is not evidence of a completed vulnerability scan.
- Qwen/Mistral live inference is not established by a synthetic demo.
- Conversational sessions remain memory-only until encrypted durable checkpoints are separately approved.
- The runtime uses external volumes named `alz-runtime-data` and `alz-evidence-keys`. Preserve both when upgrading. Back up the evidence key separately from encrypted evidence.
- Existing source-checkout `./alz` commands remain available to developers. This launcher exists for operators who should not need npm or Compose syntax.
- This helper is not a signed release installer. Provenance, Trivy and negative tamper checks must pass the separately authorized release gate before deployment.

## If something fails

- **Docker unavailable:** Start or install Docker Desktop.
- **Checkout dirty:** Use a clean, reviewed commit for build provenance.
- **Image build failed:** Review the printed error; do not override the manifest validator.
- **Volume permissions denied:** Re-run `setup`; it repairs ownership without deleting data.
- **Doctor refused:** Inspect its named failed security control. Do not bypass security.
- **Missing private models:** Use `demo` for synthetic exploration. Live model qualification is a separate deployment step.
