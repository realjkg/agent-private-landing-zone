import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  spawnSync,
} from "node:child_process";
import test from "node:test";
import {
  resolve,
} from "node:path";

const root =
  process.cwd();
const alz =
  resolve(
    root,
    "alz",
  );

function run(
  args: string[],
) {
  return spawnSync(
    alz,
    args,
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
    },
  );
}

test("operator help exposes the complete supported surface and ACT boundary", () => {
  const result =
    run(["help"]);

  assert.equal(
    result.status,
    0,
  );

  const output =
    result.stdout;

  for (const command of [
    "./alz bootstrap",
    "./alz demo",
    "./alz design",
    "./alz inspect",
    "./alz session",
    "./alz target init",
    "./alz target check",
    "./alz target explain",
    "./alz recovery status",
    "./alz recovery test",
    "./alz doctor",
    "./alz verify",
    "./alz plugins",
    "./alz prompts",
    "./alz models list",
    "./alz models verify",
    "./alz sbom",
    "./alz scan",
  ]) {
    assert.equal(
      output.includes(command),
      true,
      "missing help command: " +
        command,
    );
  }

  assert.match(
    output,
    /ACT remains disabled/i,
  );
});

test("target init uses seven answers and produces a checkable intent without infrastructure changes", () => {
  const targetId =
    "operator-smoke-" +
    process.pid;
  const path =
    resolve(
      root,
      "config",
      "recovery-intents",
      targetId + ".json",
    );

  try {
    const created =
      run([
        "target",
        "init",
        targetId,
        "platform-operations",
        "aws",
        "123456789012",
        "startup",
        "development",
        "non-critical",
      ]);

    assert.equal(
      created.status,
      0,
    );
    assert.match(
      created.stdout,
      /No infrastructure changes were made/i,
    );
    assert.equal(
      existsSync(path),
      true,
    );

    const intent =
      JSON.parse(
        readFileSync(
          path,
          "utf8",
        ),
      ) as {
        targetId: string;
        environment: string;
      };

    assert.equal(
      intent.targetId,
      targetId,
    );
    assert.equal(
      intent.environment,
      "DEVELOPMENT",
    );

    const checked =
      run([
        "target",
        "check",
        "config/recovery-intents/" +
          targetId +
          ".json",
      ]);

    assert.equal(
      checked.status,
      0,
    );
    assert.match(
      checked.stdout,
      /Target intent is valid/i,
    );

    const explained =
      run([
        "target",
        "explain",
        "config/recovery-intents/" +
          targetId +
          ".json",
      ]);

    assert.equal(
      explained.status,
      0,
    );
    assert.match(
      explained.stdout,
      /Production data is prohibited/i,
    );
  } finally {
    rmSync(
      path,
      {
        force: true,
      },
    );
  }
});

test("missing recovery input fails with actionable non-mutating output", () => {
  const result =
    run([
      "recovery",
      "status",
      "config/not-present.json",
    ]);

  assert.equal(
    result.status,
    1,
  );
  assert.match(
    result.stderr,
    /Problem:/,
  );
  assert.match(
    result.stderr,
    /Recommended fix:/,
  );
  assert.match(
    result.stderr,
    /Safe alternative:/,
  );
  assert.match(
    result.stderr,
    /No infrastructure changes were made/i,
  );
});

test("recovery status is inspectable while blocked recovery test returns a failing process status", () => {
  const status =
    run([
      "recovery",
      "status",
      "config/recovery-targets.example.json",
    ]);

  assert.equal(
    status.status,
    0,
  );
  assert.match(
    status.stdout,
    /aws-platform-primary/i,
  );
  assert.match(
    status.stdout,
    /No infrastructure changes were made/i,
  );

  const readiness =
    run([
      "recovery",
      "test",
      "config/recovery-targets.example.json",
    ]);

  assert.equal(
    readiness.status,
    1,
  );
  assert.match(
    readiness.stdout,
    /BLOCKED/i,
  );
  assert.match(
    readiness.stdout,
    /No infrastructure changes were made/i,
  );
});


test("operator exposes a bounded read-only economics report", () => {
  const help = run(["help"]);
  assert.match(help.stdout, /alz economics report/);
  const result = run(["economics", "report", "config/economics.example.json", "--json"]);
  assert.equal(result.status, 0, result.stderr);

  // The economics command now also emits schema-v1 operational events on
  // stdout (compact single-line JSON each) before the pretty-printed report
  // document. Parse the event stream, then the report that follows it.
  const lines = result.stdout.split("\n");
  const eventLines = lines
    .filter((line) => line.startsWith('{"schemaVersion"'))
    .map((line) => JSON.parse(line) as { schemaVersion: number; signal: string; status: string });
  assert.ok(eventLines.length > 0, "expected operational event lines on stdout");
  for (const event of eventLines) {
    assert.equal(event.schemaVersion, 1);
    assert.equal(typeof event.signal, "string");
    assert.equal(typeof event.status, "string");
  }

  const reportStart = lines.findIndex((line) => line === "{");
  assert.ok(reportStart !== -1, "expected a pretty-printed report document");
  const parsed = JSON.parse(lines.slice(reportStart).join("\n")) as { advisoryOnly: boolean; months: { totalCents: number }[]; alerts: unknown[] };
  assert.equal(parsed.advisoryOnly, true);
  assert.equal(parsed.months.at(-1)?.totalCents, 160000);
  assert.equal(parsed.alerts.length, 2);
});
