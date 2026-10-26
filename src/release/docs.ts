import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { reviewRepositoryRelease, type ReleaseAdmissionInput, type ReleaseAdmissionReport } from "../qualification/release-admission.js";
import { checkJourneyMatrix, loadJourneyMatrix } from "./acceptance.js";
import { loadReleaseScope, loadReleaseStatus, renderReleaseStatus, statusProblems, type ReleaseStatus } from "./status.js";
import { loadWorkGraph, renderWorkGraph, workGraphProblems, type WorkGraph } from "./work-graph.js";

/**
 * `npm run docs:release`: checks config/release/status.json against the scope, the admission review of the frozen
 * candidate and the journey matrix, and config/release/work-graph.json for a well-formed, acyclic plan, then writes the
 * release view to docs/release-status.md and the work graph to docs/work-graph.md. It writes nothing when a claim does
 * not check.
 */
export async function releaseStatusView(root: string): Promise<{ problems: string[]; markdown?: string; workGraph?: string }> {
  const scope = loadReleaseScope(root);
  const status = loadReleaseStatus(root);
  const journeys = checkJourneyMatrix(loadJourneyMatrix(root), root).rows;
  let admission: ReleaseAdmissionReport | undefined;
  if (scope.manifest !== null && scope.candidate !== null) {
    const manifest = JSON.parse(readFileSync(resolve(root, scope.manifest), "utf8")) as ReleaseAdmissionInput;
    admission = await reviewRepositoryRelease({
      manifest, root, expectedCommit: scope.candidate,
      outOfScope: scope.outOfScope.map((x) => x.gate),
    });
  }
  const graph = loadWorkGraph(root);
  const problems = [...statusProblems(status, { scope, journeys, ...(admission ? { admission } : {}) }), ...workGraphProblems(graph)];
  return problems.length > 0 ? { problems }
    : { problems, markdown: renderReleaseStatus(status as ReleaseStatus, scope), workGraph: renderWorkGraph(graph as WorkGraph) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  releaseStatusView(root).then(({ problems, markdown, workGraph }) => {
    if (markdown === undefined || workGraph === undefined) {
      console.error("Release status not written: " + problems.length + " claim(s) do not check.");
      for (const problem of problems) console.error("  " + problem);
      process.exitCode = 1;
      return;
    }
    writeFileSync(join(root, "docs", "release-status.md"), markdown);
    writeFileSync(join(root, "docs", "work-graph.md"), workGraph);
    console.log("Wrote docs/release-status.md and docs/work-graph.md");
  }).catch((error: unknown) => {
    console.error("Release status not written: " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
