import {
  buildKnowledgeSnapshot,
} from "./ingest.js";
import type {
  KnowledgeRecord,
  KnowledgeSnapshot,
} from "./types.js";

const RETRIEVED_AT =
  "2026-10-08T02:15:00.000Z";

function sourceFact(
  recordId: string,
  title: string,
  metadata:
    Record<string, unknown>,
): KnowledgeRecord {
  return {
    recordId,
    kind: "SOURCE_FACT",
    title,
    metadata,
  };
}

export const BASELINE_KNOWLEDGE_SNAPSHOTS:
  KnowledgeSnapshot[] = [
    buildKnowledgeSnapshot({
      sourceId:
        "TERRAFORM_REGISTRY",
      sourceUri:
        "https://registry.terraform.io/",
      retrievedAt:
        RETRIEVED_AT,
      sourceVersion:
        "baseline-2026-10-07",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://terraform-registry/baseline-2026-10-07",
      records: [
        sourceFact(
          "terraform-registry:admission",
          "Terraform Registry admission boundary",
          {
            artifactKinds: [
              "provider",
              "module",
              "policy",
            ],
            requiredChecks: [
              "publisher",
              "version",
              "maintenance-state",
              "provenance",
              "previewability",
              "sovereignty-compatibility",
            ],
            runtimeInternetRequired:
              false,
          },
        ),
      ],
    }),
    buildKnowledgeSnapshot({
      sourceId:
        "PULUMI_REGISTRY",
      sourceUri:
        "https://www.pulumi.com/registry/",
      retrievedAt:
        RETRIEVED_AT,
      sourceVersion:
        "baseline-2026-10-07",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://pulumi-registry/baseline-2026-10-07",
      records: [
        sourceFact(
          "pulumi-registry:schema-boundary",
          "Pulumi Registry package schema boundary",
          {
            artifactKinds: [
              "package",
              "provider",
              "component",
            ],
            schemaIncludes: [
              "resources",
              "functions",
              "types",
              "version",
              "publisher",
              "source",
              "deprecation-state",
            ],
            runtimeInternetRequired:
              false,
          },
        ),
      ],
    }),
    buildKnowledgeSnapshot({
      sourceId:
        "PYTHON_STDLIB",
      sourceUri:
        "https://docs.python.org/3/library/index.html",
      retrievedAt:
        RETRIEVED_AT,
      sourceVersion: "3",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://python-stdlib/3",
      records: [
        ...[
          "subprocess",
          "sqlite3",
          "hashlib",
          "hmac",
          "secrets",
          "ssl",
          "logging",
          "asyncio",
          "concurrent.futures",
          "contextvars",
          "pathlib",
          "tomllib",
          "importlib.metadata",
          "uuid",
          "sys",
        ].map(
          (
            module,
          ): KnowledgeRecord => ({
            recordId:
              "python-stdlib:" +
              module,
            kind:
              "LIBRARY_MODULE",
            title: module,
            publisher:
              "Python Software Foundation",
            classification:
              "STANDARD_LIBRARY",
            sourceRef:
              "https://docs.python.org/3/library/" +
              module.replace(
                ".",
                ".",
              ) +
              ".html",
            metadata: {
              preferred:
                true,
              runtimeInternetRequired:
                false,
            },
          }),
        ),
      ],
    }),
    buildKnowledgeSnapshot({
      sourceId:
        "AZURE_BICEP_REGISTRY_MODULES",
      sourceUri:
        "https://github.com/Azure/bicep-registry-modules",
      retrievedAt:
        RETRIEVED_AT,
      sourceVersion:
        "4cb06c258d90a26a21c79e7cb04fd138e87e32dd",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://github/Azure/bicep-registry-modules/4cb06c258d90a26a21c79e7cb04fd138e87e32dd",
      records: [
        sourceFact(
          "azure-bicep-registry-modules:repository",
          "Azure Bicep Registry Modules pinned source",
          {
            commit:
              "4cb06c258d90a26a21c79e7cb04fd138e87e32dd",
            readmeBlob:
              "5e9b72027476ad1e5be861f5a80195a7ae141d90",
            treeEntries: 8298,
            standard:
              "Azure Verified Modules",
            license: "MIT",
          },
        ),
        ...[
          "avm/res/authorization/policy-assignment",
          "avm/res/authorization/role-assignment",
          "avm/res/consumption/budget",
          "avm/res/insights/diagnostic-setting",
          "avm/res/insights/metric-alert",
          "avm/res/container-service/managed-cluster",
          "avm/res/edge/site",
        ].map(
          (
            path,
          ): KnowledgeRecord => ({
            recordId:
              "azure-bicep:" +
              path,
            kind: "MODULE",
            title: path,
            publisher: "Microsoft",
            classification:
              "AVM_BICEP_MODULE",
            sourceRef: path,
            metadata: {
              commit:
                "4cb06c258d90a26a21c79e7cb04fd138e87e32dd",
            },
          }),
        ),
      ],
    }),
    buildKnowledgeSnapshot({
      sourceId: "AWS_CDK",
      sourceUri:
        "https://github.com/aws/aws-cdk",
      retrievedAt:
        RETRIEVED_AT,
      sourceVersion:
        "2915b0db6cb799fe517be4df147d7f8ec5f9a888",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://github/aws/aws-cdk/2915b0db6cb799fe517be4df147d7f8ec5f9a888",
      records: [
        sourceFact(
          "aws-cdk:repository",
          "AWS CDK pinned source",
          {
            commit:
              "2915b0db6cb799fe517be4df147d7f8ec5f9a888",
            readmeBlob:
              "3a0cb156ad37015f20124225499fd1a14aa3ab3a",
            treeEntries:
              35598,
            synthesis:
              "CloudFormation",
            license:
              "Apache-2.0",
          },
        ),
        ...[
          "aws-accessanalyzer",
          "aws-agentregistry",
          "aws-aiops",
          "aws-appconfig",
          "aws-apigateway",
          "aws-apigatewayv2",
        ].map(
          (
            service,
          ): KnowledgeRecord => ({
            recordId:
              "aws-cdk:" +
              service,
            kind: "MODULE",
            title: service,
            publisher: "AWS",
            classification:
              "AWS_CONSTRUCT_LIBRARY",
            sourceRef:
              "packages/aws-cdk-lib/" +
              service,
            metadata: {
              commit:
                "2915b0db6cb799fe517be4df147d7f8ec5f9a888",
            },
          }),
        ),
      ],
    }),
    buildKnowledgeSnapshot({
      sourceId: "PULUMI_CORE",
      sourceUri:
        "https://github.com/pulumi/pulumi",
      retrievedAt:
        RETRIEVED_AT,
      sourceVersion:
        "887e0dd5cba36cdabbab8821f6666be13abfa18d",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://github/pulumi/pulumi/887e0dd5cba36cdabbab8821f6666be13abfa18d",
      records: [
        sourceFact(
          "pulumi-core:repository",
          "Pulumi core pinned source",
          {
            commit:
              "887e0dd5cba36cdabbab8821f6666be13abfa18d",
            treeEntries:
              45991,
            license:
              "Apache-2.0",
            primaryAreas: [
              "pkg/backend",
              "pkg/engine",
              "pkg/resource",
              "pkg/workspace",
              "sdk/go",
              "sdk/nodejs",
              "sdk/python",
              "sdk/proto",
            ],
          },
        ),
      ],
    }),
  ];
