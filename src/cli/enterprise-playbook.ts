import { sealOperationalPlaybook, type OperationalPlaybookInput } from "../managed-operations/operations.js";
import { jsonOption, reason, record, runReport } from "../enterprise/report.js";

// ./alz enterprise playbook --input FILE
// FILE: one operational playbook or a list of them. Each is normalized and hashed;
// one that carries an artifactSha256 must match it. Nothing is executed: a
// playbook only runs through a lease, an approved change record and a provider
// installed at your site.
await runReport((args) => {
  const input = jsonOption(args, "input");
  const playbooks = Array.isArray(input) ? input : [input];
  if (playbooks.length === 0 || playbooks.length > 50) throw new Error("PLAYBOOK_COUNT_INVALID");
  let ok = true;
  const lines = playbooks.map((item, index) => {
    const { artifactSha256, ...rest } = record(item);
    try {
      const sealed = sealOperationalPlaybook(rest as OperationalPlaybookInput);
      const state = artifactSha256 === undefined ? "hash computed" : artifactSha256 === sealed.artifactSha256 ? "hash matches" : "HASH MISMATCH";
      ok &&= state !== "HASH MISMATCH";
      return "#" + (index + 1) + " " + sealed.playbookId + " " + sealed.version + ": " + (state === "HASH MISMATCH" ? "REJECTED" : "VALID") +
        " (" + sealed.operation + " on " + sealed.targetResourceId + ", " + state + " " + sealed.artifactSha256 + ")";
    } catch (error) {
      ok = false;
      return "#" + (index + 1) + ": REJECTED " + reason(error);
    }
  });
  return { ok, lines: [...lines, "Validated only. Nothing was executed."] };
});
