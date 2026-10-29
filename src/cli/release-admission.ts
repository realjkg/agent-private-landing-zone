import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  reviewRepositoryRelease,
  type ReleaseAdmissionInput,
} from "../qualification/release-admission.js";
import { loadReleaseScope } from "../release/status.js";
import { assertCleanSource, blockedHandler, evidenceDir, headCommit, writeJsonOnce } from "../util/cli-support.js";

/** `node dist/cli/release-admission.js --manifest <file>`, with the arguments after the script. */
export async function releaseAdmission(args: string[]): Promise<void> {
  const argument = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
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
  const result = await reviewRepositoryRelease({
    manifest, expectedCommit: sourceCommit, root: process.cwd(),
    outOfScope: loadReleaseScope(process.cwd()).outOfScope.map((x) => x.gate),
  });
  const out = resolve(evidenceDir("release"), "admission-" + randomUUID() + ".json");
  writeJsonOnce(out, result);
  console.log("Production evidence admission — PREVIEW_OPERATE / ACT DISABLED");
  for (const gate of result.gates) {
    console.log({ EVIDENCE_PRESENT: "EVIDENCE ", BLOCKED: "BLOCKED  ", OUT_OF_SCOPE: "EXCLUDED " }[gate.status] +
      gate.id + (gate.blockers.length ? " (" + gate.blockers.join(", ") + ")" : ""));
  }
  if (result.actPilot) console.log("Pilot ACT (human-authorized, " + result.actPilot.provider + " " + result.actPilot.engine + ") under contract " + result.actPilot.contractSha256);
  for (const path of result.actPilots) {
    console.log("Pilot ACT path (human-authorized, " + path.provider + " " + path.engine + ") under contract " + path.contractSha256 + " from commit " + path.contractCommit);
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  releaseAdmission(process.argv.slice(2)).catch(blockedHandler("RELEASE_ADMISSION_BLOCKED: ", 160));
}
