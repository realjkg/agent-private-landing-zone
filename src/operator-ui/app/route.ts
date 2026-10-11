import { useEffect, useState } from "react";

/**
 * The console's three areas, addressed by hash so the back button, bookmarks
 * and the in-page links the cards already use (`#evidence`) keep working. The
 * hash selects what is shown; it never carries data and the server never sees it.
 */
export type View = "home" | "operations" | "reference";

export type Route = {
  view: View;
  /** Element id to scroll to inside the view, when the hash names one. */
  anchor: string | null;
  /** The operator moved here (not the first paint), so focus may follow. */
  navigated: boolean;
};

const VIEW_OF_HASH: Readonly<Record<string, View | "current">> = {
  home: "home",
  workflow: "home",
  operations: "operations",
  reference: "reference",
  connectors: "reference",
  compliance: "reference",
  // The evidence panel sits in Home and under Operations: stay where the operator is.
  evidence: "current",
};

const ANCHORED = new Set(["workflow", "evidence", "connectors", "compliance"]);

/** Pure: unknown hashes land on Home, so a stale link never shows a blank page. */
export function parseRoute(hash: string, current: View, navigated: boolean): Route {
  const name = hash.replace(/^#\/?/, "");
  const target = VIEW_OF_HASH[name] ?? "home";
  return {
    view: target === "current" ? current : target,
    anchor: ANCHORED.has(name) ? name : null,
    navigated,
  };
}

const currentHash = () => (typeof window === "undefined" ? "" : window.location.hash);

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(currentHash(), "home", false));
  useEffect(() => {
    const onChange = () => setRoute((previous) => parseRoute(currentHash(), previous.view, true));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
