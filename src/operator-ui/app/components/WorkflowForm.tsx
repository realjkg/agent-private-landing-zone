import type { ModelAvailability, OperatorMode } from "../api";

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

/** Workflows that need private Qwen/Mistral models installed on this machine. */
export const PRIVATE_MODEL_MODES: ReadonlySet<OperatorMode> = new Set(["matrix-live", "aws-review"]);

/**
 * Why the private-model workflows are off, in plain words, with the next
 * step. Only the server's literal reason drives the sentence; model names
 * come from the server's configured list, never guessed here.
 */
function unavailableNote(availability: ModelAvailability): string {
  const models = availability.required.join(", ");
  switch (availability.reason) {
    case "NO_LOCAL_MODEL_SERVER":
      return "Private-model workflows are off: no local model server answered on this " +
        "machine. Start Ollama with " + models + " installed, then check again.";
    case "MODELS_NOT_INSTALLED":
      return "Private-model workflows are off: these local models are not installed — " +
        availability.missing.join(", ") + ". Pull them with Ollama, then check again.";
    case "MODEL_INVENTORY_UNAVAILABLE":
      return "Private-model workflows are off: the local model server did not return " +
        "its model list. Check Ollama, then check again.";
    case "MODEL_ENDPOINT_NOT_LOOPBACK":
      return "Private-model workflows are off: OLLAMA_BASE_URL must be an http address " +
        "on this machine (localhost or 127.0.0.1).";
    case "LIVE_MODELS_DISABLED":
      return "Private-model workflows are off: AGENT_SKIP_LOCAL_MODEL=1 disables live " +
        "models for this session.";
    default:
      return "Private-model workflows are off on this machine.";
  }
}

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
  /** Null when unknown: private-model workflows stay offered, as before. */
  modelAvailability?: ModelAvailability | null;
  onRecheckModels?: () => void;
  onModeChange: (mode: OperatorMode) => void;
  onScenarioChange: (scenario: string) => void;
  onSubmit: () => void;
}) {
  const scenarioAvailable = props.mode === "matrix-offline" || props.mode === "matrix-live";
  const modelsUnavailable = props.modelAvailability?.status === "UNAVAILABLE";
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
        {WORKFLOW_OPTIONS.map((option) => {
          const off = modelsUnavailable && PRIVATE_MODEL_MODES.has(option.value);
          return (
            <option key={option.value} value={option.value} disabled={off}>
              {off ? option.label + " (needs local models)" : option.label}
            </option>
          );
        })}
      </select>
      {modelsUnavailable && props.modelAvailability && (
        <p className="model-note" data-testid="model-note" role="note">
          {unavailableNote(props.modelAvailability)}{" "}
          {props.onRecheckModels && (
            <button type="button" className="link-button" onClick={props.onRecheckModels}>
              Check again
            </button>
          )}
        </p>
      )}
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
      <button
        type="submit"
        id="start"
        disabled={props.running}
        aria-busy={props.running}
        data-running={props.running ? "true" : undefined}
      >
        {props.running ? "Running…" : "Run selected workflow"}
      </button>
    </form>
  );
}
