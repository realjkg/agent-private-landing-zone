# Live LZ journey collector — bounded first integration

`scripts/lz-journey-orchestrate.py` invokes the **existing** `./alz models verify` and `./alz discover --provider aws` commands sequentially on the operator's authenticated local host. The collector writes only command names, exit codes, source SHA and timestamps; raw output is intentionally not persisted because AWS inventory and CLI errors may contain sensitive details. Each collected stage is marked **authentic:false** until an independent reviewer validates the actual model and AWS evidence. This is a bounded partial integration, not a completed end-to-end journey.

Example (on an approved host, with `./alz` installed and AWS read-only identity already configured):

```bash
python3 scripts/lz-journey-orchestrate.py --repo . --output-dir ../alz-private-evidence --source-sha "$(git rev-parse HEAD)" --engine TERRAFORM
```

The output manifest can be completed with the existing `scripts/lz-journey-evidence.py` checker after collecting the remaining instruction, inventory, governance, native IaC preview, disabled ACT snapshot, and independent verification evidence.

**Not implemented in this collector:** full private-model instruction/skill orchestration, AWS inventory graph ingestion, Terraform plan, CDK synth/Change Set preview, ACT snapshot generation, or independent release admission. These require integration with the governed runtime and appropriate identity/approval contracts, not arbitrary shell execution. No ACT is enabled or executed. The DEV-only Terraform pilot in issue #199 is separately governed; CDK has no DEV-only ACT authorization.
