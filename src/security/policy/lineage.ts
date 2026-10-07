import {
  sha256,
} from "../../build/provenance.js";
import type {
  EvidenceLineageEntry,
} from "./types.js";

function normalizedEntry(input: {
  artifactType: string;
  artifactHash: string;
  policyDecisionHash: string;
  previousHash?: string;
  createdAt: string;
}) {
  return {
    artifactType:
      input.artifactType,
    artifactHash:
      input.artifactHash,
    policyDecisionHash:
      input.policyDecisionHash,
    previousHash:
      input.previousHash,
    createdAt:
      input.createdAt,
  };
}

export function createEvidenceLineageEntry(
  input: {
    artifactType: string;
    artifactHash: string;
    policyDecisionHash: string;
    previousHash?: string;
    createdAt?: string;
  },
): EvidenceLineageEntry {
  const createdAt =
    input.createdAt ??
    new Date().toISOString();

  const normalized =
    normalizedEntry({
      ...input,
      createdAt,
    });

  const entryHash =
    sha256(
      JSON.stringify(normalized),
    );

  return {
    lineageId:
      "lineage-" +
      entryHash.slice(0, 12),
    ...normalized,
    entryHash,
  };
}

export function verifyEvidenceLineage(
  entries: EvidenceLineageEntry[],
): {
  valid: boolean;
  brokenAt?: number;
} {
  for (
    let index = 0;
    index < entries.length;
    index += 1
  ) {
    const entry = entries[index];
    const expected =
      sha256(
        JSON.stringify(
          normalizedEntry(entry),
        ),
      );

    if (
      expected !== entry.entryHash
    ) {
      return {
        valid: false,
        brokenAt: index,
      };
    }

    if (
      index > 0 &&
      entry.previousHash !==
        entries[index - 1]
          .entryHash
    ) {
      return {
        valid: false,
        brokenAt: index,
      };
    }
  }

  return { valid: true };
}
