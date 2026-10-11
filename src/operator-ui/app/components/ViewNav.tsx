import type { ExperienceLevel } from "../../experience-level.js";
import type { View } from "../route";

const TABS: ReadonlyArray<{ view: View; href: string; label: string; beginner: boolean }> = [
  { view: "home", href: "#home", label: "Home", beginner: true },
  { view: "operations", href: "#operations", label: "Operations", beginner: true },
  { view: "reference", href: "#reference", label: "Reference", beginner: false },
];

/**
 * Primary navigation between the console's areas. Plain links: the browser
 * handles history and keyboard use, and `aria-current` names the open area.
 * Reference (connectors and compliance detail) starts at Advanced, so at
 * Beginner the tab does not exist. Presentation only — it changes what is
 * shown and nothing the server is asked.
 */
export function ViewNav(props: { level: ExperienceLevel; view: View }) {
  return (
    <nav className="view-nav" aria-label="Console areas">
      {TABS.filter((tab) => tab.beginner || props.level !== "BEGINNER").map((tab) => (
        <a className="view-tab" href={tab.href} key={tab.view}
          aria-current={tab.view === props.view ? "page" : undefined}>
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
