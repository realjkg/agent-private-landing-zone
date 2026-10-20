import { createHash } from "node:crypto";

/**
 * Deterministic context budgeting for private ALZ sub-agents.
 * No network calls, model calls or persistence. Estimates are conservative,
 * never advertised as an exact tokenizer measurement.
 */
export type ContextKind = "REQUEST" | "POLICY" | "APPROVAL" | "IAC_PLAN" | "EVIDENCE" | "NARRATIVE" | "LOG";
export type ContextPart = {
  id: string;
  kind: ContextKind;
  text: string;
  priority: number;
  required?: boolean;
};
export type EvidenceReference = { id: string; sha256: string; bytes: number; kind: ContextKind };
export type PackedContext = {
  text: string;
  selected: string[];
  omitted: EvidenceReference[];
  estimateTokens: number;
  budgetTokens: number;
  utilization: number;
  requiresFullEvidenceReview: boolean;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTROL: ReadonlySet<ContextKind> = new Set(["REQUEST", "POLICY", "APPROVAL", "IAC_PLAN"]);
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** Simple conservative UTF-8 estimate, not a tokenizer. */
export const estimateTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 3);

export function chunkText(text: string, maxTokens = 768, overlapTokens = 96): string[] {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 16 ||
    !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens)
    throw new Error("CONTEXT_CHUNK_BUDGET_INVALID");
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks: string[] = [];
  let current = "";
  const maxBytes = maxTokens * 3;
  const overlapBytes = overlapTokens * 3;
  for (const word of words) {
    if (Buffer.byteLength(word, "utf8") > maxBytes)
      throw new Error("CONTEXT_OVERSIZED_UNIT: split source at a reviewed semantic boundary");
    if (Buffer.byteLength(current + word, "utf8") > maxBytes && current) {
      chunks.push(current);
      // Retain trailing whole words, never slice through a character.
      const trailing = current.match(/\S+\s*/g) ?? [];
      let suffix = "";
      for (let i = trailing.length - 1; i >= 0; i--) {
        if (Buffer.byteLength(trailing[i] + suffix, "utf8") > overlapBytes) break;
        suffix = trailing[i] + suffix;
      }
      current = Buffer.byteLength(suffix + word, "utf8") <= maxBytes ? suffix : "";
    }
    current += word;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function packContext(parts: readonly ContextPart[], windowTokens: number, fraction = 0.65): PackedContext {
  if (!Number.isSafeInteger(windowTokens) || windowTokens < 128 || !Number.isFinite(fraction) || fraction <= 0 || fraction > 0.8)
    throw new Error("CONTEXT_WINDOW_INVALID");
  const budgetTokens = Math.floor(windowTokens * fraction);
  const seen = new Set<string>();
  for (const part of parts) {
    if (!ID.test(part.id) || seen.has(part.id) || !Number.isFinite(part.priority) ||
      !Number.isSafeInteger(part.priority) || part.priority < 0 || typeof part.text !== "string")
      throw new Error("CONTEXT_PART_INVALID");
    seen.add(part.id);
  }
  const ordered = [...parts].sort((a,b) => Number(Boolean(b.required || CONTROL.has(b.kind))) -
      Number(Boolean(a.required || CONTROL.has(a.kind))) || b.priority - a.priority || a.id.localeCompare(b.id));
  const selected: string[] = [];
  const omitted: EvidenceReference[] = [];
  const segments: string[] = [];
  let bytes = 0;
  for (const part of ordered) {
    const header = "[" + part.kind + ":" + part.id + "]\n";
    const segment = header + part.text + "\n";
    const cost = Buffer.byteLength(segment, "utf8");
    if (Math.ceil((bytes + cost) / 3) > budgetTokens) {
      if (part.required || CONTROL.has(part.kind))
        throw new Error("CONTEXT_REQUIRED_EVIDENCE_EXCEEDS_BUDGET:" + part.id);
      omitted.push({ id:part.id,kind:part.kind,sha256:sha256(part.text),bytes:Buffer.byteLength(part.text,"utf8") });
      continue;
    }
    segments.push(segment);
    bytes += cost;
    selected.push(part.id);
  }
  const estimate = Math.ceil(bytes / 3);
  return {
    text:segments.join("\n"), selected, omitted, estimateTokens:estimate,budgetTokens,
    utilization: estimate / budgetTokens,
    // An omitted narrative or log is not safe evidence for release approval.
    requiresFullEvidenceReview: omitted.length > 0,
  };
}

/** Handoffs transmit references and required facts, never raw secrets or signed evidence truncations. */
export function handoffContext(packed: PackedContext): {
  summary: string; evidenceRefs: EvidenceReference[]; complete: boolean;
} {
  const refs = packed.omitted.map(x => ({ ...x }));
  const summary = "Context selected: " + packed.selected.join(", ") +
    ". Omitted evidence references: " + refs.map(x=>x.id + "@sha256:" + x.sha256).join(", ") +
    ". Original evidence must be reloaded and independently validated before authorization.";
  return { summary, evidenceRefs:refs, complete: !packed.requiresFullEvidenceReview };
}
