# Runtime context management — deterministic phase

Implemented in `src/orchestration/context-manager.ts`. No inference, network, external summarization or persistence is performed by this module. It can run entirely on the private ALZ substrate.

## Behavior

- `estimateTokens` gives a conservative UTF-8 **estimate** (bytes/3), not an exact model tokenizer count.
- `chunkText` partitions narrative text into whole-word chunks with bounded overlap. Oversized unbreakable units fail, rather than silently splitting executable code or resource identities.
- `packContext` reserves at most 80% of the configured model window (default 65%) and prioritizes required safety/material facts, then higher-value passages.
- Requests, policies, approvals, and IaC plans are mandatory; if any cannot fit, admission throws `CONTEXT_REQUIRED_EVIDENCE_EXCEEDS_BUDGET`. The operator must increase the approved context window or split the workflow at a semantic boundary.
- Omitted optional logs/evidence/narrative produce SHA-256 and byte-length references, not fabricated summaries. This first phase does not persist omitted bytes. The caller must retain the originals in the existing protected evidence store before using the references.
- `handoffContext` marks omitted-evidence handoffs incomplete, preventing a summary from masquerading as authoritative approval evidence.
- `prepareSubagentContext` applies Studio sub-agent role and route admission **before** context selection. Hosted identity, tenant permissions and capability checks still require a real MCP service and cryptographic verification.

## Integration and remaining gates

The initial deployment is library-first and can be tested via `npx tsx --test test/context-manager.test.ts`. It is not yet wired into the default `think()` model prompt invocation: automatic omission there would change safety-critical model inputs, and needs a reviewed evidence-retention contract. A production inference path must also bind to the actual local model's tokenizer/context-window metadata, rather than relying solely on the estimate.

Before any automatic rolling compaction or agent-to-agent summarized handoff is used for actual cloud planning:
1. Bind omitted references to encrypted, locally durable records, verifying SHA-256 on reload.
2. Restrict compression to disposable narratives and logs; never summarize authorization and signed IaC plan artifacts as authority.
3. Add deterministic evidence ranking per specialist and model-aware tokenizer counts.
4. Add local-only optional summarization under an explicit model profile, with no hosted inference fallback.
5. Run sub-agent replay, cross-role boundary, large-plan, prompt-injection and truncation tests, then validate a complete Dev blueprint without performing unauthorized ACT.

This is an incremental design with explicit boundaries; it is not a completed production context subsystem.
