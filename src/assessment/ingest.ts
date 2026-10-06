import { z } from "zod";

import type {
  ResiliencyObservation,
  ScannerObservation,
} from "../discovery/types.js";

const scannerObservationSchema =
  z.object({
    id: z.string().min(1),
    scanner: z.string().min(1),
    source: z.string().min(1),
    status: z.enum([
      "PASS",
      "FAIL",
      "UNKNOWN",
    ]),
    domain: z.enum([
      "IDENTITY",
      "NETWORK",
      "ENCRYPTION",
      "LOGGING",
      "SUPPLY_CHAIN",
      "CONFIGURATION",
      "RESILIENCY",
      "OWNERSHIP",
      "PLATFORM",
    ]),
    severity: z.enum([
      "INFO",
      "LOW",
      "MEDIUM",
      "HIGH",
      "CRITICAL",
    ]),
    title: z.string().min(1),
    detail: z.string().min(1),
    resourceId:
      z.string().optional(),
  });

const resiliencyObservationSchema =
  z.object({
    key: z.enum([
      "configuration_backup",
      "restore_test",
      "redundant_control_plane",
      "rpo",
      "rto",
    ]),
    value: z.string().min(1),
    source: z.string().min(1),
  });

const postureEvidenceSchema =
  z.object({
    scannerObservations:
      z.array(
        scannerObservationSchema,
      ).default([]),
    resiliencyObservations:
      z.array(
        resiliencyObservationSchema,
      ).default([]),
  });

export function parsePostureEvidenceBundle(
  raw: string,
): {
  scannerObservations: ScannerObservation[];
  resiliencyObservations: ResiliencyObservation[];
} {
  const value =
    postureEvidenceSchema.parse(
      JSON.parse(raw),
    );

  return {
    scannerObservations:
      value.scannerObservations,
    resiliencyObservations:
      value.resiliencyObservations,
  };
}
