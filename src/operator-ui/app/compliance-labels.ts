import type {
  CompliancePackId,
  ControlStatus,
} from "../../compliance/schema.js";

/**
 * Presentation labels for the pack ids in src/compliance/schema.ts. Labels
 * are words for people; the data-status attributes and expert mapping lines
 * keep the raw ids.
 */
export const PACK_LABELS: Record<CompliancePackId, string> = {
  HIPAA: "HIPAA",
  PCI_DSS: "PCI-DSS",
  SOC2_TYPE2: "SOC 2 Type 2",
  ISO27001: "ISO 27001",
  AIUC1: "AIUC-1",
};

/**
 * Literal status vocabulary (spec D3: never "certified" or "compliant").
 * The map is one-to-one by construction — an UNKNOWN requirement renders
 * "Unknown" because the renderer looks the label up by status key; the
 * render sweep in test/operator-ui-d3-surfaces.test.tsx asserts no row
 * ever shows a label other than its own status.
 */
export const STATUS_LABELS: Record<ControlStatus, string> = {
  ALIGNED: "Aligned",
  GAP: "Gap",
  UNKNOWN: "Unknown",
};
