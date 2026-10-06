import { runAgentLoop } from "./loop.js";

const request =
  process.argv.slice(2).join(" ") ||
  "Review this architecture decision and identify the strongest operational risk.";

const evidence = process.env.DEMO_EVIDENCE;

console.log("Adapt Cloud Agentic Landing Zone — local demo");
console.log("Request:", request);

const result = await runAgentLoop(request, evidence);

console.log("\nExecution result:");
console.log(JSON.stringify(result, null, 2));

if (result.status !== "OK") {
  process.exitCode = 2;
}
