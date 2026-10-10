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
 *
 * The scroll starts on the next animation frame, not inside the caller's
 * task. Observed in Chromium: a smooth scroll requested synchronously from
 * the activating click of "Run selected workflow" never moved the page,
 * while the same request one frame later did. Reduced-motion ("auto") jumps
 * were unaffected either way.
 */
export function scrollIntoViewSafe(element: HTMLElement | null, behavior: ScrollMotion): void {
  if (!element || typeof element.scrollIntoView !== "function") return;
  const scroll = () => element.scrollIntoView({ behavior, block: "start" });
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(scroll);
  } else {
    scroll();
  }
}
