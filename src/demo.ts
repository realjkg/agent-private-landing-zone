import {
  runAgentLoop,
  type AgentStatus,
} from "./loop.js";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");

const requestArgs = args.filter(
  (arg) => arg !== "--verbose",
);

const request =
  requestArgs.join(" ") ||
  "Review this architecture decision and identify the strongest operational risk.";

const evidence = process.env.DEMO_EVIDENCE;

const startedAt = Date.now();

function elapsed(): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function symbol(status: AgentStatus): string {
  switch (status) {
    case "COMPLETE":
      return "✓";
    case "ABSTAIN":
    case "DATA_REQUIRED":
      return "!";
    case "ERROR":
      return "✗";
    default:
      return "›";
  }
}

function label(status: AgentStatus): string {
  switch (status) {
    case "ROUTING":
      return "Route";
    case "POLICY":
      return "Policy";
    case "PRIMARY":
      return "Primary";
    case "VALIDATING":
      return "Validator";
    case "ADJUDICATING":
      return "Adjudication";
    case "DATA_REQUIRED":
      return "Evidence";
    case "ABSTAIN":
      return "Decision";
    case "COMPLETE":
      return "Complete";
    case "ERROR":
      return "Error";
  }
}

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log();
console.log(`Request  ${request}`);
console.log();

try {
  const result = await runAgentLoop(
    request,
    evidence,
    (status, detail) => {
      console.log(
        `${symbol(status)} ${label(status).padEnd(12)} ${detail ?? ""}  [${elapsed()}]`,
      );
    },
  );

  console.log();
  console.log("────────────────────────────────");
  console.log();

  if (result.status === "DATA_REQUIRED") {
    console.log("RESULT  DATA REQUIRED");
    console.log();
    console.log(
      "This request depends on current or environment-specific information.",
    );
    console.log(
      "Supply a validated evidence snapshot and run the request again.",
    );
  }

  if (result.status === "ABSTAIN") {
    console.log("RESULT  ABSTAIN");
    console.log();

    if (result.primary) {
      console.log("Primary risk");
      console.log(`  ${result.primary.topRisk}`);
      console.log();
    }

    if (result.validator) {
      console.log("Validator risk");
      console.log(`  ${result.validator.topRisk}`);
      console.log();
    }

    if (result.adjudication) {
      console.log("Why");
      console.log(`  ${result.adjudication}`);
      console.log();
    }

    console.log("Next action");
    console.log(
      "  Supply environment evidence or request a broader risk assessment.",
    );
  }

  if (result.status === "OK" && result.primary) {
    console.log("RESULT  VERIFIED");
    console.log();

    console.log("Top risk");
    console.log(`  ${result.primary.topRisk}`);
    console.log();

    console.log("Why it matters");
    console.log(`  ${result.primary.whyItMatters}`);
    console.log();

    if (result.primary.recommendedActions.length > 0) {
      console.log("Recommended actions");

      for (const action of result.primary.recommendedActions) {
        console.log(`  • ${action}`);
      }

      console.log();
    }

    console.log(
      `Confidence  ${result.primary.confidence}`,
    );

    if (result.adjudication) {
      console.log(
        `Validation  ${result.adjudication}`,
      );
    }
  }

  console.log();
  console.log(
    `Completed in ${(result.durationMs / 1000).toFixed(1)}s`,
  );

  console.log(
    `Request ID   ${result.requestId}`,
  );

  if (verbose) {
    console.log();
    console.log("────────────────────────────────");
    console.log("Verbose execution record");
    console.log();
    console.log(JSON.stringify(result, null, 2));
  }

  if (result.status !== "OK") {
    process.exitCode = 2;
  }
} catch (error) {
  console.log();
  console.log("────────────────────────────────");
  console.log();
  console.log("RESULT  FAILED");

  if (error instanceof Error) {
    console.log(`Reason  ${error.message}`);
  } else {
    console.log("Reason  Unknown execution error");
  }

  process.exitCode = 1;
}
