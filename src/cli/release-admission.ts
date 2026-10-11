import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadPilotContract } from "../apply/contract.js";
import {
  reviewProductionRelease,
  type ReleaseAdmissionInput,
} from "../qualification/release-admission.js";
import { assertCleanSource, blockedHandler, evidenceDir, headCommit, writeJsonOnce } from "../util/cli-support.js";

function argument(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Sovereign ALZ production evidence admission (no deployments)");
    console.log("node dist/cli/release-admission.js --manifest .runs/release/evidence-index.json");
    console.log("Returns BLOCKED until all actual source/target/provider/recovery/security evidence exists.");
    return;
  }
  if (args.length !== 2 || args[0] !== "--manifest" ||
      !argument("--manifest") || argument("--manifest")!.startsWith("-")) {
    throw new Error("RELEASE_ADMISSION_REQUIRES_MANIFEST");
  }
  const sourceCommit = headCommit();
  assertCleanSource("RELEASE_ADMISSION_SOURCE_WORKTREE_DIRTY");
  const file = resolve(argument("--manifest")!);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as ReleaseAdmissionInput;
  const result = await reviewProductionRelease({
    manifest, expectedCommit: sourceCommit, root: process.cwd(),
    // ACT is off unless this release declares PILOT and config/act-pilot-contract.json is valid and enabled.
    pilotContract: loadPilotContract(),
  });
  const out = resolve(evidenceDir("release"), "admission-" + randomUUID() + ".json");
  writeJsonOnce(out, result);
  console.log("Production evidence admission — PREVIEW_OPERATE / ACT DISABLED");
  for (const gate of result.gates) {
    console.log((gate.status === "EVIDENCE_PRESENT" ? "EVIDENCE " : "BLOCKED  ") +
      gate.id + (gate.blockers.length ? " (" + gate.blockers.join(", ") + ")" : ""));
  }
  if (result.actPilot) console.log("Pilot ACT (human-authorized, " + result.actPilot.provider + " " + result.actPilot.engine + ") under contract " + result.actPilot.contractSha256);
  console.log("Source: " + sourceCommit);
  console.log("Candidate identity: " + result.candidateIdentityHash);
  console.log("Admission report: " + out);
  if (result.readyForIndependentReleaseReview) {
    console.log("Evidence structurally present. Independent authenticity/security/owner approval REQUIRED.");
    console.log("Production release approval: NOT GRANTED");
  } else {
    console.log("Release BLOCKED: required evidence missing or invalid");
    process.exitCode = 1;
  }
}

main().catch(blockedHandler("RELEASE_ADMISSION_BLOCKED: ", 160));
