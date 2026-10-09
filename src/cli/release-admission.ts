import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  reviewProductionRelease,
  type ReleaseAdmissionInput,
} from "../qualification/release-admission.js";

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
  const sourceCommit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim()) {
    throw new Error("RELEASE_ADMISSION_SOURCE_WORKTREE_DIRTY");
  }
  const file = resolve(argument("--manifest")!);
  const manifest = JSON.parse(readFileSync(file, "utf8")) as ReleaseAdmissionInput;
  const result = await reviewProductionRelease({
    manifest, expectedCommit: sourceCommit, root: process.cwd(),
  });
  const out = resolve(".runs", "release", "admission-" + randomUUID() + ".json");
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n", {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  console.log("Production evidence admission — PREVIEW_OPERATE / ACT DISABLED");
  for (const gate of result.gates) {
    console.log((gate.status === "EVIDENCE_PRESENT" ? "EVIDENCE " : "BLOCKED  ") +
      gate.id + (gate.blockers.length ? " (" + gate.blockers.join(", ") + ")" : ""));
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

main().catch((error) => {
  console.error("RELEASE_ADMISSION_BLOCKED: " +
    (error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN"));
  process.exitCode = 1;
});
