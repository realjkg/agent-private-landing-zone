import { loadConfig } from "../config.js";
import { invokeLocalModel, type OllamaMessage } from "../ollama.js";
import { governedUserRequest, wrapUntrustedEvidence } from "../security/prompt-governance.js";
import { readPilotContext, runIdFromRequest, type PilotContextOptions, type PilotQuery, type PilotToolResult } from "./pilot-context.js";

/**
 * The local model's part in the pilot journey (RB3): it explains what the read-only pilot records say. It never acts.
 *
 * 1. A deterministic read (src/session/pilot-context.ts) returns the facts or a refusal with its code and message.
 * 2. The facts are always printed as read. They are the answer.
 * 3. The local model (loopback only, src/ollama.ts) may add a short explanation, built from those facts alone. The guard
 *    below withholds an explanation that claims success the record does not show, claims the model did something,
 *    leaves out a refusal code, or carries a command or a link. Nothing falls back to another model or endpoint.
 * 4. The exact next step for the person is printed by this code, never by the model, and is never run.
 */
export type PilotExplainer = (messages: OllamaMessage[]) => Promise<string>;

export type PilotAnswerOptions = PilotContextOptions & {
  /** The local model call. Omitted (fixture sessions), no model is asked. */
  explain?: PilotExplainer;
  /** The model's name, for the label only. */
  modelName?: string;
};

export type GuardCode =
  | "MODEL_EXPLANATION_EMPTY"
  | "MODEL_EXPLANATION_TOO_LONG"
  | "MODEL_EXPLANATION_HAS_COMMAND"
  | "MODEL_EXPLANATION_HAS_LINK"
  | "MODEL_CLAIMED_ACTION"
  | "MODEL_FABRICATED_SUCCESS"
  | "MODEL_OMITTED_REFUSAL_CODE";

export type GuardResult = { ok: true; text: string } | { ok: false; code: GuardCode; reason: string };

