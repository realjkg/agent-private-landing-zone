import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { executeTool } from "../src/tools/broker.js";
import { runGovernedTool } from "../src/tools/governed.js";
import type { ToolContext, ToolRequest, ToolResult } from "../src/tools/types.js";

const MODE = "AGENTIC_SECURITY_POLICY_MODE";

async function withMode<T>(mode: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[MODE];
  if (mode === undefined) {
    delete process.env[MODE];
  } else {
    process.env[MODE] = mode;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env[MODE];
    } else {
      process.env[MODE] = previous;
    }
  }
}

function first(result: ToolResult | ToolResult[]): ToolResult {
  return Array.isArray(result) ? result[0] : result;
}

function stable(result: ToolResult | ToolResult[]): unknown {
  const rows = Array.isArray(result) ? result : [result];
  return rows.map((row) => ({ ...row, durationMs: 0 }));
}

const baseContext: ToolContext = {
  cwd: process.cwd(),
  allowCloudRead: false,
  allowMutation: false,
};

function opaFetch(body: unknown, seen: Array<{ kind: string; requested?: string[] }> = []): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    const input = JSON.parse(init?.body ?? "{}").input;
    seen.push(input.requested ? { kind: input.kind, requested: input.requested } : { kind: input.kind });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

// Every file listed here calls the broker directly on purpose: each one
// feeds it denied or adversarial contexts that a governed path would
// refuse before the broker could be probed.
const DIRECT_BROKER_ALLOWLIST: Record<string, string> = {
  "src/tools/governed.ts": "the governed path itself",
  "src/qualification/private-model-adversarial.ts":
    "red-team harness that proves the broker denies adversarial model-chosen tools",
  "src/qualification/private-security-redteam.ts":
    "red-team harness that proves the broker denies blocked commands and contexts",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("only the governed path and listed red-team harnesses call executeTool", () => {
  const offenders = sourceFiles("src")
    .map((path) => relative(".", path).split("\\").join("/"))
    .filter((path) => /\bexecuteTool\b/.test(readFileSync(path, "utf8")))
    .filter((path) => !(path in DIRECT_BROKER_ALLOWLIST) && path !== "src/tools/broker.ts");

  assert.deepEqual(offenders, [], "route these through runGovernedTool: " + offenders.join(", "));
});

test("default mode passes results and broker arguments through unchanged", async () => {
  await withMode(undefined, async () => {
    const cases: Array<[ToolRequest, ToolContext]> = [
      [{ tool: "terraform_version" }, baseContext],
      [{ tool: "rm_rf" as never }, baseContext],
      [{ tool: "terraform_version" }, { ...baseContext, securityPolicyDecision: { allow: false, reasons: ["pinned denial"], obligations: [], source: "BUILTIN" } }],
      [{ tool: "terraform_version" }, { ...baseContext, allowCloudRead: true, compromiseState: "SUSPECTED" }],
    ];

    for (const [request, context] of cases) {
      assert.deepEqual(stable(await runGovernedTool(request, context)), stable(executeTool(request, context)));
    }

    // The caller's own compromise state and decision reach the broker as-is.
    const blocked = first(await runGovernedTool({ tool: "terraform_version" }, cases[3][1]));
    assert.equal(blocked.blocked, true);
    assert.match(blocked.reason ?? "", /denies capabilities: CLOUD_READ/);
  });
});

test("BUILTIN mode behaves like the default", async () => {
  await withMode("BUILTIN", async () => {
    const request: ToolRequest = { tool: "terraform_version" };
    assert.deepEqual(stable(await runGovernedTool(request, baseContext)), stable(executeTool(request, baseContext)));
  });
});

test("OPA mode computes the decision locally and reaches the broker", async () => {
  await withMode("OPA", async () => {
    const seen: Array<{ kind: string; requested?: string[] }> = [];
    const result = first(
      await runGovernedTool({ tool: "terraform_version" }, baseContext, {
        opa: { fetchImpl: opaFetch({ result: { allow: true, reasons: [], obligations: [] } }, seen) },
      }),
    );

    assert.deepEqual(seen, [{ kind: "CAPABILITY", requested: [] }]);
    assert.notEqual(result.reason, "OPA policy mode requires a precomputed local policy decision.");
    assert.notEqual(result.blocked, true);
  });
});

test("OPA mode sends capability and egress inputs for cloud reads", async () => {
  await withMode("OPA", async () => {
    const seen: Array<{ kind: string; requested?: string[] }> = [];
    await runGovernedTool({ tool: "aws_sts_identity", provider: "AWS" }, { ...baseContext, allowCloudRead: true }, {
      opa: { fetchImpl: opaFetch({ result: { allow: true, reasons: [], obligations: [] } }, seen) },
    });

    assert.deepEqual(seen, [{ kind: "CAPABILITY", requested: ["CLOUD_READ"] }, { kind: "EGRESS" }]);
  });
});

test("OPA mode does not widen the allowlist", async () => {
  await withMode("OPA", async () => {
    const result = first(
      await runGovernedTool({ tool: "rm_rf" as never }, baseContext, {
        opa: { fetchImpl: opaFetch({ result: { allow: true, reasons: [], obligations: [] } }) },
      }),
    );
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "Tool is not on the allowlist.");
  });
});

test("OPA mode fails closed on a denial, outage, undefined decision and invalid mode", async () => {
  await withMode("OPA", async () => {
    const denied = first(
      await runGovernedTool({ tool: "terraform_version" }, baseContext, {
        opa: { fetchImpl: opaFetch({ result: { allow: false, reasons: ["policy says no"], obligations: [] } }) },
      }),
    );
    assert.equal(denied.blocked, true);
    assert.match(denied.reason ?? "", /policy says no/);

    const outage = first(
      await runGovernedTool({ tool: "terraform_version" }, baseContext, {
        opa: { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch },
      }),
    );
    assert.equal(outage.blocked, true);
    assert.match(outage.reason ?? "", /OPA decision point is unavailable/);
    assert.match(outage.reason ?? "", /AGENTIC_SECURITY_POLICY_MODE=OPA/);
    assert.match(outage.reason ?? "", /unset the variable/);

    const undefinedDecision = first(
      await runGovernedTool({ tool: "terraform_version" }, baseContext, {
        opa: { fetchImpl: opaFetch({}) },
      }),
    );
    assert.equal(undefinedDecision.blocked, true);
    assert.match(undefinedDecision.reason ?? "", /AGENTIC_SECURITY_POLICY_MODE=OPA/);

    const remote = first(
      await runGovernedTool({ tool: "terraform_version" }, baseContext, {
        opa: { baseUrl: "http://opa.example.com:8181" },
      }),
    );
    assert.equal(remote.blocked, true);
    assert.match(remote.reason ?? "", /OPA_ENDPOINT_DENIED/);
  });

  await withMode("opa", async () => {
    const invalid = first(await runGovernedTool({ tool: "terraform_version" }, baseContext));
    assert.equal(invalid.blocked, true);
    assert.match(invalid.reason ?? "", /SECURITY_POLICY_MODE_INVALID/);
    assert.match(invalid.reason ?? "", /AGENTIC_SECURITY_POLICY_MODE/);
    assert.match(invalid.reason ?? "", /BUILTIN or OPA/);
  });
});
