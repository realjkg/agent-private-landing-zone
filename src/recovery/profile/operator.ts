import {
  z,
} from "zod";

import {
  validateRecoveryTarget,
  type RecoveryTargetSpec,
} from "../target.js";
import {
  composeContinuityProfile,
} from "./catalog.js";
import type {
  RecoveryTargetIntent,
} from "./types.js";
import {
  verifyCompiledRecoveryTarget,
} from "./verify.js";

const intentSchema = z.object({
  targetId: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9._-]{2,63}$/i,
    ),
  owner: z.string().min(1),
  provider: z.enum([
    "AWS",
    "AZURE",
  ]),
  scopeId: z.string().min(1),
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
    .array(
      z.string().regex(
        /^[A-Z0-9_]+@\d+$/,
      ),
    )
    .default([]),
});

export function parseRecoveryTargetIntent(
  value: unknown,
): RecoveryTargetIntent {
  const parsed =
    intentSchema.parse(value);

  return {
    ...parsed,
    compliancePacks: [
      ...new Set(
        parsed.compliancePacks,
      ),
    ].sort(),
  };
}

export function recoveryIntentFromAnswers(
  answers: string[],
  compliancePacks: string[] = [],
): RecoveryTargetIntent {
  if (answers.length !== 7) {
    throw new Error(
      [
        "Problem: target init requires exactly seven basic answers.",
        "Recommended fix: provide target-id, owner, provider, scope-id, organization, environment, and criticality.",
        "Safe alternative: run ./alz target explain after creating the intent to review derived continuity defaults.",
        "No infrastructure changes were made.",
      ].join("\n"),
    );
  }

  const [
    targetId,
    owner,
    provider,
    scopeId,
    organization,
    environment,
    criticality,
  ] = answers;

  return parseRecoveryTargetIntent({
    targetId,
    owner,
    provider:
      provider.toUpperCase(),
    scopeId,
    organization:
      organization.toUpperCase(),
    environment:
      environment.toUpperCase(),
    criticality:
      criticality
        .toUpperCase()
        .replace(/-/g, "_"),
    compliancePacks:
      compliancePacks.map(
        (pack) =>
          pack
            .trim()
            .toUpperCase(),
      ).filter(Boolean),
  });
}

export function explainRecoveryIntent(
  intent: RecoveryTargetIntent,
): string {
  const profile =
    composeContinuityProfile(
      intent.organization,
      intent.environment,
      intent.criticality,
    );

  return [
    "Recovery target: " +
      intent.targetId,
    "Owner: " + intent.owner,
    "Provider scope: " +
      intent.provider +
      " / " +
      intent.scopeId,
    "Profile: " +
      intent.organization +
      " / " +
      intent.environment +
      " / " +
      intent.criticality,
    "RPO / RTO: " +
      profile.rpoMinutes +
      "m / " +
      profile.rtoMinutes +
      "m",
    "Retention: " +
      profile.retentionDays +
      " days",
    "Restore test: isolated preview; production mutation disabled.",
    intent.environment ===
      "DEVELOPMENT"
      ? "Production data is prohibited by default in this development profile."
      : "Production profile selected; promotion requires compiled policy review.",
    intent.compliancePacks
      ?.length
      ? "Compliance overlays requested: " +
        intent.compliancePacks.join(
          ", ",
        )
      : "Compliance overlays: none",
  ].join("\n");
}

export function recoveryTargetStatus(
  target: RecoveryTargetSpec,
): {
  ready: boolean;
  lines: string[];
} {
  const targetValidation =
    validateRecoveryTarget(target);
  const profileValidation =
    verifyCompiledRecoveryTarget(
      target,
    );
  const blockers = [
    ...targetValidation.blockers,
    ...profileValidation.blockers,
  ];

  if (blockers.length > 0) {
    return {
      ready: false,
      lines: [
        "Target " +
          target.targetId +
          ": BLOCKED",
        "Problem: " +
          blockers.join(" "),
        "Recommended fix: correct the target or recompile it from approved intent and evidence.",
        "Safe alternative: inspect the target with ./alz target explain before retrying.",
        "No infrastructure changes were made.",
      ],
    };
  }

  return {
    ready: true,
    lines: [
      "Target " +
        target.targetId +
        ": READY",
      target.recoveryMetadata
        ? "Compiled profile integrity: verified."
        : "Legacy target: valid; no compiled profile metadata is present.",
      "No infrastructure changes were made.",
    ],
  };
}

export function recoveryTestReadiness(
  target: RecoveryTargetSpec,
): {
  ready: boolean;
  lines: string[];
} {
  const status =
    recoveryTargetStatus(target);

  if (!status.ready) {
    return status;
  }

  if (!target.recoveryMetadata) {
    return {
      ready: false,
      lines: [
        "Target " +
          target.targetId +
          ": BLOCKED",
        "Problem: recovery test requires compiled recovery profile metadata.",
        "Recommended fix: compile the target from customer intent and the approved DesignSpec.",
        "Safe alternative: legacy recovery status remains available without running a restore test.",
        "No infrastructure changes were made.",
      ],
    };
  }

  return {
    ready: true,
    lines: [
      "Target " +
        target.targetId +
        ": READY FOR ISOLATED PREVIEW",
      "Restore mode: ISOLATED_PREVIEW.",
      "Production mutation: disabled.",
      "This command is a readiness preflight; the governed recovery service performs the evidence-backed drill when approved design evidence and externally granted capabilities are available.",
      "No infrastructure changes were made.",
    ],
  };
}