const MAX_EXPLANATION = 1200;
const ACTION_CLAIM =
  /\bI\s+(?:have\s+|'ve\s+|just\s+|already\s+|now\s+)?(?:approved|applied|executed|ran|started|launched|deployed|deleted|destroyed|cleaned|removed|signed|sealed|edited|modified|changed|updated|enabled|disabled|authori[sz]ed|wrote|written|created|provisioned|qualified)\b/i;
const SUCCESS_CLAIM =
  /\b(?:succeeded|successful(?:ly)?|completed?|passed|pass(?:es)?|worked|is done|went well|all (?:set|good)|verified|deployed|(?:was|were|been|got) (?:built|created|deleted|cleaned up|removed)|fully (?:built|deleted|cleaned))\b/i;
const NEGATION = /\b(?:not|no|never|none|nothing|without|cannot|isn't|wasn't|weren't|hasn't|haven't|didn't|doesn't|failed|unverified|unresolved|yet)\b|n't\b/i;

/** Splits text into sentences for the success check. */
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);

/** Decides whether the model's explanation may be shown beside the record. Fails closed: when in doubt, the record alone is shown. */
export function guardExplanation(raw: string, result: PilotToolResult): GuardResult {
  const text = raw.trim();
  if (!text) return { ok: false, code: "MODEL_EXPLANATION_EMPTY", reason: "the model returned nothing" };
  if (text.length > MAX_EXPLANATION) return { ok: false, code: "MODEL_EXPLANATION_TOO_LONG", reason: "the explanation exceeded " + MAX_EXPLANATION + " characters" };
  if (/\.\/alz\b|\balz\s+apply\b|```|\$\s*\w/.test(text)) {
    return { ok: false, code: "MODEL_EXPLANATION_HAS_COMMAND", reason: "only the product names a command; the model's text may not carry one" };
  }
  if (/\b(?:https?|ftp):\/\/|\bwww\./i.test(text)) return { ok: false, code: "MODEL_EXPLANATION_HAS_LINK", reason: "the explanation may not carry a link" };
  if (ACTION_CLAIM.test(text)) return { ok: false, code: "MODEL_CLAIMED_ACTION", reason: "the model claimed to have acted; it can only read records" };
  if (!result.ok && !text.includes(result.code)) {
    return { ok: false, code: "MODEL_OMITTED_REFUSAL_CODE", reason: "an explanation of a refusal must quote its code (" + result.code + ")" };
  }
  const succeeded = result.ok && result.succeeded;
  if (!succeeded) {
    const claim = sentences(text).find((sentence) => SUCCESS_CLAIM.test(sentence) && !NEGATION.test(sentence));
    if (claim) return { ok: false, code: "MODEL_FABRICATED_SUCCESS", reason: "the explanation states success that the record does not show" };
  }
  return { ok: true, text };
}

const TITLES: Readonly<Record<PilotQuery, string>> = {
  PILOT_BLUEPRINT: "Pilot blueprint",
  PILOT_PREVIEW: "Pilot preview (sealed change summary)",
  PILOT_STATUS: "Pilot run status",
  PILOT_OBSERVED: "What was built (independent observation) and what is left",
  PILOT_FAILURE: "Why the run failed or is not finished",
  PILOT_READINESS: "Pilot readiness",
};

const SYSTEM_PROMPT = [
  "You explain records from a governed infrastructure pilot to the person running it.",
  "Use only the facts inside the UNTRUSTED_EVIDENCE block. Never add a fact, a number, a resource or an outcome that is not there.",
  "If the record shows a refusal, quote its code exactly and explain it in one or two sentences.",
  "If a stage failed, is NOT_RUN or is INCONCLUSIVE, say so plainly; never call the run successful unless every stage shows PASS.",
  "You cannot approve, apply, clean up, sign, seal, edit the pilot contract, change authorization or run any command, and you never say that you did.",
  "Do not write commands, code blocks or links. The product prints the person's next step itself.",
  "Answer in at most five short sentences of plain U.S. English.",
].join("\n");

function factsOf(result: PilotToolResult): string {
  return JSON.stringify(result.ok
    ? { query: result.query, source: result.source, succeeded: result.succeeded, facts: result.lines, failures: result.failures }
    : { query: result.query, refused: true, code: result.code, message: result.message });
}

/** The model's failure reason, by code only: an error message is never echoed (it could carry an address). */
function failureCode(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,}/.exec(text)?.[0] ?? "MODEL_UNAVAILABLE";
}

/** Answers one read-only pilot question: the record's facts, a guarded local-model explanation, and the person's next step. */
export async function answerPilotQuery(query: PilotQuery, request: string, options: PilotAnswerOptions = {}): Promise<{ response: string; result: PilotToolResult }> {
  const result = readPilotContext(query, { root: options.root, runId: options.runId ?? runIdFromRequest(request) });
  const lines: string[] = [TITLES[query] + " — read-only" + (result.ok ? ", from " + result.source : "")];
  if (result.ok) lines.push(...result.lines);
  else lines.push("Refused: " + result.code + ": " + result.message);

  if (options.explain) {
    const label = "Local model explanation" + (options.modelName ? " (" + options.modelName + ")" : "");
    try {
      const raw = await options.explain([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [wrapUntrustedEvidence(factsOf(result)), governedUserRequest(request)].join("\n\n") },
      ]);
      const guarded = guardExplanation(raw, result);
      lines.push("");
      lines.push(guarded.ok
        ? label + ", from the record above only:\n" + guarded.text
        : label + " withheld (" + guarded.code + "): " + guarded.reason + ". The record above is the answer.");
    } catch (error) {
      lines.push("");
      lines.push(label + " unavailable (" + failureCode(error) + "). The record above is the answer; no other model or endpoint was tried.");
    }
  }

  lines.push("");
  lines.push("Your next step (a person runs it; this session never does): " + result.nextStep);
  lines.push("The model cannot approve, apply, clean up or change the pilot contract.");
  return { response: lines.join("\n"), result };
}

/** The default explainer: the configured PRIMARY model on the loopback model server. */
export function localModelExplainer(): { explain: PilotExplainer; modelName: string } {
  const cfg = loadConfig();
  return {
    modelName: cfg.primaryModel,
    explain: (messages) => invokeLocalModel(cfg.ollamaBaseUrl, cfg.primaryModel, messages, { think: false, timeoutMs: 60_000 }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests the model may never carry out. Each answer names who does it and the exact command or console step.

export type HandoffKind = "APPROVE" | "APPLY" | "CLEANUP" | "CONTRACT" | "HOSTED_INFERENCE";

const HOSTED = /\b(?:openai|chat ?gpt|gpt-?\d|anthropic|claude|gemini|bedrock|vertex ai|azure openai|mistral\.ai|hosted (?:model|inference|llm|ai)|cloud (?:model|llm|inference|ai)|remote (?:model|llm|inference)|api key for (?:a|the) model)\b/i;
const CONTRACT = /\b(?:edit|change|modify|update|write|rewrite|add|remove|delete|empty|clear|set|bypass|lift|disable|turn off)\b.{0,40}\b(?:pilot contract|act-pilot-contract|contract|authori[sz]e (?:entry|list)|authori[sz]ation|approver allowlist|allowlist|kill ?switch)\b|\b(?:enable|turn on|activate|unlock)\b.{0,20}\bact\b|\bauthori[sz]e\b.{0,30}\b(?:act|apply|cleanup|myself|me)\b/i;
const VERB_LEAD = /^(?:please\s+|ok(?:ay)?,?\s+|now\s+|go ahead and\s+|just\s+)?/;
const ASK = /\b(?:can you|could you|would you|will you|please|go ahead and|i want you to|you should|you can|for me|yourself|on my behalf)\b/i;
const APPROVE = /\b(?:approve|sign|co-?sign|countersign)\b/i;
const CLEANUP = /\b(?:clean ?up|cleanup|destroy|tear ?down|teardown|(?:delete|remove) (?:the |all |every |what )?(?:resources|run|stack|environment|deployment|everything|it|them|(?:was|we|you) (?:built|created)))\b/i;
const APPLY = /\b(?:apply|execute|run the (?:plan|apply|change)|start the (?:apply|run|change)|push the change|make the change)\b|\b(?:deploy|provision) (?:it|this|that|the (?:plan|change|sealed plan))\b/i;

/** A request to act in the pilot (approve, apply, clean up, change the contract) or to reach hosted inference; undefined otherwise. */
export function pilotHandoffKind(request: string): HandoffKind | undefined {
  const value = request.trim().toLowerCase();
  if (HOSTED.test(value) && /\b(?:use|switch|fall ?back|send|route|call|ask|try|connect)\b/.test(value)) return "HOSTED_INFERENCE";
  if (CONTRACT.test(value)) return "CONTRACT";
  const imperative = (verb: RegExp) => new RegExp(VERB_LEAD.source + verb.source, "i").test(value) || (ASK.test(value) && verb.test(value));
  if (imperative(APPROVE)) return "APPROVE";
  if (imperative(CLEANUP)) return "CLEANUP";
  if (imperative(APPLY)) return "APPLY";
  return undefined;
}

const HANDOFF: Readonly<Record<HandoffKind, { code: string; lines: string[] }>> = {
  APPROVE: { code: "PILOT_ACTION_HUMAN_ONLY", lines: [
    "Approving is a person's decision. The model holds no approver key and never signs.",
    "Each approver reviews the bundle and runs: ./alz apply approve --bundle REVIEW_BUNDLE.json --key YOUR_APPROVER_KEY.pem --approver YOUR_ID",
    "Ask me to \"show the preview\" to read the sealed change summary first.",
  ] },
  APPLY: { code: "PILOT_ACTION_HUMAN_ONLY", lines: [
    "Executing the change is a person's step through the governed driver. The model never starts an apply.",
    "At the terminal: ./alz apply apply --request REQUEST.json --manifest MANIFEST.json --sealed SEALED_PLAN --approval APPROVAL.json",
    "Or in the console's Pilot apply wizard, with the one-time session token printed in the terminal that started the console. A workflow runs wholly in one of the two.",
    "Ask me for \"status of run <id>\" afterward; I read the report your run leaves.",
  ] },
  CLEANUP: { code: "PILOT_ACTION_HUMAN_ONLY", lines: [
    "Cleanup is a person's step, from an approved proposal. The model never proposes, approves or runs it.",
    "1. ./alz apply propose-cleanup --sealed SEALED_PLAN --requester YOUR_ID --key YOUR_REQUESTER_KEY.pem",
    "2. Approvers sign it; then: ./alz apply cleanup --proposal PROPOSAL.json --request REQUEST.json --manifest MANIFEST.json --sealed SEALED_PLAN --approval APPROVAL.json",
    "3. ./alz apply verify-cleanup --proposal PROPOSAL.json, then ask me \"what is left over\".",
  ] },
  CONTRACT: { code: "PILOT_AUTHORITY_OWNER_ONLY", lines: [
    "The pilot contract, its authorize entry, the approver allowlist and the kill switch belong to the owner.",
    "The owner edits config/act-pilot-contract.json by hand in a reviewed commit. No product code path, flag, variable, agent or model writes it.",
    "I can show what the latest preparation and preflight say: ask \"am I ready to seal?\"",
  ] },
  HOSTED_INFERENCE: { code: "HOSTED_INFERENCE_REFUSED", lines: [
    "Inference stays on this machine. The model client only calls a credential-free http loopback address (OLLAMA_BASE_URL), and there is no hosted fallback.",
    "Use the pinned local Qwen or Mistral model: ./alz models verify checks the installed versions against config/tool-pins.json.",
  ] },
};

/** The deterministic refusal for a request the model may not carry out, with the person's exact step. */
export function pilotHandoffResponse(kind: HandoffKind): string {
  const entry = HANDOFF[kind];
  return ["REFUSED (" + entry.code + "): the session does not do this.", ...entry.lines, "Nothing was run, signed or changed."].join("\n");
}
