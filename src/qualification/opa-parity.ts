import {
  evaluateBuiltinSecurityPolicy,
} from "../security/policy/builtin.js";
import type {
  SecurityPolicyDecision,
  SecurityPolicyInput,
} from "../security/policy/types.js";

export const PINNED_OPA_VERSION =
  "1.21.1";

export const PINNED_OPA_LINUX_AMD64_SHA256 =
  "23c654cdb52fc80c3f30e85c0c884a15f78a10173d0a5a060aa25eac15f48fbb";

export const OPA_DECISION_QUERY =
  "data.agent_landing_zone.security.decision";

const defaultHandling = {
  classification:
    "INTERNAL" as const,
  externalModelAllowed:
    false,
  externalStorageAllowed:
    false,
  secretMaterialAllowed:
    false as const,
  retentionClass:
    "STANDARD" as const,
};

export type OpaParityCase = {
  name: string;
  input: SecurityPolicyInput;
};

export const OPA_PARITY_CASES:
  OpaParityCase[] = [
    {
      name: "local-data-allowed",
      input: {
        kind: "DATA_HANDLING",
        handling:
          defaultHandling,
        destination:
          "LOCAL_MODEL",
        containsSecretMaterial:
          false,
      },
    },
    {
      name:
        "external-model-denied",
      input: {
        kind: "DATA_HANDLING",
        handling:
          defaultHandling,
        destination:
          "EXTERNAL_MODEL",
        containsSecretMaterial:
          false,
      },
    },
    {
      name:
        "external-storage-denied",
      input: {
        kind: "DATA_HANDLING",
        handling:
          defaultHandling,
        destination:
          "EXTERNAL_STORAGE",
        containsSecretMaterial:
          false,
      },
    },
    {
      name:
        "external-model-allowed",
      input: {
        kind: "DATA_HANDLING",
        handling: {
          ...defaultHandling,
          externalModelAllowed:
            true,
        },
        destination:
          "EXTERNAL_MODEL",
        containsSecretMaterial:
          false,
      },
    },
    {
      name:
        "secret-material-denied",
      input: {
        kind: "DATA_HANDLING",
        handling: {
          ...defaultHandling,
          externalModelAllowed:
            true,
        },
        destination:
          "EXTERNAL_MODEL",
        containsSecretMaterial:
          true,
      },
    },
    {
      name:
        "local-scheme-egress-allowed",
      input: {
        kind: "EGRESS",
        classification:
          "RESTRICTED",
        destination: {
          scheme: "local",
          host:
            "ignored.invalid",
          purpose:
            "local-runtime",
        },
        allowedHosts: [],
      },
    },
    {
      name:
        "normalized-loopback-egress-allowed",
      input: {
        kind: "EGRESS",
        classification:
          "INTERNAL",
        destination: {
          scheme: "http",
          host:
            " LOCALHOST ",
          purpose:
            "local-policy",
        },
        allowedHosts: [],
      },
    },
    {
      name:
        "nonallowlisted-egress-denied",
      input: {
        kind: "EGRESS",
        classification:
          "INTERNAL",
        destination: {
          scheme: "https",
          host:
            "example.invalid",
          purpose:
            "qualification",
        },
        allowedHosts: [],
      },
    },
    {
      name:
        "normalized-allowlisted-egress-allowed",
      input: {
        kind: "EGRESS",
        classification:
          "INTERNAL",
        destination: {
          scheme: "https",
          host:
            "EXAMPLE.INVALID ",
          purpose:
            "qualification",
        },
        allowedHosts: [
          " example.invalid",
        ],
      },
    },
    {
      name:
        "restricted-allowlisted-egress-denied",
      input: {
        kind: "EGRESS",
        classification:
          "RESTRICTED",
        destination: {
          scheme: "https",
          host:
            "example.invalid",
          purpose:
            "qualification",
        },
        allowedHosts: [
          "example.invalid",
        ],
      },
    },
    {
      name:
        "normal-capability-allowed",
      input: {
        kind: "CAPABILITY",
        compromiseState:
          "NORMAL",
        requested: [
          "CLOUD_READ",
          "BUILD_PREVIEW",
        ],
      },
    },
    {
      name:
        "suspected-safe-capability-allowed",
      input: {
        kind: "CAPABILITY",
        compromiseState:
          "SUSPECTED",
        requested: [
          "EVIDENCE_READ",
          "VALIDATE",
        ],
      },
    },
    {
      name:
        "suspected-cloud-read-denied",
      input: {
        kind: "CAPABILITY",
        compromiseState:
          "SUSPECTED",
        requested: [
          "CLOUD_READ",
        ],
      },
    },
    {
      name:
        "contained-evidence-write-denied",
      input: {
        kind: "CAPABILITY",
        compromiseState:
          "CONTAINED",
        requested: [
          "EVIDENCE_WRITE",
        ],
      },
    },
    {
      name:
        "recovery-cloud-read-allowed",
      input: {
        kind: "CAPABILITY",
        compromiseState:
          "RECOVERY",
        requested: [
          "CLOUD_READ",
          "VALIDATE",
        ],
      },
    },
    {
      name:
        "verified-preview-allowed",
      input: {
        kind: "CAPABILITY",
        compromiseState:
          "VERIFIED",
        requested: [
          "BUILD_PREVIEW",
        ],
      },
    },
    {
      name:
        "normal-automation-allowed",
      input: {
        kind: "AUTOMATION",
        compromiseState:
          "NORMAL",
        operation:
          "RECOVERY_VERIFY",
      },
    },
    {
      name:
        "suspected-automation-denied",
      input: {
        kind: "AUTOMATION",
        compromiseState:
          "SUSPECTED",
        operation:
          "RECOVERY_VERIFY",
      },
    },
    {
      name:
        "contained-automation-denied",
      input: {
        kind: "AUTOMATION",
        compromiseState:
          "CONTAINED",
        operation:
          "RECOVERY_DRILL",
      },
    },
  ];

