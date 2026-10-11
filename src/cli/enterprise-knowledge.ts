import { BASELINE_KNOWLEDGE_SNAPSHOTS } from "../knowledge/baseline.js";
import { ingestKnowledgeSnapshot } from "../knowledge/ingest.js";
import { KNOWLEDGE_SOURCES } from "../knowledge/sources.js";
import type { KnowledgeSnapshot } from "../knowledge/types.js";
import { jsonOption, runReport } from "../enterprise/report.js";

// ./alz enterprise knowledge [--input SNAPSHOT.json] [--private-sovereign]
// Without a snapshot: the registered knowledge sources and whether the built-in
// baseline snapshot of each is accepted. With one: whether that snapshot would be
// accepted (source, hash, unique records, no credential-like fields, local mirror
// when --private-sovereign). Reads no source over the network.
await runReport((args) => {
  const privateSovereign = args.includes("--private-sovereign");
  const pasted = jsonOption(args, "input") as KnowledgeSnapshot | undefined;
  const results = (pasted ? [pasted] : BASELINE_KNOWLEDGE_SNAPSHOTS).map((snapshot) => ingestKnowledgeSnapshot(snapshot, { privateSovereign }));
  const lines = results.map((result) => result.snapshot.sourceId + ": " + (result.accepted ? "ACCEPTED" : "REJECTED") +
    " (" + result.recordCount + " records, " + result.source.trust + ")" + result.reasons.map((item) => "\n    " + item).join(""));
  if (!pasted) {
    const baseline = new Set(BASELINE_KNOWLEDGE_SNAPSHOTS.map((snapshot) => snapshot.sourceId));
    lines.push(...KNOWLEDGE_SOURCES.filter((source) => !baseline.has(source.id)).map((source) =>
      source.id + ": registered, no baseline snapshot (" + source.trust + (source.mirrorRequiredForPrivateSovereign ? ", local mirror required for private-sovereign" : "") + ")"));
  }
  return { ok: results.every((result) => result.accepted), lines: [pasted ? "KNOWLEDGE SNAPSHOT CHECK" : "KNOWLEDGE SOURCES", ...lines, "Checked only. Nothing was fetched or ingested."] };
});
