import type {
  CompliancePack,
} from "../schema.js";
import {
  AIUC1,
} from "./aiuc1.js";
import {
  HIPAA,
} from "./hipaa.js";
import {
  ISO27001,
} from "./iso27001.js";
import {
  PCI_DSS,
} from "./pci-dss.js";
import {
  SOC2_TYPE2,
} from "./soc2-type2.js";

// The five versioned compliance-pack overlays. Selecting one changes no
// policy decision and grants no capability — see docs/architecture.md,
// "Compliance packs".
export const COMPLIANCE_PACKS: readonly CompliancePack[] = [
  HIPAA,
  PCI_DSS,
  SOC2_TYPE2,
  ISO27001,
  AIUC1,
];

export function getCompliancePack(
  id: CompliancePack["id"],
  version: number,
): CompliancePack | undefined {
  return COMPLIANCE_PACKS.find(
    (pack) =>
      pack.id === id
      && pack.version === version,
  );
}
