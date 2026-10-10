import {
  DEFAULT_EXPERIENCE_LEVEL,
  EXPERIENCE_LEVEL_STORAGE_KEY,
  parseExperienceLevel,
  type ExperienceLevel,
} from "../experience-level.js";

/**
 * Client-side level persistence. Storage failures (private mode, blocked
 * storage) degrade to a session-local level; unknown or tampered values fall
 * back to Beginner through the shared parser. The level never leaves the
 * browser — nothing here touches the network.
 */
export function readStoredLevel(): ExperienceLevel {
  if (typeof window === "undefined") return DEFAULT_EXPERIENCE_LEVEL;
  try {
    return parseExperienceLevel(window.localStorage.getItem(EXPERIENCE_LEVEL_STORAGE_KEY));
  } catch {
    return DEFAULT_EXPERIENCE_LEVEL;
  }
}

export function storeLevel(level: ExperienceLevel): void {
  try {
    window.localStorage.setItem(EXPERIENCE_LEVEL_STORAGE_KEY, level);
  } catch {
    // Storage unavailable — the level remains session-local. Presentation
    // only; nothing may fail the console over a preference.
  }
}
