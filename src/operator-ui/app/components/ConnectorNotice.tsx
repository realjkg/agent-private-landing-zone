/**
 * The single honest Beginner notice about cloud connectors (spec mode
 * matrix, D2 row): one plain sentence, no connector identifiers, no
 * gallery. This component renders only at BEGINNER, keeping the D1
 * ceiling literal — the connector inventory never enters the tree here.
 */
export function ConnectorNotice() {
  return (
    <section className="panel beginner-only" aria-label="Cloud connectors">
      <h2>Cloud connectors</h2>
      <p className="beginner-proof">
        Cloud connectors in this preview are simulated; no external connection is made.
      </p>
    </section>
  );
}
