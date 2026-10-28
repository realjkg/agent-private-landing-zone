import { z } from "zod";

import { loadConfig } from "../config.js";
import { invokeLocalModel, type OllamaMessage } from "../ollama.js";
import { governedUserRequest, wrapUntrustedEvidence } from "../security/prompt-governance.js";
import { readPilotContext, runIdFromRequest, type CauseCode, type PilotContextOptions, type PilotQuery, type PilotToolResult } from "./pilot-context.js";

/**
 * The local model's part in the pilot journey (RB3). The model never authors displayed prose here.
 *
 * 1. A deterministic read (src/session/pilot-context.ts) returns the facts, or a refusal with its code and message, and
 *    the closed causes the record shows.
 * 2. The facts are always printed as read. They are the answer.
 * 3. The local model (loopback only, src/ollama.ts) may return a structured selection, and nothing else:
 *    `{ "focus": ["F2", …], "cause"?: "<one of the record's causes>" }`. It is validated against a strict schema
 *    built from this record (fact ids that exist, causes the record carries). The product renders the selected facts
 *    verbatim and a fixed, product-authored sentence for the cause. Free text from the model is never shown, so it
 *    cannot state success, claim an action or carry a command. Invalid, empty or unknown output shows the facts only,
 *    with a fixed note. There is no retry and no fallback to another model or endpoint.
 * 4. Success wording comes only from the record, through a fixed product sentence tied to a verified-success state.
 * 5. The exact next step for the person is printed by this code, never by the model, and is never run.
 */
export type PilotExplainer = (messages: OllamaMessage[], format: Record<string, unknown>) => Promise<string>;

export type PilotAnswerOptions = PilotContextOptions & {
  /** The local model call. Omitted (fixture sessions), no model is asked. */
  explain?: PilotExplainer;
  /** The model's name, for the label only. */
  modelName?: string;
};

/** The largest raw model reply that is parsed at all. */
export const MAX_SELECTION_BYTES = 2048;
const MAX_FOCUS = 5;

/** A fixed, product-authored sentence for each cause. The model only picks the code. */
export const CAUSE_SENTENCES: Readonly<Record<CauseCode, string>> = {
  PILOT_RECORD_NOT_FOUND: "No record for this question exists yet in this checkout, so nothing can be reported for it.",
  PILOT_RECORD_INVALID: "A record was found but did not have the expected shape, so it was not read.",
  PILOT_RUN_AMBIGUOUS: "The run id matches more than one run; more characters of the artifact hash are needed.",
  PREPARATION_BLOCKED_OWNER: "The preparation is blocked on an owner step.",
  PREPARATION_BLOCKED_OPERATOR: "The preparation is blocked on an operator step.",
  PREPARATION_BLOCKED_TOOL: "The preparation is blocked on a missing local tool.",
  PREPARATION_BLOCKED: "The preparation is blocked.",
  QUALIFY_FIRST: "The engine path is not qualified yet, so qualification in DEV comes before sealing.",
  EXECUTE_FAIL: "The apply stage did not succeed.",
  EXECUTE_NOT_RUN: "The apply stage has not run.",
  EXECUTE_INCONCLUSIVE: "The apply stage is undecided.",
  OBSERVE_FAIL: "The independent observation found a planned resource missing or something unexpected.",
  OBSERVE_NOT_RUN: "The run has not been independently observed yet.",
  OBSERVE_INCONCLUSIVE: "The independent observation could not decide every resource.",
  PROPOSE_FAIL: "The cleanup proposal does not belong to this run.",
  PROPOSE_NOT_RUN: "No cleanup has been proposed for this run yet.",
  PROPOSE_INCONCLUSIVE: "The cleanup proposal is undecided.",
  CLEANUP_FAIL: "The cleanup did not succeed; a person reviews it.",
  CLEANUP_NOT_RUN: "The approved cleanup has not run yet.",
  CLEANUP_INCONCLUSIVE: "The cleanup is undecided.",
  LEFTOVERS_FAIL: "The leftover check failed.",
  LEFTOVERS_NOT_RUN: "Leftovers have not been verified for this run yet.",
  LEFTOVERS_INCONCLUSIVE: "The leftover check is not complete, so the cleanup is not confirmed complete.",
};

