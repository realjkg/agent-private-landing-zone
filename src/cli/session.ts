import { randomUUID } from "node:crypto";
import {
  createInterface,
} from "node:readline/promises";
import {
  stdin as input,
  stdout as output,
} from "node:process";

import { createSessionGraph } from "../session/graph.js";
import { writeEncryptedEvidence } from "../evidence/vault.js";
import { migrateLegacyEvidence } from "../evidence/migrate.js";
import { assertSecureSession } from "../security/session.js";
import type { IaCEngine } from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";

function readArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0
    ? args[index + 1]
    : undefined;
}

function parseProvider(value?: string): Provider {
  return value?.toLowerCase() === "azure"
    ? "AZURE"
    : "AWS";
}

function parseEngine(value?: string): IaCEngine {
  const engine =
    (value ?? "terraform").toLowerCase();

  if (engine === "terraform") {
    return "TERRAFORM";
  }
  if (engine === "pulumi") {
    return "PULUMI";
  }
  if (
    engine === "opentofu" ||
    engine === "tofu"
  ) {
    return "OPENTOFU";
  }

  throw new Error(
    "Use --engine terraform, pulumi, or opentofu.",
  );
}

function parseMock(
  value?: string,
): MockScenario | undefined {
  if (!value) {
    return undefined;
  }

  if (
    value === "brownfield" ||
    value === "greenfield" ||
    value === "unknown"
  ) {
    return value;
  }

  throw new Error(
    "Use --mock brownfield, greenfield, or unknown.",
  );
}

const args = process.argv.slice(2);
const provider = parseProvider(
  readArg("--provider"),
);
let engine = parseEngine(
  readArg("--engine"),
);
const mock = parseMock(
  readArg("--mock"),
);
const fixture = args.includes("--fixture");
const approveBuild =
  args.includes("--approve");
const threadId =
  readArg("--thread") ??
  "lab-" + randomUUID().slice(0, 8);

const migration =
  await migrateLegacyEvidence();

const security =
  await assertSecureSession();

const { graph } =
  createSessionGraph(
    undefined,
    (message) => {
      console.log();
      console.log(
        "agent> " + message,
      );
    },
  );

const config = {
  configurable: {
    thread_id: threadId,
  },
};

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log("SECURED CONVERSATIONAL DEVOPS SESSION");
console.log("────────────────────────────────");
console.log("Security   ATTESTED");
console.log("Evidence   AES-256-GCM encrypted");
console.log("Checkpoint memory-only");
console.log("Shell      unavailable");
console.log("Cloud read disabled by default");
console.log("Mutation   unavailable");
console.log("Commit     " + security.commitSha.slice(0, 12));
console.log(
  "Migration  " +
    migration.migrated +
    " legacy plaintext record(s) secured",
);
console.log();
console.log("Thread    " + threadId);
console.log("Provider  " + provider);
console.log("IaC       " + engine);
console.log(
  "Discovery " +
    (fixture
      ? "deterministic fixture"
      : "LIVE READ-ONLY"),
);
console.log(
  "Reasoner  " +
    (fixture
      ? "deterministic fixture (no model intelligence)"
      : "local Qwen/Mistral intelligence"),
);
console.log();
console.log(
  "Talk to me normally. I can inspect inventory, assess security/SBOM/resiliency,",
);
console.log(
  "explain ownership and brownfield deltas, show evidence, and identify what",
);
console.log(
  fixture
    ? "a preview-only Terraform/Pulumi/OpenTofu build would do. ACT remains disabled."
    : "must be designed next. Real Build stops at the Design boundary; ACT remains disabled.",
);
console.log();
console.log(
  'Try: "Inspect this environment and tell me the biggest risk."',
);
console.log();

const rl = createInterface({
  input,
  output,
});

try {
  while (true) {
    const request =
      (await rl.question("you> ")).trim();

    if (!request) {
      continue;
    }

    if (
      request === ":quit" ||
      request === "exit" ||
      request === "quit" ||
      request === "goodbye"
    ) {
      console.log();
      console.log(
        "Session closed. No cloud changes were made.",
      );
      break;
    }

    console.log();
    console.log("agent> Thinking…");

    const result = await graph.invoke(
      {
        request,
        provider,
        engine,
        mock,
        approveBuild,
        fixture,
      },
      config,
    );

    if (result.engine) {
      engine = result.engine;
    }

    const evidenceName =
      new Date()
        .toISOString()
        .replace(/[:.]/g, "-") +
      "-" +
      threadId;

    console.log(
      "agent> Recording encrypted evidence…",
    );

    await writeEncryptedEvidence(
      "session",
      evidenceName,
      {
        threadId,
        provider,
        engine,
        request,
        response: result.response,
        agentState: result.agentState,
        history: result.history,
        security: {
          secured: security.secured,
          commitSha: security.commitSha,
        },
      },
    );

    console.log();
    console.log(
      "agent> " +
        (result.response ??
          "I don't have a response for that yet."),
    );
    console.log();
  }
} finally {
  rl.close();
}
