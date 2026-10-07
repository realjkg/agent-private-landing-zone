import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  mkdirSync,
} from "node:fs";
import {
  arch,
  cpus,
  freemem,
  hostname,
  platform,
  release,
  totalmem,
} from "node:os";
import {
  resolve,
} from "node:path";

import {
  createSessionGraph,
} from "../session/graph.js";
import type {
  QualificationCheck,
} from "../models/qualification.js";

export const PRODUCTION_OLLAMA_VERSION =
  "0.40.0";

export type ProductionHostProfile = {
  targetHardwareId: string;
  runnerName: string;
  hostname: string;
  hostIdentityHash: string;
  platform: string;
  release: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  nodeVersion: string;
  accelerator: string;
};

export type ProductionQualificationContext = {
  sourceCommit: string;
  ollamaBaseUrl: string;
  ollamaVersion: string;
  restartVerified: boolean;
  longRunTurns: number;
  host: ProductionHostProfile;
};

export type MemorySnapshot = {
  freeBytes: number;
  totalBytes: number;
  processRssBytes: number;
};

export type ProductionSessionProbe = {
  historyBeforeRestart: number;
  historyAfterRestart: number;
  mutationObserved: boolean;
};

export type ProductionModelQualification = {
  context: ProductionQualificationContext;
  memoryBefore: MemorySnapshot;
  memoryAfter: MemorySnapshot;
  session: ProductionSessionProbe;
  checks: QualificationCheck[];
  passed: boolean;
};

export type ProductionSessionProbeRunner = (
  turns: number,
) => Promise<ProductionSessionProbe>;

function check(
  name: string,
  passed: boolean,
  detail: string,
): QualificationCheck {
  return {
    name,
    passed,
    detail,
  };
}

