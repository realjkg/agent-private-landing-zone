import { readFile } from "node:fs/promises";

import { z } from "zod";

import type {
  RecoveryTargetSpec,
} from "./target.js";

const recoveryMetadataSchema = z.object({
  apiVersion: z.literal(
    "alz.io/recovery/v1",
  ),
  selection: z.object({
    organization: z.enum([
      "STARTUP",
      "ENTERPRISE",
    ]),
    environment: z.enum([
      "DEVELOPMENT",
      "PRODUCTION",
    ]),
    criticality: z.enum([
      "NON_CRITICAL",
      "BUSINESS",
      "CRITICAL",
    ]),
    compliancePacks: z
      .array(z.string()),
  }),
  objectives: z.object({
    rpoMinutes: z.number().int().positive(),
    rtoMinutes: z.number().int().positive(),
    retentionDays: z.number().int().positive(),
    maximumRestoreEvidenceAgeDays:
      z.number().int().positive(),
  }),
  destination: z.object({
    placement: z.literal(
      "PROVIDER_EDGE",
    ),
    targetRef: z.string().min(1),
    encryption: z.literal(
      "CUSTOMER_MANAGED",
    ),
    immutable: z.boolean(),
    minimumHealthyCopies:
      z.number().int().positive(),
    minimumFailureDomains:
      z.number().int().positive(),
    centralControlCanDecrypt:
      z.literal(false),
  }),
  automation: z.object({
    captureEveryMinutes:
      z.number().int().positive(),
    verifyEveryMinutes:
      z.number().int().positive(),
    drillEveryMinutes:
      z.number().int().positive(),
    driftEveryMinutes:
      z.number().int().positive(),
    restoreMode: z.literal(
      "ISOLATED_PREVIEW",
    ),
    productionMutation:
      z.literal(false),
  }),
  securityBaseline: z.object({
    documentId: z.literal(
      "ALZ-SECURITY-BASELINE",
    ),
    documentVersion:
      z.string().min(1),
    documentRef:
      z.string().min(1),
    expectedSha256:
      z.string().length(64),
    failClosedOnMissing:
      z.literal(true),
    failClosedOnHashMismatch:
      z.literal(true),
  }),
  dataBoundary: z.object({
    productionDataAllowed:
      z.boolean(),
  }),
  policy: z.object({
    evaluator: z.literal(
      "INHERIT",
    ),
    decisions: z.object({
      capture: z.literal(
        "recovery/capture",
      ),
      verify: z.literal(
        "recovery/verify",
      ),
      drill: z.literal(
        "recovery/drill",
      ),
      drift: z.literal(
        "recovery/drift",
      ),
      restore: z.literal(
        "recovery/restore",
      ),
    }),
    compromiseBehavior:
      z.object({
        NORMAL:
          z.literal("EVALUATE"),
        SUSPECTED:
          z.literal("SUSPEND"),
        CONTAINED:
          z.literal("SUSPEND"),
        RECOVERY:
          z.literal(
            "ISOLATED_ONLY",
          ),
        VERIFIED:
          z.literal("EVALUATE"),
      }),
  }),
  provenance: z.object({
    targetSchemaVersion:
      z.literal(1),
    profileCatalogVersion:
      z.literal(1),
    compilerVersion:
      z.literal("1"),
    baselineDocumentHash:
      z.string().length(64),
    compiledTargetHash:
      z.string().length(64),
    compiledPolicyHash:
      z.string().length(64),
    sourceCommit:
      z.string().min(1).optional(),
  }),
});

const capabilitySchema = z.enum([
  "EVIDENCE_READ",
  "EVIDENCE_WRITE",
  "CLOUD_READ",
  "PROJECT_CODE_EXECUTION",
  "PREVIEW_WRITE",
  "MANAGED_ACCESS",
  "DESIGN",
  "BUILD_PREVIEW",
  "VALIDATE",
]);

const artifactSchema = z.enum([
  "INVENTORY_MANIFEST",
  "CONFIGURATION_EXPORT",
  "IAC_SOURCE",
  "IAC_STATE",
  "POLICY_CONFIGURATION",
]);

const targetSchema = z.object({
  targetId: z
    .string()
    .min(3)
    .max(64),
  enabled: z.boolean(),
  owner: z.string().min(1),
  provider: z.enum([
    "AWS",
    "AZURE",
  ]),
  scope: z.object({
    type: z.enum([
      "AWS_ORGANIZATION",
      "AWS_ACCOUNT",
      "AZURE_TENANT",
      "AZURE_MANAGEMENT_GROUP",
      "AZURE_SUBSCRIPTION",
    ]),
    id: z.string().min(1),
  }),
  environment: z.object({
    mode: z.enum([
      "LIVE_READ_ONLY",
      "FIXTURE",
    ]),
    fixture: z
      .enum([
        "brownfield",
        "greenfield",
        "unknown",
      ])
      .optional(),
  }),
  source: z.object({
    engine: z.enum([
      "TERRAFORM",
      "PULUMI",
      "OPENTOFU",
      "BICEP",
      "CLOUDFORMATION",
      "AWS_CDK",
      "CROSSPLANE",
      "ANSIBLE",
    ]),
    approvedDesignHash: z
      .string()
      .length(64),
    designRef: z.string().min(1),
    sourceOfTruthRef:
      z.string().min(1),
  }),
  protectedArtifacts: z
    .array(artifactSchema)
    .min(1),
  evidenceDestination:
    z.discriminatedUnion(
      "kind",
      [
        z.object({
          kind: z.literal(
            "LOCAL_ENCRYPTED_VAULT",
          ),
          namespace:
            z.string().min(1),
        }),
        z.object({
          kind: z.literal(
            "EXTERNAL_ENCRYPTED_STORE",
          ),
          locationRef:
            z.string().min(1),
        }),
      ],
    ),
  schedule: z.object({
    captureEveryMinutes: z
      .number()
      .int()
      .positive(),
    verifyEveryMinutes: z
      .number()
      .int()
      .positive(),
    drillEveryMinutes: z
      .number()
      .int()
      .positive(),
    driftEveryMinutes: z
      .number()
      .int()
      .positive(),
  }),
  objectives: z.object({
    retentionDays: z
      .number()
      .int()
      .positive(),
    rpoMinutes: z
      .number()
      .int()
      .positive(),
    rtoMinutes: z
      .number()
      .int()
      .positive(),
  }),
  protection: z.object({
    encryptionRequired:
      z.literal(true),
    immutability: z.enum([
      "REQUIRED",
      "OPTIONAL",
    ]),
    offlineCopy: z.enum([
      "REQUIRED",
      "OPTIONAL",
    ]),
  }),
  capabilityRequests: z
    .array(capabilitySchema)
    .min(1),
  recoveryMetadata:
    recoveryMetadataSchema.optional(),
});

export function parseRecoveryTargets(
  value: unknown,
): RecoveryTargetSpec[] {
  const parsed =
    z.array(targetSchema).parse(
      value,
    );

  return parsed as RecoveryTargetSpec[];
}

export async function loadRecoveryTargets(
  path: string,
): Promise<RecoveryTargetSpec[]> {
  const raw =
    await readFile(
      path,
      "utf8",
    );

  return parseRecoveryTargets(
    JSON.parse(raw) as unknown,
  );
}
