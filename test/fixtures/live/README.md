# Live captures (real tool output)

Fixtures here are **real output from real tools**, not hand-written JSON. The teardown readers (`src/teardown/`) parse other tools' output, and a fixture written from documentation only proves the reader agrees with the author's assumptions. `MANIFEST.json` records the tool, version and exact command behind every file, and `test/teardown-live-fixtures.test.ts` enforces that, plus a sensitive-data guard. Known divergences are in `docs/teardown-cli-quirks.md`.

## Adding a capture

1. Run the command on a machine with the real CLI. Prefer a throwaway account, subscription or stack.
2. Save the output **unmodified except for sanitizing** (below) at the path in the table. Files at these paths are smoke-tested automatically by the matching reader.
3. Add an entry to `MANIFEST.json` (`file`, `engine`, `tool` with version, `command`, `capturedAt`, `mode`) and remove the matching line from `stillNeeded`.
4. Run `npx tsx --test test/teardown-live-fixtures.test.ts`.

| Path | Command |
| --- | --- |
| `pulumi/<name>.preview.json` | `pulumi preview --json` (and a second capture with `--destroy`) |
| `aws/<name>.change-set.json` | `aws cloudformation describe-change-set --change-set-name N --stack-name S`, for a change set created **with** `--include-property-values`. Capture one created **without** it too (name it `...-no-values.change-set.json`) |
| `aws/<name>.tagging-get-resources.json` | `aws resourcegroupstaggingapi get-resources --tag-filters Key=alz-managed-by,Values=alz`. Also capture a truncated run (`--max-items 1`) to see the CLI's `NextToken` |
| `aws/cdk/<name>.template.json` | `cdk synth` output for a stack (a CloudFormation template; parsed through a change-set wrapper by the test) |
| `azure/<name>.what-if.json` | `az deployment group what-if -g RG -f main.bicep --no-pretty-print` |
| `azure/<name>.resource-list.json` | `az resource list --tag alz-managed-by=alz`, including a resource with `"tags": null` |
| `terraform/<name>.plan.json` | `terraform show -json PLANFILE` (already captured; see the manifest) |

## Sanitizing (required)

Captures from a real account carry identifiers. Replace, consistently across the file:

- AWS account ids with `123456789012` (the documentation placeholder);
- Azure subscription ids with `00000000-0000-0000-0000-000000000000`, and tenant ids likewise;
- real names that identify a customer, host names, internal bucket or registry names, with obvious placeholders (`example-...`);
- delete any secret, token or key. Nothing here should need one.

Keep the **structure** exactly as the tool produced it: key order, wrappers, nulls and omitted fields are the point. Never edit a value to make a reader pass. If a reader can't parse a real capture, that is the finding.

The guard test fails on AWS access keys, private-key blocks, email addresses, secret-looking values, and any AWS account id or Azure subscription id other than the placeholders above. It is a net, not a substitute for reading the file before you commit it.
