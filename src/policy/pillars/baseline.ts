import type {
  DiscoveryAssessment,
  PostureStatus,
} from "../../assessment/types.js";
import { sha256 } from "../../build/provenance.js";
import type {
  EnvironmentState,
} from "../../discovery/types.js";
import type {
  PillarPolicy,
  PillarPolicyBundle,
  PillarStatus,
  PolicyRequirement,
} from "./types.js";

function mapPosture(
  status: PostureStatus,
): PillarStatus {
  switch (status) {
    case "SECURE":
      return "SATISFIED";
    case "INSECURE":
      return "VIOLATED";
    case "PARTIAL":
      return "PARTIAL";
    case "UNKNOWN":
      return "UNKNOWN";
  }
}

function combineStatus(
  requirements: PolicyRequirement[],
): PillarStatus {
  if (
    requirements.some(
      (requirement) =>
        requirement.status === "VIOLATED",
    )
  ) {
    return "VIOLATED";
  }

  if (
    requirements.every(
      (requirement) =>
        requirement.status === "SATISFIED",
    )
  ) {
    return "SATISFIED";
  }

  if (
    requirements.every(
      (requirement) =>
        requirement.status === "UNKNOWN",
    )
  ) {
    return "UNKNOWN";
  }

  return "PARTIAL";
}

function makePolicy(
  pillar: PillarPolicy["pillar"],
  requirements: PolicyRequirement[],
): PillarPolicy {
  const controls = [
    ...new Set(
      requirements.flatMap(
        (requirement) =>
          requirement.controls,
      ),
    ),
  ].sort();

  const evidenceRefs = [
    ...new Set(
      requirements.flatMap(
        (requirement) =>
          requirement.evidenceRefs,
      ),
    ),
  ].sort();

  const unknowns = requirements
    .filter(
      (requirement) =>
        requirement.status === "UNKNOWN",
    )
    .map(
      (requirement) =>
        requirement.description,
    )
    .sort();

  return {
    pillar,
    status: combineStatus(requirements),
    requirements,
    controls,
    evidenceRefs,
    unknowns,
  };
}

function evidenceMatching(
  environment: EnvironmentState,
  tokens: string[],
): string[] {
  return environment.evidence
    .filter((item) => {
      const key =
        item.key.toLowerCase();
      const value =
        item.value.toLowerCase();

      return (
        item.value !== "unknown" &&
        tokens.some(
          (token) =>
            key.includes(token) ||
            value.includes(token),
        )
      );
    })
    .map(
      (item) =>
        item.source + ":" + item.key,
    );
}

function securityPolicy(
  assessment: DiscoveryAssessment,
): PillarPolicy {
  const requirement: PolicyRequirement = {
    id: "security-posture",
    description:
      "Security posture must be evidence-backed and free of unresolved high-impact findings.",
    status:
      mapPosture(
        assessment.securityStatus,
      ),
    evidenceRefs:
      assessment.evidenceRefs,
    controls: assessment.findings.map(
      (finding) =>
        finding.severity +
        " " +
        finding.domain +
        ": " +
        finding.title,
    ),
  };

  return makePolicy(
    "SECURITY",
    [requirement],
  );
}

