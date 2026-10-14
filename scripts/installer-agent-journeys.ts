/**
 * On-demand deterministic installer agent report.
 * No live cloud calls, local model inference, real installer or ACT.
 */
import { runJourneyMatrix } from "../src/onboarding/agent-journeys.js";

const result = await runJourneyMatrix();
const blocked = result.results.filter((r) => r.dependencyVerdict === "BLOCKED").length;
const syntheticAuthSuccess = result.results.filter((r) => r.cloudAuthVerdict === "SYNTHETIC_AUTH_OK").length;
const syntheticAuthDenied = result.results.filter((r) => r.cloudAuthVerdict === "SYNTHETIC_AUTH_REJECTED").length;
const report = {
  mode: "SCRIPTED_AGENT_SIMULATION_OFFLINE_ONLY" as const,
  noLiveQualification: true,
  scenarios: result.count,
  dependencyBlocked: blocked,
  fakeAuthSuccess: syntheticAuthSuccess,
  fakeAuthRejected: syntheticAuthDenied,
  infrastructureMutations: 0,
  realCloudRequests: 0,
  realModelCalls: 0,
  actualAct: "DISABLED",
  digestSha256: result.digest,
};
if (process.argv.slice(2).includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log("\nSOVEREIGN ALZ — INSTALLER AGENT JOURNEY SIMULATOR");
  console.log("Offline synthetic fixtures only; no cloud authentication or infrastructure changes.");
  for (const [key, value] of Object.entries(report)) console.log(key.padEnd(28) + String(value));
}
