/**
 * The production release gate ids, in admission order: a committed copy of the ids in `PRODUCTION_RELEASE_GATES`
 * (`src/qualification/release-admission.ts`). The runner cannot import that registry, because it loads the pilot apply
 * path (`test/apply-boundary.test.ts`), so `test/evidence-preflight.test.ts` pins this list to the registry instead: a gate
 * added, removed or reordered there fails that test until this list follows. At run time `config/release/status.json`
 * is checked against this list, so a status file that drops or adds a gate refuses the run instead of shrinking the plan.
 */
export const RELEASE_GATE_IDS: readonly string[] = [
  "source-ci", "release-archive", "arm64-final-image", "private-model-runtime", "aws-provider", "azure-provider", "gcp-provider",
  "preview:terraform-aws-brownfield", "preview:pulumi-azure-greenfield", "preview:opentofu-aws-brownfield", "preview:bicep-azure-brownfield",
  "preview:cloudformation-aws-existing", "preview:cdk-aws-brownfield", "preview:ansible-existing-hosts", "preview:crossplane-local-render",
  "preview:terraform-azure-brownfield", "preview:pulumi-aws-greenfield", "preview:pulumi-aws-brownfield", "preview:pulumi-azure-brownfield", "preview:terraform-gcp-brownfield",
  "isolated-recovery",
  "lifecycle:clean-install", "lifecycle:upgrade", "lifecycle:rollback", "lifecycle:uninstall", "lifecycle:configuration-migration",
  "platform:darwin-arm64", "platform:darwin-x64", "platform:linux-x64", "platform:linux-arm64", "platform:win32-arm64", "platform:win32-x64",
  "act:aws-terraform", "act:azure-terraform", "act:aws-cdk", "act-run-recovery", "security-review:independent",
  "pillar:operational-excellence", "pillar:security", "pillar:reliability", "pillar:performance", "pillar:cost", "pillar:sustainability",
];
