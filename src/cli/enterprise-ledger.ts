import { createPublicKey } from "node:crypto";

import { OPTIONAL_ENTERPRISE_INTEGRATIONS } from "../change-ledger/integrations.js";
import { verifySignedLedgerExport } from "../change-ledger/local.js";
import type { SignedLedgerExport } from "../change-ledger/types.js";
import { jsonOption, reason, record, runReport } from "../enterprise/report.js";

// ./alz enterprise ledger --input FILE
// FILE: { "export": <signed ledger export>, "trustedPublicKeyPem": "<PEM>" }.
// Verifies the signature, the hash chain, the anchor and the evidence manifest.
// The key must come from you, never from the export's source. Reads nothing else.
await runReport((args) => {
  const input = record(jsonOption(args, "input"));
  if (typeof input.trustedPublicKeyPem !== "string") throw new Error("LEDGER_TRUSTED_KEY_REQUIRED");
  const exported = input.export as SignedLedgerExport;
  const note = "Ledger records never authorize ACT. Optional integrations (" +
    OPTIONAL_ENTERPRISE_INTEGRATIONS.map((item) => item.id).join(", ") + ") are contracts only; none grants authority.";
  try {
    const status = verifySignedLedgerExport(exported, createPublicKey(input.trustedPublicKeyPem));
    const phases = new Map<string, number>();
    for (const item of exported.payload.records) phases.set(item.phase, (phases.get(item.phase) ?? 0) + 1);
    return { ok: true, lines: ["LEDGER EXPORT VERIFIED", "Records: " + status.count, "Head hash: " + (status.headHash ?? "none"),
      "Phases: " + ([...phases].map(([phase, count]) => phase + " " + count).join(", ") || "none"), note] };
  } catch (error) {
    return { ok: false, lines: ["LEDGER EXPORT REJECTED: " + reason(error), note] };
  }
});
