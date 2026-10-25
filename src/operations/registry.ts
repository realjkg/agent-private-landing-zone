import { validateCatalog } from "./schema.js";
import { accountFactoryOperations } from "./families/account-factory.js";
import { enterpriseOperations } from "./families/enterprise.js";
import { evidenceOperations } from "./families/evidence.js";
import { governanceOperations } from "./families/governance.js";
import { qualificationOperations } from "./families/qualification.js";
import { teardownOperations } from "./families/teardown.js";
import type { OperationSpec } from "./types.js";
import { workflowOperations } from "./workflows.js";

/**
 * The one operation catalog. The console server, the React UI (through
 * GET /operations), the ./alz group fallback, the docs table and the parity
 * guard all read this list. A malformed entry fails here, at load.
 */
export const OPERATIONS: readonly OperationSpec[] = [
  ...workflowOperations,
  ...accountFactoryOperations,
  ...evidenceOperations,
  ...governanceOperations,
  ...qualificationOperations,
  ...teardownOperations,
  ...enterpriseOperations,
];

const problems = validateCatalog(OPERATIONS);
if (problems.length > 0) throw new Error("OPERATION_CATALOG_INVALID: " + problems.join("; "));

/** Operations that declare an `./alz <group> <sub>` command, by group. */
export function operationGroups(catalog: readonly OperationSpec[] = OPERATIONS): Map<string, OperationSpec[]> {
  const groups = new Map<string, OperationSpec[]>();
  for (const spec of catalog) {
    if (spec.command) groups.set(spec.command.group, [...(groups.get(spec.command.group) ?? []), spec]);
  }
  return groups;
}