export type OpaEvalEnvelope = {
  result?: Array<{
    expressions?: Array<{
      value?: {
        allow?: boolean;
        reasons?: string[];
        obligations?: string[];
      };
    }>;
  }>;
};

export function parseOpaEvalDecision(
  raw: string,
): SecurityPolicyDecision {
  const payload =
    JSON.parse(
      raw,
    ) as OpaEvalEnvelope;
  const value =
    payload.result?.[0]
      ?.expressions?.[0]
      ?.value;

  if (
    typeof value?.allow !==
      "boolean" ||
    !Array.isArray(
      value.reasons,
    ) ||
    !Array.isArray(
      value.obligations,
    )
  ) {
    throw new Error(
      "OPA_PARITY_RESULT_INVALID",
    );
  }

  return {
    allow: value.allow,
    reasons: value.reasons,
    obligations:
      value.obligations,
    source: "OPA",
  };
}

export function parseOpaVersion(
  raw: string,
): string {
  const match =
    raw.match(
      /Version:\s*v?([0-9]+\.[0-9]+\.[0-9]+)/i,
    );

  if (!match) {
    throw new Error(
      "OPA_VERSION_UNREADABLE",
    );
  }

  return match[1];
}

export type PolicyParity = {
  allow: boolean;
  reasons: boolean;
  obligations: boolean;
  strict: boolean;
};

export function comparePolicyDecisions(
  builtin:
    SecurityPolicyDecision,
  opa:
    SecurityPolicyDecision,
): PolicyParity {
  const allow =
    builtin.allow ===
    opa.allow;
  const reasons =
    JSON.stringify(
      builtin.reasons,
    ) ===
    JSON.stringify(
      opa.reasons,
    );
  const obligations =
    JSON.stringify(
      builtin.obligations,
    ) ===
    JSON.stringify(
      opa.obligations,
    );

  return {
    allow,
    reasons,
    obligations,
    strict:
      allow &&
      reasons &&
      obligations,
  };
}

export type OpaParityQualification = {
  version: string;
  versionMatch: boolean;
  cases: Array<{
    name: string;
    builtin:
      SecurityPolicyDecision;
    opa:
      SecurityPolicyDecision;
    parity:
      PolicyParity;
  }>;
  passed: boolean;
};

export function qualifyOpaParity(input: {
  version: string;
  decisions:
    Record<
      string,
      SecurityPolicyDecision
    >;
}): OpaParityQualification {
  const cases =
    OPA_PARITY_CASES.map(
      (testCase) => {
        const builtin =
          evaluateBuiltinSecurityPolicy(
            testCase.input,
          );
        const opa =
          input.decisions[
            testCase.name
          ];

        if (!opa) {
          const missing:
            SecurityPolicyDecision = {
              allow: false,
              reasons: [
                "OPA parity evidence missing.",
              ],
              obligations: [],
              source: "OPA",
            };

          return {
            name:
              testCase.name,
            builtin,
            opa: missing,
            parity:
              comparePolicyDecisions(
                builtin,
                missing,
              ),
          };
        }

        return {
          name:
            testCase.name,
          builtin,
          opa,
          parity:
            comparePolicyDecisions(
              builtin,
              opa,
            ),
        };
      },
    );

  const versionMatch =
    input.version ===
    PINNED_OPA_VERSION;

  return {
    version: input.version,
    versionMatch,
    cases,
    passed:
      versionMatch &&
      cases.every(
        (item) =>
          item.parity.strict,
      ),
  };
}
