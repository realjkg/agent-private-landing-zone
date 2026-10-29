/**
 * The field package manifest generator (docs/field-package.md, section 3). Offline and read-only: it reads the checkout and
 * the artifact files named on the command line, and writes field-package.json and field-package.md into --out. The logic and
 * its argument checks are src/release/field-package-run.ts.
 *
 *   npx tsx scripts/field-package.ts --source-commit SHA --out DIR [--root DIR] [--archive FILE] [--archive-sha256 FILE]
 *     [--release-manifest FILE] [--sbom FILE] [--trivy FILE] [--npm-audit FILE] [--models-evidence FILE]
 */
import { runFieldPackage } from "../src/release/field-package-run.js";

process.exitCode = runFieldPackage(process.argv.slice(2));
