# GCP offline demonstration on Apple Silicon

This bounded training demonstration complements existing AWS and Azure fixture demos. It is not a production-qualified GCP provider integration, an authenticated inventory check, a provider Terraform plan, or an AI model inference run.

## Mac prerequisites

```sh
uname -m
command -v gcloud
gcloud version
./alz deps
./alz doctor
```

For the documented MacBook baseline, the operator reports ARM64 and Google Cloud CLI 589.0.0. **The GCP offline demo never launches `gcloud`, reads local Google credentials, or opens a network connection.** The local CLI will be used only after separately authorized authenticated provider onboarding in issue #141.

## Exercise the bounded offline walkthrough

```sh
./alz demo aws terraform brownfield
./alz demo azure terraform greenfield
./alz demo gcp terraform brownfield
./alz demo gcp terraform greenfield
./alz demo gcp terraform unknown
```

The existing AWS/Azure routes use their own fixture-backed agent demo. The GCP route deliberately uses its own isolated, typed `discoverGcpInventory()` transport seam until the common provider model and policy routing have been qualified.

The GCP demonstration:

1. Calls Cloud Asset Inventory **through an in-memory transport fixture** with the same bounded GET request shape as the read-only contract.
2. Displays synthetic resources and unknown ownership, identity and posture. An empty search never proves a real project is greenfield.
3. Marks PLZ and Application LZ requirements **REVIEW_REQUIRED**, including identity, organization policy, VPC/networking, evidence and private model workload boundaries.
4. Marks the Terraform preview **NOT_RUN**. No actual Terraform initialization, provider download or plan is executed.
5. Keeps ACT **DISABLED**, with no credentials or authorization grant.

The walkthrough is deterministic and hash-linked; its hashes are proof of consistent synthetic inputs, not proof of customer infrastructure.

## Allowed modes and exclusions

`./alz demo gcp terraform [brownfield|greenfield|unknown]` is an **offline showcase only**. Unsupported GCP engines are refused. `./alz inspect gcp`, `./alz session gcp` and `./alz design gcp` remain unavailable rather than defaulting to AWS or Azure.

The end-to-end real GCP workflow is still pending: trusted GCP authentication and read-only transport, IAM and org discovery, provider-specific DesignSpec to Terraform plan, deterministic policy binding, private model agent integration, and production qualification evidence. Those require separate code, approval and (in a future iteration) live tests.

## Managed Terraform location and tool broker

`./alz deps` checks the pinned Terraform executable in `~/.alz/tools/terraform/1.16.4/terraform`. The governed tool broker **does not inherit the shell PATH**. It searches approved default directories and any manually approved, absolute and non-world-writable `ALZ_TOOL_DIRS` paths, so the toolbox may show Terraform unavailable even when `./alz deps` is green.

To give a local, isolated version check access to the managed Terraform binary without relaxing the broker's trust rules:

```sh
ALZ_TOOL_DIRS="$HOME/.alz/tools/terraform/1.16.4" ./alz doctor
```

This is a local explicit execution-path grant to a reviewed binary directory, not a cloud-read or write grant. Do not add arbitrary home directories, a world-writable location, or the entire ambient PATH. The no-live-testing cycle needs only static versions and synthetic evidence.
