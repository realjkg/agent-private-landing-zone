import { loadConfig } from "../config.js";
import { invokeLocalModel } from "../ollama.js";
import {
  classifySessionCommand,
} from "./query.js";
import type {
  SessionCommand,
  SessionTurn,
} from "./types.js";

const ALLOWED: SessionCommand[] = [
  "RUN",
  "STATUS",
  "ENVIRONMENT",
  "EVIDENCE",
  "EXPLAIN",
  "NEXT",
  "COMPARE_IAC",
  "USE_TERRAFORM",
  "USE_PULUMI",
  "USE_OPENTOFU",
  "PROMPT_GUIDE",
  "HELP",
];

function extractJson(value: string): {
  command?: string;
} {
  const match = value.match(/\{[\s\S]*\}/);

  if (!match) {
    throw new Error(
      "INVALID_SESSION_ROUTER_OUTPUT",
    );
  }

  return JSON.parse(match[0]) as {
    command?: string;
  };
}

function validCommand(
  value?: string,
): value is SessionCommand {
  return Boolean(
    value &&
      ALLOWED.includes(
        value as SessionCommand,
      ),
  );
}

export async function routeSessionRequest(
  request: string,
  history: SessionTurn[],
  fixture: boolean,
  progress: (message: string) => void = () => {},
): Promise<SessionCommand> {
  const deterministic =
    classifySessionCommand(request);

  if (
    deterministic !== "RUN" ||
    fixture
  ) {
    return deterministic;
  }

  if (
    history.length === 0 &&
    /inspect|discover|inventory|scan|assess|review|evaluate|design|build|generate|terraform|pulumi|landing zone/i.test(
      request,
    )
  ) {
    return "RUN";
  }

  progress("Understanding your request…");

  const cfg = loadConfig();

  const recent = history
    .slice(-6)
    .map((turn) => ({
      request: turn.request,
      command: turn.command,
      response: turn.response,
    }));

  try {
    const raw = await invokeLocalModel(
      cfg.ollamaBaseUrl,
      cfg.routerModel,
      [
        {
          role: "system",
          content: [
            "You route a conversational private DevOps agent session.",
            "Classify the user's latest turn; do not answer it.",
            "",
            "Return JSON only:",
            '{"command":"RUN|STATUS|ENVIRONMENT|EVIDENCE|EXPLAIN|NEXT|COMPARE_IAC|USE_TERRAFORM|USE_PULUMI|USE_OPENTOFU|PROMPT_GUIDE|HELP"}',
            "",
            "Use RUN for a new task that should enter the governed Agent Kernel,",
            "including discovery, assessment, architecture analysis, build, or change requests.",
            "Use state-query commands only when the user is asking about the",
            "existing session state or a follow-up to a previous result.",
            "USE_TERRAFORM and USE_PULUMI only change the selected preview engine.",
            "Never classify anything as apply, deploy, destroy, shell, or arbitrary execution.",
            "ACT is not an available capability.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            recentConversation: recent,
            latestRequest: request,
          }),
        },
      ],
    );

    const parsed =
      extractJson(raw);

    if (
      validCommand(parsed.command)
    ) {
      progress("Request routing complete.");
      return parsed.command;
    }
  } catch {
    // Fail closed to deterministic routing.
  }

  return deterministic;
}