function loopback(
  baseUrl: string,
): boolean {
  try {
    const hostname =
      new URL(baseUrl).hostname;

    return (
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function memorySnapshot(): MemorySnapshot {
  return {
    freeBytes: freemem(),
    totalBytes: totalmem(),
    processRssBytes:
      process.memoryUsage().rss,
  };
}

export function collectProductionQualificationContext(
  ollamaBaseUrl: string,
  env: NodeJS.ProcessEnv =
    process.env,
): ProductionQualificationContext {
  const processors = cpus();
  const actualHostname =
    hostname();
  const runnerName =
    env.RUNNER_NAME ??
    "LOCAL";
  const platformName =
    platform();
  const releaseName =
    release();
  const architecture =
    arch();
  const cpuModel =
    processors[0]?.model ??
    "UNKNOWN";
  const cpuCount =
    processors.length;
  const totalMemoryBytes =
    totalmem();
  const hostIdentityHash =
    createHash("sha256")
      .update(
        JSON.stringify({
          runnerName,
          hostname:
            actualHostname,
          platform:
            platformName,
          release:
            releaseName,
          arch:
            architecture,
          cpuModel,
          cpuCount,
          totalMemoryBytes,
        }),
      )
      .digest("hex");

  return {
    sourceCommit:
      env.GITHUB_SHA ??
      env.ALZ_SOURCE_COMMIT ??
      "UNKNOWN",
    ollamaBaseUrl,
    ollamaVersion:
      env.ALZ_OLLAMA_VERSION ??
      "UNKNOWN",
    restartVerified:
      env.ALZ_MODEL_RESTART_VERIFIED ===
      "1",
    longRunTurns:
      Math.max(
        4,
        Number.parseInt(
          env.ALZ_MODEL_LONG_RUN_TURNS ??
            "4",
          10,
        ) || 4,
      ),
    host: {
      targetHardwareId:
        env.ALZ_TARGET_HARDWARE_ID ??
        "UNKNOWN",
      runnerName,
      hostname:
        actualHostname,
      hostIdentityHash,
      platform:
        platformName,
      release:
        releaseName,
      arch:
        architecture,
      cpuModel,
      cpuCount,
      totalMemoryBytes,
      nodeVersion:
        process.version,
      accelerator:
        env.ALZ_TARGET_ACCELERATOR ??
        "UNKNOWN",
    },
  };
}

async function runSessionProbe(
  turns: number,
): Promise<ProductionSessionProbe> {
  const directory = resolve(
    ".runs",
    "model-qualification",
    "checkpoints",
  );
  mkdirSync(
    directory,
    {
      recursive: true,
      mode: 0o700,
    },
  );

  const threadId =
    "production-" +
    randomUUID().slice(0, 12);
  const dbPath = resolve(
    directory,
    threadId + ".sqlite",
  );
  const config = {
    configurable: {
      thread_id: threadId,
    },
  };
  const requests = [
    "Review this simulated AWS brownfield landing zone for the strongest operational risk.",
    "Assess the same simulated environment and identify the safest next design step.",
    "Review the simulated environment for security and resiliency risk without assuming unknown evidence.",
    "Assess whether the current simulated brownfield posture needs a design change.",
  ];
  const split =
    Math.max(
      1,
      Math.floor(turns / 2),
    );

  let result:
    Awaited<
      ReturnType<
        ReturnType<
          typeof createSessionGraph
        >["graph"]["invoke"]
      >
    > | undefined;
  let mutationObserved = false;

  const first =
    createSessionGraph(
      dbPath,
      () => {},
      async () => [],
    ).graph;

  for (
    let index = 0;
    index < split;
    index += 1
  ) {
    result = await first.invoke(
      {
        request:
          requests[
            index %
              requests.length
          ],
        provider: "AWS",
        engine: "TERRAFORM",
        mock: "brownfield",
        approveBuild: false,
        fixture: false,
      },
      config,
    );

    mutationObserved =
      mutationObserved ||
      Boolean(
        result.agentState
          ?.observation
          ?.mutationObserved,
      );
  }

  const historyBeforeRestart =
    result?.history?.length ?? 0;

  const restarted =
    createSessionGraph(
      dbPath,
      () => {},
      async () => [],
    ).graph;

  for (
    let index = split;
    index < turns;
    index += 1
  ) {
    result =
      await restarted.invoke(
        {
          request:
            requests[
              index %
                requests.length
            ],
          provider: "AWS",
          engine: "TERRAFORM",
          mock: "brownfield",
          approveBuild: false,
          fixture: false,
        },
        config,
      );

    mutationObserved =
      mutationObserved ||
      Boolean(
        result.agentState
          ?.observation
          ?.mutationObserved,
      );
  }

  return {
    historyBeforeRestart,
    historyAfterRestart:
      result?.history?.length ?? 0,
    mutationObserved,
  };
}

export async function qualifyProductionModelRuntime(
  context: ProductionQualificationContext,
  probe:
    ProductionSessionProbeRunner =
      runSessionProbe,
  readMemory:
    () => MemorySnapshot =
      memorySnapshot,
): Promise<ProductionModelQualification> {
  const checks:
    QualificationCheck[] = [];
  const memoryBefore =
    readMemory();

  checks.push(
    check(
      "target hardware identity",
      Boolean(
        context.host
          .targetHardwareId
          .trim(),
      ) &&
        context.host
          .targetHardwareId !==
          "UNKNOWN",
      "production qualification requires an explicit target hardware identifier",
    ),
  );

  checks.push(
    check(
      "actual host fingerprint",
      /^[0-9a-f]{64}$/i.test(
        context.host
          .hostIdentityHash,
      ) &&
        Boolean(
          context.host.hostname
            .trim(),
        ) &&
        Boolean(
          context.host.runnerName
            .trim(),
        ),
      "production evidence must include the actual runner/host fingerprint",
    ),
  );

  checks.push(
    check(
      "source commit binding",
      /^[0-9a-f]{40}$/i.test(
        context.sourceCommit,
      ),
      "production evidence must bind to an exact 40-character source commit",
    ),
  );

  checks.push(
    check(
      "local inference boundary",
      loopback(
        context.ollamaBaseUrl,
      ),
      "production model qualification must use a loopback/private local inference endpoint",
    ),
  );

  checks.push(
    check(
      "pinned inference runtime",
      context.ollamaVersion.includes(
        PRODUCTION_OLLAMA_VERSION,
      ),
      "expected Ollama " +
        PRODUCTION_OLLAMA_VERSION +
        ", got " +
        context.ollamaVersion,
    ),
  );

  checks.push(
    check(
      "model process restart",
      context.restartVerified,
      "the isolated local model service must be restarted and return healthy before final qualification",
    ),
  );

  let session: ProductionSessionProbe = {
    historyBeforeRestart: 0,
    historyAfterRestart: 0,
    mutationObserved: false,
  };

  try {
    session =
      await probe(
        context.longRunTurns,
      );

    checks.push(
      check(
        "checkpoint continuation",
        session
          .historyBeforeRestart >
          0 &&
          session
            .historyAfterRestart >=
            context.longRunTurns,
        "LangGraph checkpoint history did not survive graph recreation",
      ),
    );

    checks.push(
      check(
        "long-running session workload",
        session
          .historyAfterRestart >=
          context.longRunTurns,
        "the required multi-turn session workload did not complete",
      ),
    );

    checks.push(
      check(
        "runtime mutation boundary",
        !session.mutationObserved,
        "a production qualification session observed infrastructure mutation",
      ),
    );
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "production session probe failed";

    checks.push(
      check(
        "checkpoint continuation",
        false,
        detail,
      ),
      check(
        "long-running session workload",
        false,
        detail,
      ),
      check(
        "runtime mutation boundary",
        false,
        detail,
      ),
    );
  }

  const memoryAfter =
    readMemory();
  const requiredReserve =
    Math.min(
      512 * 1024 * 1024,
      memoryAfter.totalBytes *
        0.03,
    );

  checks.push(
    check(
      "memory reserve",
      memoryAfter.freeBytes >
        requiredReserve,
      "free memory fell below the fixed production safety reserve",
    ),
  );

  return {
    context,
    memoryBefore,
    memoryAfter,
    session,
    checks,
    passed:
      checks.every(
        (item) => item.passed,
      ),
  };
}