/** The facts the model may point at, with stable ids F1…Fn in printed order. A refusal is one fact. */
export function factsOf(result: PilotToolResult): { id: string; text: string }[] {
  const texts = result.ok ? result.lines : ["Refused: " + result.code + ": " + result.message];
  return texts.map((text, index) => ({ id: "F" + (index + 1), text }));
}

/** The strict schema for one record: only its fact ids, only its causes, no other key. */
export function selectionSchema(result: PilotToolResult) {
  const ids = factsOf(result).map((fact) => fact.id);
  const focus = z.array(z.enum(ids as [string, ...string[]])).min(1).max(Math.min(MAX_FOCUS, ids.length))
    .refine((items) => new Set(items).size === items.length, "duplicate fact id");
  return result.causes.length > 0
    ? z.object({ focus, cause: z.enum(result.causes as [CauseCode, ...CauseCode[]]).optional() }).strict()
    : z.object({ focus }).strict();
}

/** The same constraints as JSON Schema, for Ollama's structured-output `format`. */
export function selectionJsonSchema(result: PilotToolResult): Record<string, unknown> {
  const ids = factsOf(result).map((fact) => fact.id);
  return {
    type: "object",
    additionalProperties: false,
    required: ["focus"],
    properties: {
      focus: { type: "array", items: { type: "string", enum: ids }, minItems: 1, maxItems: Math.min(MAX_FOCUS, ids.length), uniqueItems: true },
      ...(result.causes.length > 0 ? { cause: { type: "string", enum: result.causes } } : {}),
    },
  };
}

export type Selection = { focus: string[]; cause?: CauseCode };

/** Parses and validates the model's raw reply. Anything but a strict, record-bound selection is refused. */
export function parseSelection(raw: string, result: PilotToolResult): { ok: true; selection: Selection } | { ok: false; code: "MODEL_SELECTION_INVALID" } {
  if (typeof raw !== "string" || raw.length === 0 || Buffer.byteLength(raw, "utf8") > MAX_SELECTION_BYTES) return { ok: false, code: "MODEL_SELECTION_INVALID" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "MODEL_SELECTION_INVALID" };
  }
  const parsed = selectionSchema(result).safeParse(value);
  return parsed.success ? { ok: true, selection: parsed.data as Selection } : { ok: false, code: "MODEL_SELECTION_INVALID" };
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
  "You help a person read records from a governed infrastructure pilot.",
  "Reply with JSON only, exactly this shape: {\"focus\": [fact ids], \"cause\": cause code}.",
  "focus: the one to five fact ids (F1, F2, …) from the FACTS list that best answer the person's question, most important first.",
  "cause: only if the question is about a failure or a blocker, one code from the CAUSES list; otherwise leave it out.",
  "Use no other keys and write no other text. Your reply is validated, and anything else is discarded.",
].join("\n");

/** A fixed state line tied to the record's verified state; the only place success wording appears. */
function recordState(result: PilotToolResult): string | undefined {
  if (!result.ok || !result.succeeded) return undefined;
  if (result.query === "PILOT_OBSERVED") return "Record state: the independent observation is VERIFIED (as recorded in the report, not re-verified now).";
  if (result.query === "PILOT_STATUS" || result.query === "PILOT_FAILURE") return "Record state: every lifecycle stage is PASS (as recorded in the report, not re-verified now).";
  return undefined;
}

/** The model's failure reason, by code only: an error message is never echoed (it could carry an address). */
function failureCode(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,}/.exec(text)?.[0] ?? "MODEL_UNAVAILABLE";
}

