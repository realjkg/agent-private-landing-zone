/**
 * Experience levels for the local operator console.
 *
 * Presentation-only by contract (docs/architecture.md §Customer experience):
 * a level changes what the operator is shown, never what they are allowed to
 * do. Nothing server-side may branch on this value — it is chosen, stored, and
 * applied entirely in the browser. Policy authority remains with
 * policy/opa/security.rego; workflow validation remains with the server's
 * existing OperatorMode checks.
 */
export const EXPERIENCE_LEVELS = ["BEGINNER", "ADVANCED", "EXPERT"] as const;

export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const DEFAULT_EXPERIENCE_LEVEL: ExperienceLevel = "BEGINNER";

/** Storage key for the per-operator level preference (client-side only). */
export const EXPERIENCE_LEVEL_STORAGE_KEY = "alz.experienceLevel";

/**
 * Coerce any stored or supplied value into a valid level. Unknown values fall
 * back to Beginner without error so a stale or tampered localStorage entry can
 * never break the console or escalate disclosure.
 */
export function parseExperienceLevel(value: unknown): ExperienceLevel {
  return EXPERIENCE_LEVELS.includes(value as ExperienceLevel)
    ? (value as ExperienceLevel)
    : DEFAULT_EXPERIENCE_LEVEL;
}

/**
 * Plain-language beginner rendering of a workflow's evidence classification.
 * Translates, it does not hide: every known classification maps to an honest
 * sentence, and unknown classifications fall back to the raw string so no
 * evidence basis is ever silently dropped.
 */
export const BEGINNER_EVIDENCE_LINES: Readonly<Record<string, string>> = {
  "NOT_RUN": "Choose a workflow to see how this workspace protects you.",
  "DETERMINISTIC FIXTURE — NO LOCAL MODEL INFERENCE OR LIVE CLOUD":
    "Protected — this run used recorded examples; no real cloud was touched.",
  "SYNTHETIC FAULT INJECTION — no real restore or cloud mutation":
    "Protected — this check simulated faults safely; nothing real was changed.",
  "REAL LOCAL QWEN/MISTRAL — SYNTHETIC AWS INVENTORY — NO TERRAFORM PLAN":
    "Uses private models on this machine against example data; no cloud changes.",
  "REAL LOCAL QWEN/MISTRAL REASONING — SYNTHETIC IaC FIXTURE PREVIEWS":
    "Uses private models on this machine reviewing example plans; no cloud changes.",
};

export function beginnerEvidenceLine(evidenceBasis: string): string {
  return BEGINNER_EVIDENCE_LINES[evidenceBasis] ?? evidenceBasis;
}