function costPolicy(
  environment: EnvironmentState,
): PillarPolicy {
  const requiredTags = [
    "owner",
    "cost-center",
    "environment",
  ];

  const resourceTagEvidence =
    environment.resources.map(
      (resource) =>
        "resource:" + resource.resourceId,
    );

  const taggedResources =
    environment.resources.filter(
      (resource) => {
        const tags = Object.fromEntries(
          Object.entries(
            resource.tags ?? {},
          ).map(([key, value]) => [
            key.toLowerCase(),
            value,
          ]),
        );

        return requiredTags.every(
          (key) =>
            Boolean(tags[key]),
        );
      },
    ).length;

  const taggingStatus: PillarStatus =
    environment.resources.length === 0
      ? "UNKNOWN"
      : taggedResources ===
          environment.resources.length
        ? "SATISFIED"
        : "PARTIAL";

  const budgetEvidence =
    evidenceMatching(
      environment,
      [
        "budget",
        "cost_anomaly",
        "cost-anomaly",
      ],
    );

  const costImpactEvidence =
    evidenceMatching(
      environment,
      [
        "cost_estimate",
        "cost-impact",
        "cost_impact",
      ],
    );

  return makePolicy("COST", [
    {
      id: "cost-allocation-tags",
      description:
        "Accelerator-managed additions must carry ownership, cost-center, and environment allocation tags.",
      status: taggingStatus,
      evidenceRefs:
        resourceTagEvidence,
      controls: [
        "Require owner, cost-center, and environment tags on accelerator-managed additions.",
        "Preserve existing customer tags on reused resources.",
      ],
    },
    {
      id: "budget-and-anomaly-governance",
      description:
        "Budget or cost-anomaly governance must be evidenced before production acceptance.",
      status:
        budgetEvidence.length > 0
          ? "SATISFIED"
          : "UNKNOWN",
      evidenceRefs: budgetEvidence,
      controls: [
        "Require an explicit budget or cost-anomaly policy for production scope.",
      ],
    },
    {
      id: "cost-impact-evidence",
      description:
        "Material additions require evidence of expected cost impact.",
      status:
        costImpactEvidence.length > 0
          ? "SATISFIED"
          : "UNKNOWN",
      evidenceRefs:
        costImpactEvidence,
      controls: [
        "Do not invent cloud spend; require provider, pricing, or approved estimate evidence for cost claims.",
      ],
    },
  ]);
}

function resiliencyPolicy(
  assessment: DiscoveryAssessment,
): PillarPolicy {
  const recoveryCoverage =
    assessment.recoverySnapshot.coverage;

  const recoveryStatus: PillarStatus =
    assessment.resiliency.restoreEvidence ===
      "VERIFIED" &&
    recoveryCoverage === "FULL"
      ? "SATISFIED"
      : recoveryCoverage ===
          "MANIFEST_ONLY" ||
        recoveryCoverage ===
          "CONFIGURATION_EXPORT"
        ? "PARTIAL"
        : "UNKNOWN";

  const rpoRtoStatus: PillarStatus =
    assessment.resiliency.rpoKnown &&
    assessment.resiliency.rtoKnown
      ? "SATISFIED"
      : "UNKNOWN";

  return makePolicy("RESILIENCY", [
    {
      id: "recoverability",
      description:
        "Platform configuration recovery must be backed by recoverable artifacts and verified restore evidence.",
      status: recoveryStatus,
      evidenceRefs:
        assessment.resiliency
          .evidenceRefs,
      controls: [
        "Do not treat an inventory manifest as a backup.",
        "Require recovery-point verification and restore evidence before claiming recoverability.",
      ],
    },
    {
      id: "rpo-rto",
      description:
        "RPO and RTO must be explicitly known or remain UNKNOWN.",
      status: rpoRtoStatus,
      evidenceRefs:
        assessment.resiliency
          .evidenceRefs,
      controls: [
        "Do not invent RPO or RTO values.",
      ],
    },
  ]);
}

function reliabilityPolicy(
  environment: EnvironmentState,
  assessment: DiscoveryAssessment,
): PillarPolicy {
  const redundancyStatus: PillarStatus =
    assessment.resiliency
      .redundantControlPlane === "PRESENT"
      ? "SATISFIED"
      : assessment.resiliency
            .redundantControlPlane ===
          "MISSING"
        ? "VIOLATED"
        : "UNKNOWN";

  const availabilityEvidence =
    evidenceMatching(
      environment,
      [
        "availability_target",
        "availability-target",
        "availability_slo",
      ],
    );

  return makePolicy("RELIABILITY", [
    {
      id: "failure-domain-redundancy",
      description:
        "Required control-plane and workload failure-domain redundancy must be evidenced.",
      status: redundancyStatus,
      evidenceRefs:
        assessment.resiliency
          .evidenceRefs,
      controls: [
        "Record required failure domains before accepting a production design.",
        "Do not assume multi-zone or multi-region coverage without evidence.",
      ],
    },
    {
      id: "availability-objective",
      description:
        "Availability objectives must be explicit and evidence-backed.",
      status:
        availabilityEvidence.length >
        0
          ? "SATISFIED"
          : "UNKNOWN",
      evidenceRefs:
        availabilityEvidence,
      controls: [
        "Do not invent an availability SLA or SLO.",
      ],
    },
  ]);
}

