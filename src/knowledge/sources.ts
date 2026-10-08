import type {
  KnowledgeSource,
  KnowledgeSourceId,
} from "./types.js";

export const KNOWLEDGE_SOURCES:
  KnowledgeSource[] = [
    {
      id:
        "SOVEREIGN_LZ_CORPUS",
      sourceClass:
        "INTERNAL_CORPUS",
      canonicalUri:
        "repo://docs/positioning/sovereign-lz-corpus.md",
      trust: "INTERNAL",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        false,
      ingestIncludes: [
        "product thesis",
        "problem set",
        "well-architected pillars",
        "sovereignty boundaries",
        "execution corpus",
      ],
      notes:
        "Internal canonical product/architecture corpus.",
    },
    {
      id:
        "TERRAFORM_REGISTRY",
      sourceClass:
        "DYNAMIC_REGISTRY",
      canonicalUri:
        "https://registry.terraform.io/",
      trust:
        "COMMUNITY_MIXED",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        true,
      ingestIncludes: [
        "providers",
        "modules",
        "policies",
        "versions",
        "publisher namespaces",
        "provider tiers",
        "documentation",
        "registry metadata",
      ],
      notes:
        "Public registry content is mixed-trust. Admission requires publisher/tier, version, maintenance and provenance evaluation; archived entries must not be treated as production defaults.",
    },
    {
      id:
        "PULUMI_REGISTRY",
      sourceClass:
        "DYNAMIC_REGISTRY",
      canonicalUri:
        "https://www.pulumi.com/registry/",
      trust:
        "COMMUNITY_MIXED",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        true,
      ingestIncludes: [
        "packages",
        "providers",
        "components",
        "package schemas",
        "resources",
        "functions",
        "types",
        "publisher",
        "version",
        "source",
        "deprecation state",
      ],
      notes:
        "Pulumi Registry packages may be native, bridged from Terraform/OpenTofu, private, or community-published. Package schema is the language-neutral ingestion boundary.",
    },
    {
      id:
        "PYTHON_STDLIB",
      sourceClass:
        "LANGUAGE_REFERENCE",
      canonicalUri:
        "https://docs.python.org/3/library/index.html",
      trust:
        "AUTHORITATIVE",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        true,
      ingestIncludes: [
        "standard-library modules",
        "APIs",
        "availability notes",
        "security warnings",
        "version/deprecation information",
      ],
      notes:
        "Official Python standard-library reference. Ingestion is version-bound because availability and behavior can vary by Python release and platform.",
    },
    {
      id:
        "AZURE_VERIFIED_MODULES",
      sourceClass:
        "VERIFIED_MODULE_CATALOG",
      canonicalUri:
        "https://azure.github.io/Azure-Verified-Modules/module-indexes/v1/modules.json",
      trust:
        "PRIMARY_VENDOR",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        true,
      ingestIncludes: [
        "Bicep resource modules",
        "Terraform AVM modules",
        "module lifecycle state",
        "module type",
        "owners",
        "canonical resource type",
        "registry reference",
        "current version",
        "repository metadata",
        "telemetry identifiers",
        "module specifications",
      ],
      notes:
        "Microsoft/Azure curated AVM catalog. Available, proposed, orphaned and deprecated lifecycle states must remain distinct; only accepted lifecycle states are eligible for production selection.",
    },
    {
      id:
        "NIST_AI_RMF",
      sourceClass:
        "GOVERNANCE_STANDARD",
      canonicalUri:
        "https://www.nist.gov/itl/ai-risk-management-framework",
      trust:
        "AUTHORITATIVE",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        true,
      ingestIncludes: [
        "governance",
        "map",
        "measure",
        "manage",
        "AI risk controls",
      ],
      notes:
        "Governance reference; local snapshots are evidence inputs, not compliance certification.",
    },
    {
      id:
        "NIST_ZERO_TRUST",
      sourceClass:
        "GOVERNANCE_STANDARD",
      canonicalUri:
        "https://www.nist.gov/publications/zero-trust-architecture",
      trust:
        "AUTHORITATIVE",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        true,
      ingestIncludes: [
        "identity",
        "resource authorization",
        "policy enforcement",
        "least privilege",
        "multi-location zero trust",
      ],
      notes:
        "Zero-trust reference for identity, authorization and distributed control boundaries.",
    },
    {
      id:
        "OWASP_AGENT_SECURITY",
      sourceClass:
        "SECURITY_GUIDANCE",
      canonicalUri:
        "https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html",
      trust:
        "AUTHORITATIVE",
      dynamic: true,
      runtimeInternetRequired:
        false,
      mirrorRequiredForPrivateSovereign:
        true,
      ingestIncludes: [
        "agent authorization",
        "tool security",
        "human approval",
        "memory security",
        "prompt-injection controls",
        "auditability",
      ],
      notes:
        "Security guidance used to challenge agentic control-plane designs.",
    },
  ];

export function knowledgeSource(
  id: KnowledgeSourceId,
): KnowledgeSource {
  const source =
    KNOWLEDGE_SOURCES.find(
      (candidate) =>
        candidate.id === id,
    );

  if (!source) {
    throw new Error(
      "KNOWLEDGE_SOURCE_UNKNOWN: " +
        id,
    );
  }

  return source;
}
