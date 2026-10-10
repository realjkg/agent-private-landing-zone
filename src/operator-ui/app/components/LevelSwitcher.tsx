import { EXPERIENCE_LEVEL_STORAGE_KEY, type ExperienceLevel } from "../../experience-level.js";

const LEVEL_LABELS: Record<ExperienceLevel, string> = {
  BEGINNER: "Beginner",
  ADVANCED: "Advanced",
  EXPERT: "Expert",
};

/**
 * The arcade difficulty select. Words and behavior are the contract from D1:
 * three levels, aria-pressed state, per-operator persistence under
 * alz.experienceLevel. Arcade chrome is styling only.
 */
export function LevelSwitcher(props: {
  level: ExperienceLevel;
  onSelect: (next: ExperienceLevel) => void;
}) {
  return (
    <nav
      className="levels"
      role="group"
      aria-label="Experience level"
      data-storage-key={EXPERIENCE_LEVEL_STORAGE_KEY}
    >
      {(Object.keys(LEVEL_LABELS) as ExperienceLevel[]).map((candidate) => (
        <button
          key={candidate}
          type="button"
          data-level={candidate}
          aria-pressed={candidate === props.level}
          onClick={() => props.onSelect(candidate)}
        >
          <span className="levels-led" aria-hidden="true" />
          {LEVEL_LABELS[candidate]}
        </button>
      ))}
    </nav>
  );
}
