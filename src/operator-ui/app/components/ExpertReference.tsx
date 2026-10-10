const CLI_EQUIVALENTS: ReadonlyArray<{ command: string; mode: string }> = [
  { command: "npx tsx src/cli/private-agent-matrix.ts --offline-fixture", mode: "matrix-offline" },
  { command: "npx tsx src/cli/private-agent-matrix.ts --live-models", mode: "matrix-live" },
  { command: "npx tsx src/cli/qualify-aws-terraform-agent.ts --live-models", mode: "aws-review" },
  { command: "npx tsx src/cli/chaos-pillars.ts", mode: "chaos" },
];

/** Expert reference: the CLI equivalents of each workflow, plus scenario ids. */
export function ExpertReference(props: { scenarioIds: readonly string[] }) {
  return (
    <section className="panel expert-only" aria-label="Expert reference">
      <h2>Expert reference</h2>
      <p>
        <small>Equivalent CLI commands, run from the repository root:</small>
      </p>
      <ul>
        {CLI_EQUIVALENTS.map((item) => (
          <li key={item.mode}>
            <code>{item.command}</code> — {item.mode}
          </li>
        ))}
      </ul>
      <p>
        <small>Scenario ids: {props.scenarioIds.join(", ")}</small>
      </p>
    </section>
  );
}
