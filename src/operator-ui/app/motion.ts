/**
 * Motion helpers for run feedback (UX depth pass).
 *
 * Presentation-only: these decide HOW the console moves — smooth versus
 * instant scrolling — never what it shows or what the server is asked. When
 * the operator asks for reduced motion, or the environment cannot report a
 * preference, scrolling falls back to an instant jump so nothing animates
 * uninvited. The pure decision is split from the DOM effect so tests can
 * assert the reduced-motion contract without a browser.
 */
export type ScrollMotion = "smooth" | "auto";

/** Pure decision: reduced motion never gets smooth scrolling. */
export function scrollBehaviorFor(prefersReducedMotion: boolean): ScrollMotion {
  return prefersReducedMotion ? "auto" : "smooth";
}

/**
 * Read the operator's motion preference. Unknown environments (SSG render,
 * blocked matchMedia) count as reduced — the safe default is "don't animate".
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/**
 * Scroll an element into view, degraded safely: engines without
 * scrollIntoView (some test DOMs) skip silently — run feedback chrome must
 * never gate the run itself.
 */
export function scrollIntoViewSafe(element: HTMLElement | null, behavior: ScrollMotion): void {
  if (element && typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ behavior, block: "start" });
  }
}
