import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { createLocalOperatorServer } from "../src/operator-ui/server.js";
import { DOC_PATH, renderDoc } from "../src/operations/docs.js";
import { groupHelpLines, resolveGroupCommand } from "../src/operations/groups.js";
import { OPERATIONS, operationGroups } from "../src/operations/registry.js";
import { describeOperation, fillCommand, validateCatalog, validateInputs } from "../src/operations/schema.js";
import type { Field, OperationSpec } from "../src/operations/types.js";

const fields: Field[] = [
  { kind: "enum", name: "provider", label: "Provider", options: ["aws", "azure"] },
  { kind: "text", name: "target", label: "Target", pattern: "[a-z][a-z0-9-]*", maxLength: 12, example: "core-net" },
  { kind: "text", name: "note", label: "Note", pattern: ".*", maxLength: 20, example: "x", optional: true },
  { kind: "flag", name: "verbose", label: "Verbose" },
  { kind: "json", name: "report", label: "Report", maxBytes: 64, optional: true },
];

const refusal = (raw: unknown, schema: readonly Field[] = fields): string => {
  const result = validateInputs(schema, raw);
  assert.equal(result.ok, false, JSON.stringify(raw));
  return result.ok ? "" : result.error;
};

test("inputs: defaults apply, and every refusal is a stable code that never echoes the value", () => {
  const ok = validateInputs(fields, { target: "core-net" });
  assert.deepEqual(ok.ok && ok.values, { provider: "aws", target: "core-net", verbose: false });
  assert.equal(refusal({}), "INPUT_REQUIRED:target");
  assert.equal(refusal({ target: "core-net", extra: 1 }), "INPUT_UNKNOWN_FIELD");
  assert.equal(refusal({ target: "core-net", provider: "gcp" }), "INPUT_ENUM:provider");
  assert.equal(refusal({ target: "a".repeat(13) }), "INPUT_TOO_LONG:target");
  assert.equal(refusal({ target: "Core" }), "INPUT_PATTERN:target");
  assert.equal(refusal({ target: 5 }), "INPUT_TYPE:target");
  assert.equal(refusal({ target: "core-net", verbose: "yes" }), "INPUT_TYPE:verbose");
  assert.equal(refusal({ target: "core-net", provider: 1 }), "INPUT_TYPE:provider");
  assert.equal(refusal({ target: "core-net", report: "x".repeat(65) }), "INPUT_TOO_LARGE:report");
  assert.equal(refusal({ target: "core-net", report: "{nope" }), "INPUT_JSON_INVALID:report");
  assert.equal(refusal({ target: "core-net", report: 1 }), "INPUT_TYPE:report");
  assert.equal(refusal([]), "INPUTS_NOT_OBJECT");
  assert.equal(refusal("text"), "INPUTS_NOT_OBJECT");
  // Control characters and a leading dash can never reach an argument list.
  assert.equal(refusal({ target: "core-net", note: "a\nb" }), "INPUT_CHARACTERS:note");
  assert.equal(refusal({ target: "core-net", note: "--destroy" }), "INPUT_CHARACTERS:note");
  // __proto__ arrives as an own key from JSON.parse and is an unknown field.
  assert.equal(refusal(JSON.parse('{"target":"core-net","__proto__":{"x":1}}')), "INPUT_UNKNOWN_FIELD");
  const withJson = validateInputs(fields, { target: "core-net", report: '{"a":1}' });
  assert.equal(withJson.ok && withJson.values.report, '{"a":1}');
});

test("handoff commands are filled from validated values and shell-quoted", () => {
  const checked = validateInputs(fields, { target: "core-net", verbose: true, note: "it's here" });
  assert.ok(checked.ok);
  assert.equal(fillCommand("./alz x {provider} {target} {verbose} {note}", fields, checked.values),
    "./alz x aws core-net --verbose 'it'\\''s here'");
  const quiet = validateInputs(fields, { target: "core-net" });
  assert.ok(quiet.ok);
  assert.equal(fillCommand("./alz x {target} {verbose}", fields, quiet.values), "./alz x core-net");
});

const base: OperationSpec = {
  id: "demo-read", title: "Demo", summary: "Reads a demo.", family: "evidence", cli: "./alz demo-read",
  safety: "READ_ONLY", inputs: [], evidenceBasis: "FIXTURE", job: { script: "cli/demo.js", args: () => [] },
};
const handoff: OperationSpec = {
  ...base, id: "demo-hand", safety: "HANDOFF", job: undefined,
  handoff: { reason: "Needs a terminal.", command: "./alz demo-hand {target}", env: ["AWS_PROFILE"] },
  inputs: [fields[1]],
};

