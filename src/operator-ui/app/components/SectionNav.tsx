import { SummaryStrip } from "./SummaryStrip";

const TABS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "#workflow", label: "Workflow" },
  { href: "#evidence", label: "Evidence" },
  { href: "#connectors", label: "Connectors" },
  { href: "#compliance", label: "Compliance" },
];

/**
 * Sticky in-page section nav for the long Advanced/Expert page (UX depth
 * pass): arcade-styled anchor tabs over an at-a-glance summary strip.
 *
 * Presentation-only navigation — the tabs jump to page sections and change
 * nothing else. Rendered only at Advanced and Expert; Beginner keeps its
 * short single-path page and its DOM ceiling.
 */
export function SectionNav() {
  return (
    <div className="section-nav-region advanced-only">
      <nav className="section-nav" aria-label="Page sections">
        {TABS.map((tab) => (
          <a className="section-tab" href={tab.href} key={tab.href}>
            {tab.label}
          </a>
        ))}
      </nav>
      <SummaryStrip />
    </div>
  );
}
