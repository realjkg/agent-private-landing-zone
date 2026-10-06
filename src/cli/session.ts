import { randomUUID } from "node:crypto";
import {
  createInterface,
} from "node:readline/promises";
import {
  stdin as input,
  stdout as output,
} from "node:process";

import { createSessionGraph } from "../session/graph.js";
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
  return value?.toLowerCase() === "pulumi"
    ? "PULUMI"
    : "TERRAFORM";
}

function parseMock(value?: string): MockScenario {
  if (
    value === "greenfield" ||
    value === "unknown"
  ) {
    return value;
  }

  return "brownfield";
}

const args = process.argv.slice(2);
const provider = parseProvider(
  readArg("--provider"),
);
const engine = parseEngine(
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

const { graph } =
  createSessionGraph();

const config = {
  configurable: {
    thread_id: threadId,
  },
};

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log("INTERACTIVE SESSION · ACT DISABLED");
console.log();
console.log("Thread    " + threadId);
console.log("Provider  " + provider);
console.log("IaC       " + engine);
console.log(
  "Reasoner  " +
    (fixture
      ? "deterministic fixture"
      : "local Qwen/Mistral"),
);
console.log();
console.log(
  "Use :status, :environment, :evidence, :help, :quit",
);
console.log();

const rl = createInterface({
  input,
  output,
});

try {
  while (true) {
    const request =
      (await rl.question("> ")).trim();

    if (!request) {
      continue;
    }

    if (
      request === ":quit" ||
      request === "exit" ||
      request === "quit"
    ) {
      break;
    }

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

    console.log();
    console.log(
      result.response ??
        "No response was produced.",
    );
    console.log();
  }
} finally {
  rl.close();
}
