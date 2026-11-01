import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./provenance.js";
import { AWS_COST_BASELINE_SCENARIO, renderAwsCostBaselineProject, type CostBaselineMetadata } from "./cost-baseline.js";
import { resolveCostConfig, type CostConfig } from "../design/cost.js";

/**
 * Writes the cost baseline as a pilot project directory (docs/cost-baseline-deploy.md), so the existing
 * `./alz apply prepare → seal → approve → apply` workflow takes it like any other project. Local and offline: it renders
 * fixed code, copies the reviewed provider lock and writes four files. It runs no engine, reads no cloud, holds no
 * credential and seals, approves or applies nothing. ACT stays DISABLED; the contract's `limits` decide what a seal admits.
 *
 * The shape follows the committed AWS canary (`qualification/aws/act-dev1-canary`):
 * - `main.tf`: the cost baseline in its pilot-project form (`renderAwsCostBaselineProject`);
 * - `.terraform.lock.hcl`: the canary's reviewed lock for hashicorp/aws 6.68.0, byte for byte (HashiCorp's own `h1:`
 *   hashes; `./alz apply prepare` checks them, and seal's `init -lockfile=readonly` installs only a package that matches);
 * - `terraform.tfvars.example.json`: the two inputs, `aws_region` and `unit_tags` (the tags `prepare` prints);
 * - `cost-baseline.json`: the render metadata, labeled as such, so the operator and reviewers see what the project creates.
 *   Terraform reads only `.tf`, `.tf.json` and tfvars files, so this file is part of the project fingerprint and nothing else.
 */
export const COST_PROJECT_FILES = ["main.tf", ".terraform.lock.hcl", "terraform.tfvars.example.json", "cost-baseline.json"] as const;

/** The reviewed AWS lock the canary commits; the cost baseline pins the same provider at the same version. */
export const REVIEWED_AWS_LOCK_PATH = "qualification/aws/act-dev1-canary/.terraform.lock.hcl";

const repositoryRoot = (): string => resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The reviewed lock text, read from the repository (never written by this module). */
export function reviewedAwsLock(root: string = repositoryRoot()): string {
  const text = readFileSync(join(root, REVIEWED_AWS_LOCK_PATH), "utf8");
  if (!text.includes('provider "registry.terraform.io/hashicorp/aws"') || !text.includes('version     = "6.68.0"')) {
    throw new Error("COST_PROJECT_LOCK_NOT_REVIEWED");
  }
  return text;
}

export type CostProjectRecord = {
  kind: "ALZ_COST_BASELINE_PROJECT";
  label: "LOCAL_RENDER";
  scenario: typeof AWS_COST_BASELINE_SCENARIO.id;
  /** The hash of the preview the build's real Terraform plan validated, when the project came from a build. */
  previewArtifactSha256: string | null;
  mainTfSha256: string;
  lockFileSha256: string;
  configHash: string;
  creates: CostBaselineMetadata["creates"];
  crossRegionDependencies: CostBaselineMetadata["crossRegionDependencies"];
  prerequisites: string[];
  next: string[];
  approval: "NOT_GRANTED";
  infrastructureAct: "DISABLED";
};

export type WrittenCostProject = { projectRoot: string; record: CostProjectRecord };

const PLACEHOLDER = "REPLACE-WITH-PREPARE-OUTPUT";

/**
 * Renders and writes the project into `projectRoot`, which must not exist yet while its parent must (it is created 0700,
 * not recursively; files are 0600 and written exclusively, so nothing is overwritten). `region` is the home region the build planned in.
 */
export function writeCostBaselineProject(input: {
  config: CostConfig;
  projectRoot: string;
  region: string;
  previewArtifactSha256?: string;
  lock?: string;
}): WrittenCostProject {
  const config = resolveCostConfig(input.config);
  if (!/^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(input.region)) throw new Error("COST_PROJECT_REGION_INVALID");
  if (input.previewArtifactSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.previewArtifactSha256)) {
    throw new Error("COST_PROJECT_PREVIEW_HASH_INVALID");
  }
  const projectRoot = resolve(input.projectRoot);
  if (existsSync(projectRoot)) throw new Error("COST_PROJECT_EXISTS");
  const lock = input.lock ?? reviewedAwsLock();
  const rendered = renderAwsCostBaselineProject(config);
  const record: CostProjectRecord = {
    kind: "ALZ_COST_BASELINE_PROJECT",
    label: "LOCAL_RENDER",
    scenario: AWS_COST_BASELINE_SCENARIO.id,
    previewArtifactSha256: input.previewArtifactSha256 ?? null,
    mainTfSha256: sha256(rendered.terraform),
    lockFileSha256: sha256(lock),
    configHash: rendered.metadata.configHash,
    creates: rendered.metadata.creates,
    crossRegionDependencies: rendered.metadata.crossRegionDependencies,
    prerequisites: rendered.metadata.prerequisites,
    next: [
      "Copy terraform.tfvars.example.json to terraform.tfvars.json in this folder.",
      "Run ./alz apply prepare --environment DEV --project <this folder>; copy the three unit tags it prints into unit_tags.",
      "Run prepare again, then seal, approve and apply as for any pilot project. The contract's limits decide what a seal admits.",
    ],
    approval: "NOT_GRANTED",
    infrastructureAct: "DISABLED",
  };
  const tfvars = {
    aws_region: input.region,
    unit_tags: { "alz-managed-by": PLACEHOLDER, "alz-unit": PLACEHOLDER, "alz-build": PLACEHOLDER },
  };
  // Not recursive: the folder is created here or the write stops (EEXIST), so nothing between the check above and this call
  // can hand the writer an existing folder or link. Its parent must already exist (the CLI's fresh run folder).
  try {
    mkdirSync(projectRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("COST_PROJECT_EXISTS");
    throw new Error("COST_PROJECT_FOLDER_INVALID");
  }
  const folder = lstatSync(projectRoot);
  if (folder.isSymbolicLink() || !folder.isDirectory()) throw new Error("COST_PROJECT_FOLDER_INVALID");
  const write = (name: string, text: string) => writeFileSync(join(projectRoot, name), text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  write("main.tf", rendered.terraform);
  write(".terraform.lock.hcl", lock);
  write("terraform.tfvars.example.json", JSON.stringify(tfvars, null, 2) + "\n");
  write("cost-baseline.json", JSON.stringify(record, null, 2) + "\n");
  return { projectRoot, record };
}
