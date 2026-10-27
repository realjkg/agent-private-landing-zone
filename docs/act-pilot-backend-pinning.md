# Backend pinning: proof summary (SYNTHETIC)

**SYNTHETIC evidence.** Everything on this page ran in a sandbox against loopback listeners, with real Terraform 1.16.4 and no cloud account, registry or other host. It is not live AWS or Azure provider qualification and does not approve a release. ACT stays DISABLED and `config/act-pilot-contract.sha256` stays empty.

## The rule

The pilot never reads or judges the project's own backend block. The rule is in docs/act-pilot-apply.md ("The backend rule") and `src/apply/backend-pin.ts`:

1. Refuse, by name only, any root entry Terraform would merge as an override (`override.tf(.json)`, `*_override.tf(.json)`, matched case-insensitively) and any saved state or data directory (`.terraform`, `terraform.tfstate`, `terraform.tfstate.backup`, `terraform.tfstate.d`). The run always uses `TF_DATA_DIR=.terraform`, which is `init`'s own fresh data directory.
2. Write one product-owned override file, `zzzz_alz_backend_override.tf`, containing `terraform { backend "<type>" {} }` (`s3` for AWS, `azurerm` for Azure). Every setting comes from the product's `-backend-config` file.
3. Treat any non-zero `init` exit as a failure, and keep the post-`init` check that the saved backend is the contract's.

## Why it holds (Terraform source, v1.16.4)

- `internal/configs/module.go` L717-724, `mergeFile`: a backend in an override file replaces `m.Backend` wholesale and sets `m.CloudConfig` and `m.StateStore` to nil.
- `internal/configs/parser_config_dir.go` L55-62: override files are merged even when parsing the primary files reported errors.
- `internal/configs/parser_file_matcher.go` L178-179: a file is an override when its base name is `override` or ends in `_override`, with extension `.tf` or `.tf.json`. Ignored files (starting with `.`, ending with `~`, or starting and ending with `#`) are never loaded.

Override files are merged in name order, so a project override sorting after ours could win. That is why every override name is refused, rather than relying on `zzzz_` to sort last.

## Proof harness results

70 cases ran `terraform init` with the pilot's own argument list (`init -input=false -no-color -lockfile=readonly -backend-config=../alz-backend.tfbackend`). They covered parser-confusion files (including the reviewer's exact reproduction from PR #287 comment 6436660507 and five variants), duplicate-key JSON, multiple backends, `cloud` and `state_store` blocks, hidden and ignored files, override files and saved state. Across all 70:

- the loopback listener standing in for the user's backend saw **zero** connections;
- no case left a saved backend other than ours unless the name rule refuses that case first (12 cases are refused by name);
- 36 inits exited 0, and every other init failed. The product treats a failed init as a stop.

`test/apply-backend-pin-real.test.ts` reruns a representative subset of 21 cases (`test/fixtures/backend-pin/cases.json`: r0-r5, a duplicate-key JSON case, two multiple-backend cases, two `cloud` cases, two `state_store` cases, override and state refusals, and a positive control) through the product's own functions. It is opt-in: set `ALZ_SIM_TERRAFORM` to the pinned binary. Local run on 2026-10-27, Terraform v1.16.4 (sha256 `44d3683c2ac9d72b6ca8ad880a2df8dd956dd5e019b1d111cb6a5d914d576b73`): 21 of 21 passed. The 7 refused cases never ran `init`. In the 14 cases that ran `init`, the user's listener saw 0 connections, and every saved backend was `s3` and passed `savedBackendMatches`. 3 of those inits exited 0 (`n-ok-s3`, `c1-cloud-block`, `j1-dup-terraform-key`). The other 11 failed, which the product treats as a stop.

## What this does not prove

It does not cover real S3, STS or Azure Storage, the AWS or AzureRM provider, or a live account. The Azure emulated simulation (`test/apply-emulated.test.ts`) put its emulator SAS token in the project's backend block. The pin now drops that block, so that opt-in simulation needs its emulator settings moved to a test-only backend file before it is rerun.
