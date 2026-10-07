import { readFile } from "node:fs/promises";

import { z } from "zod";

import type {
  RecoveryTargetSpec,
} from "./target.js";

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
