import { useEffect } from "react";

import { prefersReducedMotion, scrollBehaviorFor, scrollIntoViewSafe } from "../motion";
import type { Route } from "../route";

/**
 * Renders nothing; once its siblings are on screen it moves the operator to
 * the right place. Placed inside a Suspense boundary beside a lazy view, it
 * only runs after that view has loaded. An anchor scrolls to its section; a
 * plain view change returns to the top and, when the operator navigated,
 * moves focus to the view's heading so keyboard and screen reader users land
 * on the new content instead of the link they pressed.
 */
export function Arrive(props: { route: Route; titleId: string }) {
  const { route, titleId } = props;
  useEffect(() => {
    const title = document.getElementById(titleId);
    const target = route.anchor ? document.getElementById(route.anchor) : null;
    if (target) {
      scrollIntoViewSafe(target, scrollBehaviorFor(prefersReducedMotion()));
    } else if (route.navigated && typeof window.scrollTo === "function") {
      window.scrollTo(0, 0);
    }
    if (route.navigated) title?.focus({ preventScroll: true });
  }, [route, titleId]);
  return null;
}
