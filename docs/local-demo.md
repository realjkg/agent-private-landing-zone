# Local AWS demo

The prepared checkout needs no reinstall. Start `./alz`, open the AWS DEV page,
and use **Rehearse offline** for direct-versus-LangGraph discovery and preview.
Private inference is optional for this rehearsal and has a separate readiness check.

For the ACT story, open **Operations**, choose the evidence family,
select **Governed design demo**, and run it with AWS, Terraform and
brownfield defaults. The same walkthrough runs in a terminal:

```sh
./alz demo aws terraform brownfield
```

The final ACT demo section shows scripted approval, a simulated canary build,
verification, a separately approved simulated teardown and cleanup readback.
Every operation happens in an in-memory inventory. The discovered fixture baseline
is preserved. This demonstrates the lifecycle; it does not deploy the Control Tower
reference stack or exercise a real apply engine, model, AWS endpoint or billing API.
Unknown environments or blocked designs cannot enter simulated ACT.

The output contains a `SYNTHETIC_DEMO_ACT_EVIDENCE_V1` record with separate plan
and cleanup hashes, simulated events, remaining inventory and cleanup verification.
The console retains the output in its run view. To keep terminal evidence locally:

```sh
mkdir -p .runs/demo
./alz demo aws terraform brownfield > .runs/demo/aws-lifecycle.log
```

The demo itself writes no files and reads no cloud credentials. Stopping it loses
only its temporary inventory; rerunning starts a fresh rehearsal. Scripted approvals
cannot authorize real deployment. Live infrastructure ACT stays disabled.

If the agent sandbox denies binding `127.0.0.1:8788`, start `./alz` from an ordinary
Mac terminal. The terminal demo works without opening a listener.