/** Answers one read-only pilot question: the record's facts, the local model's validated selection rendered by the product, and the person's next step. */
export async function answerPilotQuery(query: PilotQuery, request: string, options: PilotAnswerOptions = {}): Promise<{ response: string; result: PilotToolResult; selection?: Selection }> {
  const result = readPilotContext(query, { root: options.root, runId: options.runId ?? runIdFromRequest(request) });
  const facts = factsOf(result);
  const lines: string[] = [TITLES[query] + " — read-only" + (result.ok ? ", from " + result.source : ""), ...facts.map((fact) => fact.text)];
  const state = recordState(result);
  if (state) lines.push(state);

  let selection: Selection | undefined;
  if (options.explain) {
    const label = "Local model selection" + (options.modelName ? " (" + options.modelName + ")" : "");
    lines.push("");
    try {
      const raw = await options.explain([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [
          wrapUntrustedEvidence(JSON.stringify({ FACTS: facts, CAUSES: result.causes })),
          governedUserRequest(request),
        ].join("\n\n") },
      ], selectionJsonSchema(result));
      const parsed = parseSelection(raw, result);
      if (parsed.ok) {
        selection = parsed.selection;
        const byId = new Map(facts.map((fact) => [fact.id, fact.text]));
        lines.push(label + ": the facts that answer your question (quoted from the record; the model wrote none of this text):");
        for (const id of parsed.selection.focus) lines.push("  " + id + ". " + (byId.get(id) ?? "").trim());
        if (parsed.selection.cause) lines.push("  Cause (" + parsed.selection.cause + "): " + CAUSE_SENTENCES[parsed.selection.cause]);
      } else {
        lines.push(label + ": the model gave no usable selection (" + parsed.code + "). The facts above are the answer.");
      }
    } catch (error) {
      lines.push(label + " unavailable (" + failureCode(error) + "). The facts above are the answer; no other model or endpoint was tried.");
    }
  }

  lines.push("");
  lines.push("Your next step (a person runs it; this session never does): " + result.nextStep);
  lines.push("The model cannot approve, apply, clean up or change the pilot contract.");
  return { response: lines.join("\n"), result, ...(selection ? { selection } : {}) };
}

