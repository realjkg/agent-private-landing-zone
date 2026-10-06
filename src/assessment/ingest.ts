import { z } from "zod";

import type {
  DiscoveredResource,
  Provider,
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


const inventoryAssetSchema =
  z.object({
    resourceId: z.string().min(1),
    resourceType: z.string().min(1),
    name: z.string().min(1),
    assetKind: z.enum([
      "PHYSICAL",
      "VIRTUAL",
      "CLOUD",
    ]),
    ownership: z
      .enum([
        "EXTERNAL",
        "MANAGED_BY_CUSTOMER",
        "MANAGED_BY_OTHER_IAC",
        "UNKNOWN",
      ])
      .default("UNKNOWN"),
    sourceOfTruth: z
      .enum([
        "TERRAFORM",
        "BICEP",
        "CLOUDFORMATION",
        "CDK",
        "CONTROL_TOWER",
        "AFT",
        "AZURE_POLICY",
        "MANUAL",
        "UNKNOWN",
      ])
      .default("MANUAL"),
    scope: z.string().optional(),
    region: z.string().optional(),
    tags:
      z.record(
        z.string(),
        z.string(),
      ).optional(),
  });

const inventoryEvidenceSchema =
  z.object({
    assets:
      z.array(
        inventoryAssetSchema,
      ),
  });

export function parseInventoryEvidenceBundle(
  raw: string,
  provider: Provider,
): DiscoveredResource[] {
  const value =
    inventoryEvidenceSchema.parse(
      JSON.parse(raw),
    );

  return value.assets.map(
    (asset) => ({
      resourceId: asset.resourceId,
      provider,
      resourceType:
        asset.resourceType,
      name: asset.name,
      scope: asset.scope,
      region: asset.region,
      ownership:
        asset.ownership,
      mutationPolicy:
        "READ_ONLY" as const,
      sourceOfTruth:
        asset.sourceOfTruth,
      tags: asset.tags,
      metadata: {
        assetKind:
          asset.assetKind,
        importedEvidence: true,
      },
    }),
  );
}