function performancePolicy(
  environment: EnvironmentState,
): PillarPolicy {
  const objectiveEvidence =
    evidenceMatching(
      environment,
      [
        "latency",
        "throughput",
        "performance_objective",
        "performance-target",
      ],
    );

  const utilizationEvidence =
    evidenceMatching(
      environment,
      [
        "utilization",
        "capacity",
        "benchmark",
      ],
    );

  return makePolicy("PERFORMANCE", [
    {
      id: "measurable-performance-objective",
      description:
        "Performance objectives must be measurable before optimization claims are accepted.",
      status:
        objectiveEvidence.length > 0
          ? "SATISFIED"
          : "UNKNOWN",
      evidenceRefs:
        objectiveEvidence,
      controls: [
        "Require measurable latency, throughput, or workload objectives for production optimization.",
      ],
    },
    {
      id: "capacity-evidence",
      description:
        "Sizing and scaling decisions require benchmark, utilization, or capacity evidence.",
      status:
        utilizationEvidence.length > 0
          ? "SATISFIED"
          : "UNKNOWN",
      evidenceRefs:
        utilizationEvidence,
      controls: [
        "Do not increase instance or service size without workload evidence.",
        "Record scaling boundaries when variable demand is expected.",
      ],
    },
  ]);
}

function sustainabilityPolicy(
  environment: EnvironmentState,
): PillarPolicy {
  const efficiencyEvidence =
    evidenceMatching(
      environment,
      [
        "rightsizing",
        "right-sizing",
        "utilization",
        "idle_resource",
        "idle-resource",
      ],
    );

  const lifecycleEvidence =
    evidenceMatching(
      environment,
      [
        "lifecycle",
        "retention",
        "shutdown_schedule",
        "shutdown-schedule",
      ],
    );

  return makePolicy(
    "SUSTAINABILITY",
    [
      {
        id: "resource-efficiency",
        description:
          "Resource-efficiency recommendations require utilization or right-sizing evidence.",
        status:
          efficiencyEvidence.length >
          0
            ? "SATISFIED"
            : "UNKNOWN",
        evidenceRefs:
          efficiencyEvidence,
        controls: [
          "Prefer right-sized and elastic resources when supported by workload evidence.",
          "Evaluate idle non-production resources before recommending continuous operation.",
        ],
      },
      {
        id: "resource-lifecycle",
        description:
          "Storage and non-production lifecycle behavior should be explicitly governed.",
        status:
          lifecycleEvidence.length >
          0
            ? "SATISFIED"
            : "UNKNOWN",
        evidenceRefs:
          lifecycleEvidence,
        controls: [
          "Require lifecycle or retention intent where resources can accumulate indefinitely.",
          "Require provider evidence before making carbon-intensity claims.",
        ],
      },
    ],
  );
}

export function createPillarPolicyBundle(input: {
  environment: EnvironmentState;
  assessment: DiscoveryAssessment;
}): PillarPolicyBundle {
  const normalized = {
    version: "1" as const,
    security:
      securityPolicy(
        input.assessment,
      ),
    cost:
      costPolicy(
        input.environment,
      ),
    resiliency:
      resiliencyPolicy(
        input.assessment,
      ),
    reliability:
      reliabilityPolicy(
        input.environment,
        input.assessment,
      ),
    performance:
      performancePolicy(
        input.environment,
      ),
    sustainability:
      sustainabilityPolicy(
        input.environment,
      ),
  };

  const bundleHash =
    sha256(JSON.stringify(normalized));

  return {
    ...normalized,
    bundleId:
      "policy-" +
      bundleHash.slice(0, 12),
    bundleHash,
  };
}
