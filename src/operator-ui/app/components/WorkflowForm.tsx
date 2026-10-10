import type { OperatorMode } from "../api";

const WORKFLOW_OPTIONS: ReadonlyArray<{ value: OperatorMode; label: string }> = [
  {
    value: "matrix-offline",
    label: "Explore all existing landing-zone scenarios (offline)",
  },
  {
    value: "matrix-live",
    label: "Analyze scenarios with private Qwen / Mistral models",
  },
  {
    value: "aws-review",
    label: "Review the AWS brownfield Terraform proposal with private models",
  },
  {
    value: "chaos",
    label: "Check backup, recovery and Well-Architected fault handling",
  },
];

/**
 * The governed run form, unchanged in meaning from D1: four workflow modes,
 * the scenario select (available for matrix runs only), and the CSRF token
 * carried into the POST body from the server-injected carrier input. The
 * experience level is deliberately absent — validation is identical at every
 * level.
 */
export function WorkflowForm(props: {
  mode: OperatorMode;
  scenario: string;
  scenarioIds: readonly string[];
  running: boolean;
  onModeChange: (mode: OperatorMode) => void;
  onScenarioChange: (scenario: string) => void;
  onSubmit: () => void;
}) {
  const scenarioAvailable = props.mode === "matrix-offline" || props.mode === "matrix-live";
  return (
    <form
      id="run"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <label className="field-label" htmlFor="mode">
        What would you like to do?
      </label>
      <select
        id="mode"
        name="mode"
        value={props.mode}
        onChange={(event) => props.onModeChange(event.target.value as OperatorMode)}
      >
        {WORKFLOW_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="scenario">
        Environment and infrastructure approach
      </label>
      <select
        id="scenario"
        name="scenario"
        value={scenarioAvailable ? props.scenario : "all"}
        disabled={!scenarioAvailable}
        onChange={(event) => props.onScenarioChange(event.target.value)}
      >
        <option value="all">All supported scenarios</option>
        {props.scenarioIds.map((id) => (
          <option key={id} value={id}>
            {id.replaceAll("-", " ")}
          </option>
        ))}
      </select>
      <p>
        <small>
          Live-model choices require installed models on this machine. AWS evidence is synthetic.
          Terraform plans and infrastructure ACT are not available from this workspace.
        </small>
      </p>
      <button type="submit" id="start" disabled={props.running}>
        Run selected workflow
      </button>
    </form>
  );
}
