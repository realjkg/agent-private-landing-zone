import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";

import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { createSessionGraph } from "../src/session/graph.js";
import { disableHostedTracing } from "../src/session/hosted-tracing.js";

/** A local stand-in for the hosted tracing service that counts what reaches it. Synthetic; nothing leaves the host. */
async function tracingSink() {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const endpoint = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  return { paths, endpoint, close: () => new Promise<void>((done) => server.close(() => done())) };
}

const TRACING = (endpoint: string) => ({
  LANGSMITH_TRACING: "true", LANGCHAIN_TRACING_V2: "true", LANGSMITH_API_KEY: "lsv2-synthetic-key",
  LANGSMITH_ENDPOINT: endpoint, LANGCHAIN_ENDPOINT: endpoint, LANGSMITH_PROJECT: "synthetic",
});

function withEnv(values: Record<string, string>) {
  const saved = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return () => { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } };
}

test("disableHostedTracing removes every hosted-tracing variable, names them, and leaves the rest", () => {
  const env: NodeJS.ProcessEnv = { ...TRACING("http://127.0.0.1:9"), LANGCHAIN_TRACING: "true", LANGCHAIN_API_KEY: "k",
    LANGCHAIN_PROJECT: "p", LANGCHAIN_CALLBACKS_BACKGROUND: "true", PATH: "/usr/bin", LANGCHAIN_PRIVATE_MODE: "kept" };
  const removed = disableHostedTracing(env);
  assert.deepEqual(Object.keys(env).sort(), ["LANGCHAIN_PRIVATE_MODE", "PATH"]);
  assert.ok(removed.includes("LANGSMITH_API_KEY") && removed.includes("LANGCHAIN_TRACING_V2"));
  assert.ok(!removed.some((name) => name.includes("lsv2")), "names only, never values");
});

// One sink for the file: the tracing client is created once per process and keeps the first endpoint it sees.
let sink: Awaited<ReturnType<typeof tracingSink>>;
before(async () => { sink = await tracingSink(); });
after(async () => { await sink.close(); });

async function settle(wantAny: boolean) {
  await awaitAllCallbacks();
  for (let i = 0; i < 50 && (wantAny ? sink.paths.length === 0 : i < 15); i += 1) await new Promise((done) => setTimeout(done, 20));
}

test("the harness sees tracing egress: a bare graph with tracing on reaches the sink (control)", async () => {
  sink.paths.length = 0;
  const restore = withEnv(TRACING(sink.endpoint));
  try {
    const State = Annotation.Root({ value: Annotation<string> });
    const bare = new StateGraph(State).addNode("echo", (s: { value: string }) => ({ value: s.value + "!" }))
      .addEdge(START, "echo").addEdge("echo", END).compile();
    await bare.invoke({ value: "synthetic" });
    await settle(true);
    assert.ok(sink.paths.length > 0, "the control must reach the sink, or the next test proves nothing");
  } finally {
    restore();
  }
});

test("the session graph sends nothing to a tracing service even when the environment asks it to", async () => {
  sink.paths.length = 0;
  const restore = withEnv(TRACING(sink.endpoint));
  try {
    const { graph } = createSessionGraph(":memory:");
    assert.equal(process.env.LANGSMITH_TRACING, undefined, "removed before the graph exists");
    assert.equal(process.env.LANGSMITH_API_KEY, undefined);
    await graph.invoke({ request: "Review this environment and assess operational risk.", provider: "AWS",
      engine: "TERRAFORM", mock: "brownfield", approveBuild: false, fixture: true }, { configurable: { thread_id: "no-egress" } });
    await settle(false);
    assert.deepEqual(sink.paths, [], "no request reached the tracing sink");
  } finally {
    restore();
    disableHostedTracing();
  }
});