test("the catalog validator refuses each malformed entry", () => {
  assert.deepEqual(validateCatalog([base, handoff]), []);
  const problems = (spec: Partial<OperationSpec>, extra: OperationSpec[] = []) =>
    validateCatalog([{ ...base, ...spec }, ...extra]).join(" | ");
  assert.match(problems({ id: "Bad Id" }), /bad id/);
  assert.match(problems({}, [base]), /duplicate id/);
  assert.match(problems({ job: undefined }), /needs a job/);
  assert.match(problems({ handoff: handoff.handoff }), /only a HANDOFF/);
  assert.match(validateCatalog([{ ...handoff, job: base.job }]).join(), /must not have a job/);
  assert.match(problems({ cli: "rm -rf /" }), /cli must start/);
  assert.match(problems({ job: { script: "../x.js", args: () => [] } }), /job script/);
  assert.match(problems({ summary: "" }), /summary/);
  assert.match(problems({ inputs: [{ ...fields[1], example: "NOPE" }] }), /example does not satisfy/);
  assert.match(problems({ inputs: [{ ...fields[4], maxBytes: 10_000_000 } as Field] }), /maxBytes/);
  assert.match(problems({ inputs: [{ ...fields[1], maxLength: 5000 }] }), /maxLength/);
  assert.match(problems({ command: { group: "x", sub: "y" } }), /needs a cliScript/);
  assert.match(problems({ command: { group: "x", sub: "list" }, cliScript: "src/cli/a.ts" }), /bad command/);
  assert.match(problems({ job: { script: "cli/demo.js", args: () => ["--auto-approve"] } }), /forbidden word/);
  assert.match(problems({ job: { script: "cli/demo.js", args: () => ["terraform", "apply"] } }), /forbidden word/);
  assert.match(validateCatalog([{ ...handoff, handoff: { ...handoff.handoff!, command: "x {report}" },
    inputs: [fields[4]] }]).join(), /placeholder/);
  assert.match(validateCatalog([base, { ...handoff, handoff: { ...handoff.handoff!, viewer: "demo-hand" } }]).join(),
    /viewer must be a READ_ONLY/);
});

