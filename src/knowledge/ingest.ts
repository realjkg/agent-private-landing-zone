import {
  createHash,
} from "node:crypto";

import {
  knowledgeSource,
} from "./sources.js";
import type {
  KnowledgeIngestionResult,
  KnowledgeRecord,
  KnowledgeSnapshot,
  KnowledgeSourceId,
} from "./types.js";

type SnapshotInput = Omit<
  KnowledgeSnapshot,
  "schemaVersion" | "sha256"
>;

function canonicalRecords(
  records: KnowledgeRecord[],
): KnowledgeRecord[] {
  return [...records].sort(
    (left, right) =>
      left.recordId.localeCompare(
        right.recordId,
      ),
  );
}

function payload(
  input: SnapshotInput,
): string {
  return JSON.stringify({
    sourceId: input.sourceId,
    sourceUri: input.sourceUri,
    retrievedAt:
      input.retrievedAt,
    sourceVersion:
      input.sourceVersion,
    contentType:
      input.contentType,
    localMirrorRef:
      input.localMirrorRef,
    records:
      canonicalRecords(
        input.records,
      ),
  });
}

export function buildKnowledgeSnapshot(
  input: SnapshotInput,
): KnowledgeSnapshot {
  const normalized: SnapshotInput = {
    ...input,
    records:
      canonicalRecords(
        input.records,
      ),
  };

  return {
    schemaVersion: 1,
    ...normalized,
    sha256:
      createHash("sha256")
        .update(
          payload(normalized),
        )
        .digest("hex"),
  };
}

function localMirror(
  ref: string,
): boolean {
  return (
    ref.startsWith("mirror://") ||
    ref.startsWith("repo://") ||
    ref.startsWith("file://")
  );
}

function credentialLikeKey(
  key: string,
): boolean {
  return /(?:password|passwd|secret|token|credential|api[_-]?key)/i.test(
    key,
  );
}

function containsCredentialMaterial(
  value: unknown,
): boolean {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  for (const [
    key,
    nested,
  ] of Object.entries(
    value as Record<
      string,
      unknown
    >,
  )) {
    if (
      credentialLikeKey(key) &&
      nested !== undefined &&
      nested !== null
    ) {
      return true;
    }

    if (
      containsCredentialMaterial(
        nested,
      )
    ) {
      return true;
    }
  }

  return false;
}

export function ingestKnowledgeSnapshot(
  snapshot: KnowledgeSnapshot,
  options: {
    privateSovereign?: boolean;
  } = {},
): KnowledgeIngestionResult {
  const source =
    knowledgeSource(
      snapshot.sourceId,
    );
  const reasons: string[] = [];

  if (
    snapshot.sourceUri !==
    source.canonicalUri
  ) {
    reasons.push(
      "Snapshot source URI does not match the registered canonical source.",
    );
  }

  if (
    snapshot.records.length === 0
  ) {
    reasons.push(
      "Knowledge snapshot contains no records.",
    );
  }

  const unique =
    new Set(
      snapshot.records.map(
        (record) =>
          record.recordId,
      ),
    );

  if (
    unique.size !==
    snapshot.records.length
  ) {
    reasons.push(
      "Knowledge snapshot record IDs must be unique.",
    );
  }

  if (
    snapshot.records.some(
      (record) =>
        containsCredentialMaterial(
          record.metadata,
        ),
    )
  ) {
    reasons.push(
      "Knowledge snapshot contains credential-like material.",
    );
  }

  const expected =
    buildKnowledgeSnapshot({
      sourceId:
        snapshot.sourceId,
      sourceUri:
        snapshot.sourceUri,
      retrievedAt:
        snapshot.retrievedAt,
      sourceVersion:
        snapshot.sourceVersion,
      contentType:
        snapshot.contentType,
      localMirrorRef:
        snapshot.localMirrorRef,
      records:
        snapshot.records,
    }).sha256;

  if (
    snapshot.sha256 !==
    expected
  ) {
    reasons.push(
      "Knowledge snapshot hash mismatch.",
    );
  }

  if (
    options.privateSovereign &&
    source
      .mirrorRequiredForPrivateSovereign &&
    (
      !snapshot.localMirrorRef ||
      !localMirror(
        snapshot.localMirrorRef,
      )
    )
  ) {
    reasons.push(
      "Private-sovereign ingestion requires an approved local mirror reference.",
    );
  }

  return {
    source,
    snapshot,
    accepted:
      reasons.length === 0,
    reasons,
    recordCount:
      snapshot.records.length,
  };
}

export function requireKnowledgeSnapshot(
  snapshot: KnowledgeSnapshot,
  options: {
    privateSovereign?: boolean;
  } = {},
): KnowledgeIngestionResult {
  const result =
    ingestKnowledgeSnapshot(
      snapshot,
      options,
    );

  if (!result.accepted) {
    throw new Error(
      "KNOWLEDGE_INGESTION_REJECTED: " +
        result.reasons.join(
          " ",
        ),
    );
  }

  return result;
}

export function snapshotIds(
  snapshots:
    KnowledgeSnapshot[],
): KnowledgeSourceId[] {
  return snapshots.map(
    (snapshot) =>
      snapshot.sourceId,
  );
}
