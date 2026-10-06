import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  Annotation,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import { fixtureThinker } from "../agent/fixture.js";
import { runAgentKernel } from "../agent/graph.js";
import type {
  AgentProgressReporter,
  AgentState,
} from "../agent/types.js";
import type { IaCEngine } from "../build/types.js";
import type {
  MockScenario,
  Provider,
} from "../discovery/types.js";
import {
  answerStateQuery,
  formatAgentResponse,
} from "./query.js";
import {
  blockedPromptHelp,
} from "./help.js";
import {
  evaluateOperatorRequest,
} from "./operator-policy.js";
import { routeSessionRequest } from "./router.js";
import type { SessionTurn } from "./types.js";

const SessionAnnotation = Annotation.Root({
  request: Annotation<string>,
  provider: Annotation<Provider>,
  engine: Annotation<IaCEngine>,
  mock: Annotation<MockScenario | undefined>,
  approveBuild: Annotation<boolean>,
  fixture: Annotation<boolean>,
  agentState: Annotation<AgentState | undefined>,
  response: Annotation<string | undefined>,
  history: Annotation<SessionTurn[]>({
    reducer: (current, update) => [
      ...(current ?? []),
      ...(update ?? []),
    ],
    default: () => [],
  }),
});

export type LangGraphSessionState =
  typeof SessionAnnotation.State;

async function sessionNode(
  state: LangGraphSessionState,
  progress: AgentProgressReporter,
): Promise<Partial<LangGraphSessionState>> {
  const policy = evaluateOperatorRequest(
    state.request,
    (state.history?.length ?? 0) > 0,
  );

  if (!policy.allowed) {
    progress(
      "Request stopped by operator safety boundary.",
    );

    const response =
      blockedPromptHelp(policy);

    return {
      response,
      history: [
        {
          at: new Date().toISOString(),
          request: state.request,
          command: "GUARDRAIL",
          response,
        },
      ],
    };
  }

  const command = await routeSessionRequest(
    state.request,
    state.history ?? [],
    state.fixture,
    progress,
  );

  if (
    command === "USE_TERRAFORM" ||
    command === "USE_PULUMI"
  ) {
    const engine: IaCEngine =
      command === "USE_TERRAFORM"
        ? "TERRAFORM"
        : "PULUMI";

    const response = [
      "Okay — I switched this session to " +
        engine +
        ".",
      "I will keep the same discovered environment and safety boundaries.",
      "Ask me to build or compare when you're ready. ACT remains disabled.",
    ].join(" ");

    return {
      engine,
      response,
      history: [
        {
          at: new Date().toISOString(),
          request: state.request,
          command,
          response,
        },
      ],
    };
  }

  if (command !== "RUN") {
    const response = answerStateQuery(
      command,
      state.agentState,
      state.engine,
    );

    return {
      response,
      history: [
        {
          at: new Date().toISOString(),
          request: state.request,
          command,
          response,
        },
      ],
    };
  }

  const agentState = await runAgentKernel({
    request: state.request,
    provider: state.provider,
    engine: state.engine,
    mock: state.mock,
    thinker:
      state.fixture
        ? fixtureThinker
        : undefined,
    approveBuild: state.approveBuild,
    progress,
  });

  const response =
    formatAgentResponse(agentState);

  return {
    agentState,
    response,
    history: [
      {
        at: new Date().toISOString(),
        request: state.request,
        command,
        response,
      },
    ],
  };
}

export function createSessionGraph(
  dbPath?: string,
  progress: AgentProgressReporter = () => {},
) {
  const checkpointer = dbPath
    ? (() => {
        mkdirSync(
          dirname(dbPath),
          { recursive: true },
        );

        return SqliteSaver.fromConnString(
          dbPath,
        );
      })()
    : new MemorySaver();

  const graph = new StateGraph(
    SessionAnnotation,
  )
    .addNode(
      "session",
      (state: LangGraphSessionState) =>
        sessionNode(state, progress),
    )
    .addEdge(START, "session")
    .addEdge("session", END)
    .compile({ checkpointer });

  return {
    graph,
    checkpointer,
  };
}
