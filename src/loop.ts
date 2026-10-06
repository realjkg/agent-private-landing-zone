import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import { invokeLocalModel } from "./ollama.js";

export type TaskPlan = {
  complexity: "LOW" | "HIGH";
  freshDataRequired: boolean;
  impact: "LOW" | "HIGH";
  verificationRequired: boolean;
};

export type AgentResult = {
  requestId: string;
  plan: TaskPlan;
  status: "OK" | "DATA_REQUIRED" | "ABSTAIN";
  primary?: string;
  validator?: string;
  adjudication?: string;
  response?: string;
};

function extractJson<T>(value: string): T {
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Model did not return a JSON object");
  return JSON.parse(match[0]) as T;
}

async function classify(request: string): Promise<TaskPlan> {
  const cfg = loadConfig();
  const raw = await invokeLocalModel(cfg.ollamaBaseUrl, cfg.routerModel, [
    {
      role: "system",
      content:
        "Classify the request. Return JSON only with keys complexity (LOW|HIGH), freshDataRequired (boolean), impact (LOW|HIGH), verificationRequired (boolean). Do not answer the request.",
    },
    { role: "user", content: request },
  ]);

  const plan = extractJson<TaskPlan>(raw);
  if (!["LOW", "HIGH"].includes(plan.complexity)) throw new Error("Invalid complexity");
  if (!["LOW", "HIGH"].includes(plan.impact)) throw new Error("Invalid impact");
  if (typeof plan.freshDataRequired !== "boolean") throw new Error("Invalid freshDataRequired");
  if (typeof plan.verificationRequired !== "boolean") throw new Error("Invalid verificationRequired");
  return plan;
}

function evidenceSufficient(plan: TaskPlan, evidence?: string): boolean {
  if (!plan.freshDataRequired) return true;
  return Boolean(evidence?.trim());
}

export async function runAgentLoop(request: string, evidence?: string): Promise<AgentResult> {
  const cfg = loadConfig();
  const requestId = randomUUID();
  const plan = await classify(request);

  if (!evidenceSufficient(plan, evidence)) {
    return { requestId, plan, status: "DATA_REQUIRED" };
  }

  const evidenceBlock = evidence?.trim()
    ? `\n\nEVIDENCE SNAPSHOT:\n${evidence.trim()}`
    : "";

  const primary = await invokeLocalModel(cfg.ollamaBaseUrl, cfg.primaryModel, [
    {
      role: "system",
      content:
        "You are the primary analyst inside a private agentic landing zone. Use only supplied evidence for current facts. Identify uncertainty explicitly.",
    },
    { role: "user", content: request + evidenceBlock },
  ]);

  if (!plan.verificationRequired) {
    return {
      requestId,
      plan,
      status: "OK",
      primary,
      response: primary,
    };
  }

  const validator = await invokeLocalModel(cfg.ollamaBaseUrl, cfg.validatorModel, [
    {
      role: "system",
      content:
        "You are an independent validator. Analyze the user request from the supplied evidence independently. Do not assume another model's answer and do not invent current facts.",
    },
    { role: "user", content: request + evidenceBlock },
  ]);

  const adjudication = await invokeLocalModel(cfg.ollamaBaseUrl, cfg.routerModel, [
    {
      role: "system",
      content:
        "Compare two independent analyses. Return JSON only: {\"agree\": boolean, \"reason\": string}. Be strict about unsupported claims.",
    },
    {
      role: "user",
      content: `PRIMARY:\n${primary}\n\nVALIDATOR:\n${validator}`,
    },
  ]);

  const decision = extractJson<{ agree: boolean; reason: string }>(adjudication);
  if (!decision.agree) {
    return {
      requestId,
      plan,
      status: "ABSTAIN",
      primary,
      validator,
      adjudication: decision.reason,
    };
  }

  return {
    requestId,
    plan,
    status: "OK",
    primary,
    validator,
    adjudication: decision.reason,
    response: primary,
  };
}
