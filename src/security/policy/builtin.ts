import type {
  SovereignCapability,
} from "../../orchestration/types.js";
import type {
  CompromiseState,
  SecurityPolicyDecision,
  SecurityPolicyEvaluator,
  SecurityPolicyInput,
} from "./types.js";

function decision(
  allow: boolean,
  reasons: string[],
  obligations: string[] = [],
): SecurityPolicyDecision {
  return {
    allow,
    reasons,
    obligations,
    source: "BUILTIN",
  };
}

export function capabilitiesForCompromiseState(
  state: CompromiseState,
): SovereignCapability[] {
  switch (state) {
    case "NORMAL":
    case "VERIFIED":
      return [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
        "CLOUD_READ",
        "PROJECT_CODE_EXECUTION",
        "PREVIEW_WRITE",
        "MANAGED_ACCESS",
        "DESIGN",
        "BUILD_PREVIEW",
        "VALIDATE",
      ];

    case "SUSPECTED":
      return [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
        "VALIDATE",
      ];

    case "CONTAINED":
      return [
        "EVIDENCE_READ",
        "VALIDATE",
      ];

    case "RECOVERY":
      return [
        "EVIDENCE_READ",
        "EVIDENCE_WRITE",
        "CLOUD_READ",
        "VALIDATE",
      ];
  }
}

function evaluateBuiltin(
  input: SecurityPolicyInput,
): SecurityPolicyDecision {
  if (
    input.kind === "DATA_HANDLING"
  ) {
    if (
      input.containsSecretMaterial
    ) {
      return decision(
        false,
        [
          "Secret material cannot enter model, storage, or operator-output policy flows.",
        ],
        [
          "Replace secret value with an opaque secret reference and metadata.",
        ],
      );
    }

    if (
      input.destination ===
        "EXTERNAL_MODEL" &&
      !input.handling
        .externalModelAllowed
    ) {
      return decision(
        false,
        [
          "Data classification policy does not permit external-model processing.",
        ],
      );
    }

    if (
      input.destination ===
        "EXTERNAL_STORAGE" &&
      !input.handling
        .externalStorageAllowed
    ) {
      return decision(
        false,
        [
          "Data classification policy does not permit external storage.",
        ],
      );
    }

    return decision(
      true,
      [],
      [
        "Preserve classification and provenance metadata.",
      ],
    );
  }

  if (input.kind === "EGRESS") {
    const host =
      input.destination.host
        .trim()
        .toLowerCase();

    if (
      input.destination.scheme ===
        "local" ||
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1"
    ) {
      return decision(true, []);
    }

    const allowed =
      new Set(
        input.allowedHosts.map(
          (value) =>
            value
              .trim()
              .toLowerCase(),
        ),
      );

    if (!allowed.has(host)) {
      return decision(
        false,
        [
          "Destination is not on the explicit egress allowlist.",
        ],
      );
    }

    if (
      input.classification ===
        "RESTRICTED"
    ) {
      return decision(
        false,
        [
          "Restricted data cannot use external egress in the baseline policy.",
        ],
      );
    }

    return decision(true, []);
  }

  if (
    input.kind === "CAPABILITY"
  ) {
    const allowed =
      new Set(
        capabilitiesForCompromiseState(
          input.compromiseState,
        ),
      );

    const denied =
      input.requested.filter(
        (capability) =>
          !allowed.has(capability),
      );

    return denied.length === 0
      ? decision(true, [])
      : decision(
          false,
          [
            "Compromise state denies capabilities: " +
              denied.join(", ") +
              ".",
          ],
          [
            "Re-establish a VERIFIED state before restoring denied capabilities.",
          ],
        );
  }

  if (
    input.compromiseState ===
      "SUSPECTED" ||
    input.compromiseState ===
      "CONTAINED"
  ) {
    return decision(
      false,
      [
        "Scheduled automation is suspended while compromise is suspected or contained.",
      ],
      [
        "Preserve evidence and require explicit recovery-state transition.",
      ],
    );
  }

  return decision(true, []);
}

export class BuiltinSecurityPolicyEvaluator
  implements SecurityPolicyEvaluator
{
  async evaluate(
    input: SecurityPolicyInput,
  ): Promise<SecurityPolicyDecision> {
    return evaluateBuiltin(input);
  }
}

export function evaluateBuiltinSecurityPolicy(
  input: SecurityPolicyInput,
): SecurityPolicyDecision {
  return evaluateBuiltin(input);
}