/** The default explainer: the configured PRIMARY model on the loopback model server. */
export function localModelExplainer(): { explain: PilotExplainer; modelName: string } {
  const cfg = loadConfig();
  return {
    modelName: cfg.primaryModel,
    explain: (messages, format) => invokeLocalModel(cfg.ollamaBaseUrl, cfg.primaryModel, messages, { format, think: false, timeoutMs: 60_000 }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests the model may never carry out. Each answer names who does it and the exact command or console step.

export type HandoffKind = "APPROVE" | "APPLY" | "CLEANUP" | "CONTRACT" | "HOSTED_INFERENCE";

const HOSTED = /\b(?:openai|chat ?gpt|gpt-?\d|anthropic|claude|gemini|bedrock|vertex ai|azure openai|mistral\.ai|hosted (?:model|inference|llm|ai)|cloud (?:model|llm|inference|ai)|remote (?:model|llm|inference)|api key for (?:a|the) model)\b/i;
const CONTRACT = /\b(?:edit|change|modify|update|write|rewrite|add|remove|delete|empty|clear|set|bypass|lift|disable|turn off)\b.{0,40}\b(?:pilot contract|act-pilot-contract|contract(?![-\w])|authori[sz]e (?:entry|list)|(?:pilot|act) authori[sz]ation|approver allow ?-?list|kill ?-?switch)\b|\b(?:enable|turn on|activate|unlock)\b.{0,20}\bact\b|\bauthori[sz]e\b.{0,30}\b(?:act|apply|cleanup|myself|me)\b/i;
/** The owner's pilot controls, named in any form ("flip the kill switch", "is the kill switch on?", "approval history please"). */
const PILOT_TERM = "(?:pilot|act|contract|apply|approv\\w*)";
const PILOT_AUTHORITY = new RegExp(
  "\\b(?:kill ?-?switch|approver allow ?-?list|pilot approvers?|who (?:are|is) the approvers?|approvals? (?:history|log|list|record|records|ledger|status(?! of (?:the |my |this )?(?:run|apply|pilot|cleanup|plan)\\b))" +
    "|approval ledger|authori[sz]e (?:entry|list)|pilot contract|act-pilot-contract|act (?:switch|toggle|flag)|(?:add|remove|put) me (?:to|on|from|off) the allow ?-?list)\\b" +
    // A bare "allowlist" or "approver" is a pilot control only beside a pilot word; "the ip allowlist in the design" is design work.
    "|\\b(?:allow ?-?list|approvers?)\\b.{0,30}\\b" + PILOT_TERM + "\\b|\\b" + PILOT_TERM + "\\b.{0,30}\\b(?:allow ?-?list|approvers?)\\b",
  "i",
);
/**
 * Deny by default for pilot authority: a request that leads with a change or ask verb and names an approval, the ledger,
 * the kill switch, an apply right or a signing key, or that switches ACT on or off. These only ever choose the refusal
 * text; they never admit a request the operator gate refuses (src/session/graph.ts).
 */
const ASK_LEAD = "^(?:(?:please|ok(?:ay)?|now|just|so|go ahead and|can you|could you|would you|will you|i want you to|i need you to|you should)[,\\s]+)*";
const AUTHORITY_CHANGE = new RegExp(ASK_LEAD +
  "(?:make|add|put|register|enroll|remove|drop|grant|give|assign|appoint|set|lower|raise|reduce|increase|change|skip|bypass|waive|override|let me|allow me|turn|switch|flip|toggle|reset|delete|edit|enable|disable|unlock)\\b" +
  ".{0,60}\\b(?:approv\\w*|ledger|kill ?-?switch|apply (?:rights?|permissions?|access|role)|signing key|requester key|(?:pilot|act) authori[sz]\\w*)\\b", "i");
const ACT_SWITCH = /\b(?:turn|switch|flip|toggle|set|put)\s+act\b|\bact\b(?: mode| switch)?\s+(?:on|off)\b(?=\s*(?:$|[.!?,;]|please\b|now\b|for\b|in\b|again\b))/i;
const VERB_LEAD = /^(?:please\s+|ok(?:ay)?,?\s+|now\s+|go ahead and\s+|just\s+)?/;
const ASK = /\b(?:can you|could you|would you|will you|please|go ahead and|i want you to|you should|you can|for me|yourself|on my behalf)\b/i;
const APPROVE = /\b(?:approve|sign|co-?sign|countersign)\b/i;
const CLEANUP = /\b(?:clean ?up|cleanup|destroy|tear ?down|teardown|(?:delete|remove) (?:the |all |every |what )?(?:resources|run|stack|environment|deployment|everything|it|them|(?:was|we|you) (?:built|created)))\b/i;
const APPLY = /\b(?:apply|execute|run the (?:plan|apply|change)|start the (?:apply|run|change)|push the change|make the change)\b|\b(?:deploy|provision) (?:it|this|that|the (?:plan|change|sealed plan))\b/i;

/** A request to act in the pilot (approve, apply, clean up, change the contract) or to reach hosted inference; undefined otherwise. */
export function pilotHandoffKind(request: string): HandoffKind | undefined {
  const value = request.trim().toLowerCase();
  if (HOSTED.test(value) && /\b(?:use|switch|fall ?back|send|route|call|ask|try|connect)\b/.test(value)) return "HOSTED_INFERENCE";
  // Anything about the owner's controls, read or write, gets the owner-authority answer: the session neither reads nor changes them.
  if (CONTRACT.test(value) || PILOT_AUTHORITY.test(value) || AUTHORITY_CHANGE.test(value) || ACT_SWITCH.test(value)) return "CONTRACT";
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
    "To read their current state yourself: ./alz apply preflight --environment DEV (authorization, approvers and the kill switch) and ./alz apply status --environment DEV (runs and approvals).",
    "I can show what the latest preparation says: ask \"am I ready to seal?\"",
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
