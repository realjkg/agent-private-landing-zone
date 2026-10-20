import assert from "node:assert/strict";
import test from "node:test";
import { chunkText, estimateTokens, handoffContext, packContext } from "../src/orchestration/context-manager.js";

test("context chunks retain text and respect bounded token estimates", () => {
  const text = Array.from({length:60},(_,i)=>"token"+i+" ").join("");
  const chunks = chunkText(text, 24, 4);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) assert.ok(estimateTokens(chunk) <= 24);
  assert.ok(chunks.join(" ").includes("token0"));
  assert.ok(chunks.at(-1)?.includes("token59"));
});
test("required policies and plans are always carried or refused, never silently truncated", () => {
  assert.throws(() => packContext([{id:"approval",kind:"APPROVAL",text:"a".repeat(800),priority:2}],128), /CONTEXT_REQUIRED_EVIDENCE_EXCEEDS_BUDGET/);
  const packed=packContext([{id:"policy",kind:"POLICY",text:"deny uncontrolled apply",priority:10}],512);
  assert.ok(packed.text.includes("deny uncontrolled apply"));
  assert.equal(packed.requiresFullEvidenceReview,false);
});
test("oversized optional evidence becomes hashed reference and blocks completeness claim", () => {
  const packed=packContext([
    {id:"request",kind:"REQUEST",priority:2,text:"Assess"},
    {id:"log",kind:"LOG",priority:1,text:"x".repeat(1200)}
  ],256);
  assert.equal(packed.omitted.length,1);
  assert.match(packed.omitted[0]!.sha256,/^[a-f0-9]{64}$/);
  assert.equal(handoffContext(packed).complete,false);
  assert.ok(!packed.text.includes("x".repeat(100)));
});
test("context refuses duplicate ids and invalid window sizing", () => {
  const a={id:"dup",kind:"NARRATIVE" as const,text:"text",priority:0};
  assert.throws(()=>packContext([a,a],1024),/CONTEXT_PART_INVALID/);
  assert.throws(()=>packContext([a],127),/CONTEXT_WINDOW_INVALID/);
  assert.throws(()=>chunkText("abc",32,32),/CONTEXT_CHUNK_BUDGET_INVALID/);
});
