/**
 * Client-side persistence for the one-time beginner protection card (UX
 * depth pass). Mirrors level-storage: storage failures (private mode,
 * blocked storage) degrade gracefully — the card simply reappears next
 * session instead of breaking the console. Nothing here touches network or
 * server state; dismissal is a presentation preference only.
 */
export const PROTECTION_CARD_STORAGE_KEY = "alz.protectionCardDismissed";

export function readProtectionDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PROTECTION_CARD_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeProtectionDismissed(): void {
  try {
    window.localStorage.setItem(PROTECTION_CARD_STORAGE_KEY, "1");
  } catch {
    // Storage unavailable — the card remains session-local, like the level
    // preference. Presentation only; nothing may fail the console over it.
  }
}
