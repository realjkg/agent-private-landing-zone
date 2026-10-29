import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildFieldPackage, FieldPackageRefusal, readRepositoryFacts, renderFieldPackage,
  type FieldPackageInputs, type RepositoryFacts,
} from "./field-package.js";
import { resolveSourceCommit, type SourceCommit } from "../util/source-commit.js";

/**
 * Field package manifest generator (docs/field-package.md), run by scripts/field-package.ts. Offline and read-only: it reads the repository at --root and
 * the files named on the command line, and writes field-package.json and field-package.md into --out. Every digest comes
 * from a file; a missing input is PENDING or NOT_RUN in the output, never a typed value.
 *
 *   npx tsx scripts/field-package.ts --source-commit SHA --out DIR [--root DIR]
 *     [--archive agent-private-landing-zone.tar.gz] [--archive-sha256 agent-private-landing-zone.tar.gz.sha256]
 *     [--release-manifest release-manifest.json] [--sbom sbom.cdx.json] [--trivy trivy-results.json]
 *     [--npm-audit audit.json] [--models-evidence .runs/model-qualification/<run>.json]
 *
 * Exit 0: written. Exit 1: refused (the reason is printed; nothing is written).
 */
export const USAGE = "Usage: field-package --source-commit SHA --out DIR [--root DIR] [--archive FILE] [--archive-sha256 FILE] " +
  "[--release-manifest FILE] [--sbom FILE] [--trivy FILE] [--npm-audit FILE] [--models-evidence FILE]";

const FILE_FLAGS = {
  "--archive": "archive", "--release-manifest": "releaseManifest", "--sbom": "sbom", "--trivy": "trivy",
  "--npm-audit": "npmAudit", "--models-evidence": "modelsEvidence",
} as const;
const VALUE_FLAGS = new Set(["--source-commit", "--out", "--root", "--archive-sha256", ...Object.keys(FILE_FLAGS)]);

export type FieldPackageDeps = {
  /** The checkout's own commit; production asks git through resolveSourceCommit. */
  sourceOf?: (root: string) => SourceCommit;
  factsOf?: (root: string) => RepositoryFacts;
  log?: (line: string) => void;
  error?: (line: string) => void;
};

export function runFieldPackage(argv: readonly string[], deps: FieldPackageDeps = {}): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => console.error(line));
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!VALUE_FLAGS.has(flag) || value === undefined || value.startsWith("--") || values.has(flag)) {
      error("FIELD_ARGUMENTS_INVALID: " + (VALUE_FLAGS.has(flag) ? flag + " needs one value, given once" : "unknown argument " + flag) + ". " + USAGE);
      return 1;
    }
    values.set(flag, value);
    i++;
  }
  const commit = values.get("--source-commit");
  const out = values.get("--out");
  if (commit === undefined || out === undefined) { error("FIELD_ARGUMENTS_INVALID: --source-commit and --out are required. " + USAGE); return 1; }
  const root = resolve(values.get("--root") ?? ".");

  try {
    // The facts are read from the checkout, so the checkout must be exactly the commit the package names.
    const source = (deps.sourceOf ?? ((r: string) => resolveSourceCommit(r, {})))(root);
    if (!source.ok) throw new FieldPackageRefusal("FIELD_SOURCE_UNVERIFIED", source.reason);
    if (source.commit !== commit) throw new FieldPackageRefusal("FIELD_SOURCE_COMMIT_MISMATCH", "the checkout at " + root + " is " + source.commit + ", not " + commit);

    const read = (path: string) => ({ file: path, bytes: readFileSync(resolve(path)) });
    const inputs: FieldPackageInputs = { sourceCommit: commit };
    for (const [flag, key] of Object.entries(FILE_FLAGS)) {
      const path = values.get(flag);
      if (path !== undefined) inputs[key] = read(path);
    }
    const checksum = values.get("--archive-sha256");
    if (checksum !== undefined) inputs.archiveSha256File = { file: checksum, text: readFileSync(resolve(checksum), "utf8") };

    const manifest = buildFieldPackage(inputs, (deps.factsOf ?? readRepositoryFacts)(root));
    const dir = resolve(out);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "field-package.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(resolve(dir, "field-package.md"), renderFieldPackage(manifest), "utf8");
    log("Field package manifest written to " + dir + " (field-package.json, field-package.md).");
    log("ACT: DISABLED by default. Supported platforms: " + (manifest.supportedPlatforms.join(", ") || "none qualified yet") + ".");
    return 0;
  } catch (failure) {
    error(failure instanceof FieldPackageRefusal ? failure.message
      : "FIELD_INPUT_UNREADABLE: " + (failure instanceof Error ? failure.message : "an input could not be read"));
    return 1;
  }
}