test("the real catalog is valid, and its public descriptors expose no script, path or builder", () => {
  assert.deepEqual(validateCatalog(OPERATIONS), []);
  const text = JSON.stringify(OPERATIONS.map(describeOperation));
  assert.doesNotMatch(text, /dist\/|"script"|"args"|"job"|"cliScript"|"npm"|"command":\{/);
  for (const spec of OPERATIONS) if (spec.job) assert.ok(!text.includes(spec.job.script), spec.id);
  assert.ok(OPERATIONS.find((spec) => spec.id === "matrix-offline"));
});

test("command groups list subcommands and resolve to the cliScript", () => {
  const group: OperationSpec = { ...base, id: "ent-one", family: "enterprise", cli: "./alz enterprise one",
    cliScript: "src/cli/health.ts", command: { group: "enterprise", sub: "one" } };
  assert.deepEqual(validateCatalog([group]), []);
  const second: OperationSpec = { ...group, id: "ent-two", cli: "./alz enterprise two",
    command: { group: "enterprise", sub: "two" }, summary: "Second." };
  const catalog = [group, second, base];
  assert.equal(resolveGroupCommand("no-such-group", [], catalog), null);
  assert.equal(resolveGroupCommand("demo-read", [], catalog), null);
  assert.deepEqual(groupHelpLines(catalog), ["  ./alz enterprise [list|<subcommand>] [args]  Enterprise libraries (2)"]);
  const listed = resolveGroupCommand("enterprise", ["list"], catalog);
  assert.deepEqual(listed, resolveGroupCommand("enterprise", [], catalog));
  assert.equal(listed?.kind, "list");
  assert.match(listed?.kind === "list" ? listed.lines.join("\n") : "", /enterprise one {2}Reads a demo\. \[READ_ONLY\]/);
  assert.equal(resolveGroupCommand("enterprise", ["three"], catalog)?.kind, "unknown-subcommand");
  assert.deepEqual(resolveGroupCommand("enterprise", ["two", "--flag"], catalog),
    { kind: "run", script: "src/cli/health.ts", args: ["--flag"] });
  // A legacy command word is never a group, so a catalog entry cannot shadow a legacy branch.
  assert.equal(operationGroups().has("target"), false);
});

// --- Server -------------------------------------------------------------

const testCatalog: OperationSpec[] = [
  {
    ...base, id: "echo-read", inputs: [fields[0], fields[1], fields[3]],
    job: { script: "cli/echo.js", args: (v) => ["--provider", String(v.provider), String(v.target), ...(v.verbose ? ["--verbose"] : [])] },
  },
  {
    ...base, id: "paste-read", safety: "SYNTHETIC",
    inputs: [{ kind: "json", name: "report", label: "Report", maxBytes: 4096 }],
    job: { script: "cli/paste.js", args: (v) => ["--report", String(v.report)] },
  },
  { ...handoff, inputs: [fields[1]] },
];

async function withServer(
  options: Omit<Parameters<typeof createLocalOperatorServer>[0], "root" | "catalog">,
  body: (url: string, token: string, state: () => Promise<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const { server } = createLocalOperatorServer({ root: process.cwd(), catalog: testCatalog, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("ADDRESS_UNAVAILABLE");
    const url = "http://127.0.0.1:" + address.port;
    const html = await (await fetch(url)).text();
    const token = html.match(/name="token" value="([0-9a-f]{48})"/)?.[1] ?? "";
    assert.ok(token);
    await body(url, token, async () => await (await fetch(url + "/state")).json() as Record<string, unknown>);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const post = (url: string, fieldsToSend: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url + "/run", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fieldsToSend) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("GET /operations returns public descriptors only", async () => {
  await withServer({}, async (url) => {
    const response = await fetch(url + "/operations");
    assert.equal(response.status, 200);
    const text = await response.text();
    const list = JSON.parse(text) as Array<Record<string, unknown>>;
    assert.deepEqual(list.map((item) => item.id), ["echo-read", "paste-read", "demo-hand"]);
    assert.equal(list[2].runnable, false);
    assert.doesNotMatch(text, /cli\/echo|cli\/paste|"job"|"args"|dist\//);
    const foreign = await fetch(url + "/operations", { headers: { origin: "https://untrusted.example" } });
    assert.equal(foreign.status, 403);
  });
});

test("an operation run validates server-side, runs through the runner and records the operation id", async () => {
  const jobs: Array<{ mode: string; script: string; args: string[] }> = [];
  await withServer({ runner: async (job) => { jobs.push(job); return "OK"; } }, async (url, token, state) => {
    const accepted = await post(url, { operation: "echo-read", token,
      inputs: JSON.stringify({ target: "core-net", verbose: true, provider: "azure" }) });
    assert.equal(accepted.status, 202);
    await settle();
    assert.deepEqual(jobs, [{ mode: "echo-read", script: "cli/echo.js", title: "Demo", evidenceBasis: "FIXTURE",
      args: ["--provider", "azure", "core-net", "--verbose"] }]);
    const done = await state();
    assert.equal(done.status, "PASS");
    assert.equal(done.operation, "echo-read");

    const refusals: Array<[Record<string, string>, number, string]> = [
      [{ operation: "echo-read", inputs: JSON.stringify({ target: "core-net", shell: "rm" }) }, 400, "INPUT_UNKNOWN_FIELD"],
      [{ operation: "echo-read", inputs: JSON.stringify({ target: "x".repeat(40) }) }, 400, "INPUT_TOO_LONG:target"],
      [{ operation: "echo-read", inputs: JSON.stringify({ target: "ok", provider: "gcp" }) }, 400, "INPUT_ENUM:provider"],
      [{ operation: "echo-read", inputs: "not json" }, 400, "INPUTS_NOT_JSON"],
      [{ operation: "nope", inputs: "{}" }, 400, "UNSUPPORTED_OPERATION"],
      [{ operation: "echo-read", mode: "chaos", inputs: JSON.stringify({ target: "ok" }) }, 400, "AMBIGUOUS_REQUEST"],
    ];
    for (const [body, status, code] of refusals) {
      const response = await post(url, { ...body, token });
      assert.equal(response.status, status, code);
      assert.deepEqual(await response.json(), { error: code });
    }
    assert.equal(jobs.length, 1, "no refused request reaches the runner");
  });
});

test("a HANDOFF operation is refused and never reaches the runner", async () => {
  let calls = 0;
  await withServer({ runner: async () => { calls += 1; return ""; } }, async (url, token) => {
    const response = await post(url, { operation: "demo-hand", token, inputs: JSON.stringify({ target: "core-net" }) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "OPERATION_HANDOFF_ONLY" });
    assert.equal(calls, 0);
  });
});

test("pasted JSON is written by the server to a private directory and removed afterward", async () => {
  let seen: { path: string; mode: number; text: string; dirMode: number } | undefined;
  await withServer({ runner: async (job) => {
    const path = job.args[1];
    seen = { path, text: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777,
      dirMode: statSync(dirname(path)).mode & 0o777 };
    return "OK";
  } }, async (url, token) => {
    const pasted = '{ "a": [1, 2] }';
    assert.equal((await post(url, { operation: "paste-read", token, inputs: JSON.stringify({ report: pasted }) })).status, 202);
    await settle();
    assert.ok(seen);
    assert.equal(seen.text, '{"a":[1,2]}');
    assert.equal(seen.dirMode, 0o700);
    assert.equal(seen.mode, 0o600);
    assert.equal(existsSync(seen.path), false);
    assert.equal(existsSync(dirname(seen.path)), false);
    // Oversize and invalid JSON are refused before any file exists.
    const big = await post(url, { operation: "paste-read", token, inputs: JSON.stringify({ report: '"' + "x".repeat(5000) + '"' }) });
    assert.deepEqual(await big.json(), { error: "INPUT_TOO_LARGE:report" });
    const bad = await post(url, { operation: "paste-read", token, inputs: JSON.stringify({ report: "{" }) });
    assert.deepEqual(await bad.json(), { error: "INPUT_JSON_INVALID:report" });
  });
});

test("the directory is also removed when the run fails", async () => {
  let path = "";
  await withServer({ runner: async (job) => { path = job.args[1]; throw new Error("BOOM"); } }, async (url, token, state) => {
    await post(url, { operation: "paste-read", token, inputs: JSON.stringify({ report: "{}" }) });
    await settle();
    assert.equal((await state()).status, "BLOCKED");
    assert.ok(path);
    assert.equal(existsSync(dirname(path)), false);
  });
});

test("host, origin and CSRF checks still apply, and only one worker runs at a time", async () => {
  let release: () => void = () => {};
  let calls = 0;
  await withServer({ runner: () => { calls += 1; return new Promise<string>((resolve) => { release = () => resolve("done"); }); } },
    async (url, token) => {
      const body = { operation: "echo-read", inputs: JSON.stringify({ target: "ok" }) };
      assert.equal((await post(url, { ...body, token: "fake" })).status, 403);
      assert.equal((await post(url, { ...body, token }, { origin: "https://untrusted.example" })).status, 403);
      assert.equal((await post(url, { ...body, token }, { "content-type": "application/json" })).status, 415);
      assert.equal(calls, 0);
      assert.equal((await post(url, { ...body, token })).status, 202);
      // A legacy request and a second operation are both turned away while one runs.
      assert.equal((await post(url, { ...body, token })).status, 409);
      assert.equal((await post(url, { mode: "chaos", scenario: "all", token })).status, 409);
      assert.equal(calls, 1);
      release();
      await settle();
    });
});

test("only an operation request may exceed the legacy body size", async () => {
  await withServer({ runner: async () => "OK" }, async (url, token) => {
    const legacy = await post(url, { mode: "chaos", scenario: "all", token, pad: "x".repeat(3000) });
    assert.equal(legacy.status, 413);
    const large = await post(url, { operation: "paste-read", token, inputs: JSON.stringify({ report: '"' + "y".repeat(3500) + '"' }) });
    assert.equal(large.status, 202);
  });
});

test("the committed operations table in docs/operator-console.md matches the catalog", () => {
  const committed = readFileSync(DOC_PATH, "utf8");
  assert.equal(committed, renderDoc(committed), "stale table: run npm run docs:ops");
  for (const spec of OPERATIONS) assert.ok(committed.includes("`" + spec.cli.replaceAll("|", "\\|") + "`"), spec.id);
});

test("a request that was still sending its body when another started is turned away", async () => {
  let release: () => void = () => {};
  let calls = 0;
  await withServer({ runner: () => { calls += 1; return new Promise<string>((resolve) => { release = () => resolve("done"); }); } },
    async (url, token) => {
      const encoded = new URLSearchParams({ operation: "echo-read", token, inputs: JSON.stringify({ target: "ok" }) }).toString();
      const slow = new Promise<number>((resolve, reject) => {
        const request = httpRequest(url + "/run", { method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" } }, (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        request.on("error", reject);
        request.write(encoded.slice(0, 10));
        // The second request completes while this one's body is still arriving.
        void settle().then(() => post(url, { operation: "echo-read", token, inputs: JSON.stringify({ target: "ok" }) }))
          .then(async (second) => {
            assert.equal(second.status, 202);
            request.end(encoded.slice(10));
          });
      });
      assert.equal(await slow, 409);
      assert.equal(calls, 1);
      release();
      await settle();
    });
});
