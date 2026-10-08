import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_KNOWLEDGE_SNAPSHOTS,
} from "../src/knowledge/baseline.js";
import {
  buildKnowledgeSnapshot,
  ingestKnowledgeSnapshot,
  requireKnowledgeSnapshot,
  snapshotIds,
} from "../src/knowledge/ingest.js";
import {
  KNOWLEDGE_SOURCES,
  knowledgeSource,
} from "../src/knowledge/sources.js";

test("engineering ingestion estate registers user-supplied registry, language, and source repositories", () => {
  const ids =
    new Set(
      KNOWLEDGE_SOURCES.map(
        (source) => source.id,
      ),
    );

  for (const id of [
    "TERRAFORM_REGISTRY",
    "PULUMI_REGISTRY",
    "PULUMI_CORE",
    "PYTHON_STDLIB",
    "AZURE_BICEP_REGISTRY_MODULES",
    "AWS_CDK",
  ] as const) {
    assert.equal(
      ids.has(id),
      true,
    );
  }
});

test("baseline knowledge snapshots are hash-valid and private-sovereign mirror safe", () => {
  for (const snapshot of
    BASELINE_KNOWLEDGE_SNAPSHOTS) {
    const result =
      requireKnowledgeSnapshot(
        snapshot,
        {
          privateSovereign:
            true,
        },
      );

    assert.equal(
      result.accepted,
      true,
    );
    assert.equal(
      result.recordCount > 0,
      true,
    );
    assert.match(
      snapshot.sha256,
      /^[a-f0-9]{64}$/,
    );
    assert.match(
      snapshot.localMirrorRef ?? "",
      /^(mirror|repo|file):\/\//,
    );
  }
});

test("baseline includes exact pinned source revisions for Azure Bicep modules AWS CDK and Pulumi core", () => {
  const byId =
    Object.fromEntries(
      BASELINE_KNOWLEDGE_SNAPSHOTS.map(
        (snapshot) => [
          snapshot.sourceId,
          snapshot,
        ],
      ),
    );

  assert.equal(
    byId
      .AZURE_BICEP_REGISTRY_MODULES
      ?.sourceVersion,
    "4cb06c258d90a26a21c79e7cb04fd138e87e32dd",
  );
  assert.equal(
    byId.AWS_CDK
      ?.sourceVersion,
    "2915b0db6cb799fe517be4df147d7f8ec5f9a888",
  );
  assert.equal(
    byId.PULUMI_CORE
      ?.sourceVersion,
    "887e0dd5cba36cdabbab8821f6666be13abfa18d",
  );
});

test("baseline captures current Python and registry seeds used by the accelerator", () => {
  const python =
    BASELINE_KNOWLEDGE_SNAPSHOTS.find(
      (snapshot) =>
        snapshot.sourceId ===
        "PYTHON_STDLIB",
    );
  const terraform =
    BASELINE_KNOWLEDGE_SNAPSHOTS.find(
      (snapshot) =>
        snapshot.sourceId ===
        "TERRAFORM_REGISTRY",
    );
  const pulumi =
    BASELINE_KNOWLEDGE_SNAPSHOTS.find(
      (snapshot) =>
        snapshot.sourceId ===
        "PULUMI_REGISTRY",
    );

  assert.equal(
    python?.sourceVersion,
    "3.14.8",
  );

  const terraformTitles =
    new Set(
      terraform?.records.map(
        (record) =>
          record.title,
      ),
    );

  for (const provider of [
    "hashicorp/aws",
    "hashicorp/azurerm",
    "hashicorp/kubernetes",
  ]) {
    assert.equal(
      terraformTitles.has(
        provider,
      ),
      true,
    );
  }

  const pulumiFact =
    pulumi?.records.find(
      (record) =>
        record.recordId ===
        "pulumi-registry:schema-boundary",
    );

  assert.deepEqual(
    pulumiFact?.metadata
      .featuredPackages,
    [
      "AWS",
      "Azure Native",
      "Google Cloud",
      "Kubernetes",
    ],
  );
});

test("source registrations never require internet at runtime", () => {
  assert.equal(
    KNOWLEDGE_SOURCES.every(
      (source) =>
        source
          .runtimeInternetRequired ===
        false,
    ),
    true,
  );
});

test("private-sovereign ingestion fails closed without a local mirror", () => {
  const snapshot =
    buildKnowledgeSnapshot({
      sourceId:
        "AWS_CDK",
      sourceUri:
        knowledgeSource(
          "AWS_CDK",
        ).canonicalUri,
      retrievedAt:
        "2026-10-08T02:15:00.000Z",
      sourceVersion:
        "2915b0db6cb799fe517be4df147d7f8ec5f9a888",
      contentType:
        "application/json",
      records: [
        {
          recordId:
            "aws-cdk:test",
          kind:
            "SOURCE_FACT",
          title: "test",
          metadata: {},
        },
      ],
    });

  const result =
    ingestKnowledgeSnapshot(
      snapshot,
      {
        privateSovereign:
          true,
      },
    );

  assert.equal(
    result.accepted,
    false,
  );
  assert.match(
    result.reasons.join(" "),
    /local mirror/,
  );
});

test("tampered snapshots and credential-like metadata are rejected", () => {
  const valid =
    buildKnowledgeSnapshot({
      sourceId:
        "PULUMI_CORE",
      sourceUri:
        knowledgeSource(
          "PULUMI_CORE",
        ).canonicalUri,
      retrievedAt:
        "2026-10-08T02:15:00.000Z",
      sourceVersion:
        "887e0dd5cba36cdabbab8821f6666be13abfa18d",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://github/pulumi/pulumi/test",
      records: [
        {
          recordId:
            "pulumi:test",
          kind:
            "SOURCE_FACT",
          title: "test",
          metadata: {},
        },
      ],
    });

  const tampered = {
    ...valid,
    sha256:
      "0".repeat(64),
  };

  assert.equal(
    ingestKnowledgeSnapshot(
      tampered,
      {
        privateSovereign:
          true,
      },
    ).accepted,
    false,
  );

  const credential =
    buildKnowledgeSnapshot({
      sourceId:
        "PULUMI_CORE",
      sourceUri:
        knowledgeSource(
          "PULUMI_CORE",
        ).canonicalUri,
      retrievedAt:
        "2026-10-08T02:15:00.000Z",
      sourceVersion:
        "887e0dd5cba36cdabbab8821f6666be13abfa18d",
      contentType:
        "application/json",
      localMirrorRef:
        "mirror://github/pulumi/pulumi/test",
      records: [
        {
          recordId:
            "pulumi:bad",
          kind:
            "SOURCE_FACT",
          title: "bad",
          metadata: {
            apiToken:
              "do-not-ingest",
          },
        },
      ],
    });

  const result =
    ingestKnowledgeSnapshot(
      credential,
      {
        privateSovereign:
          true,
      },
    );

  assert.equal(
    result.accepted,
    false,
  );
  assert.match(
    result.reasons.join(" "),
    /credential-like material/,
  );
});

test("baseline snapshot IDs are deterministic and unique", () => {
  const ids =
    snapshotIds(
      BASELINE_KNOWLEDGE_SNAPSHOTS,
    );

  assert.equal(
    new Set(ids).size,
    ids.length,
  );
});
