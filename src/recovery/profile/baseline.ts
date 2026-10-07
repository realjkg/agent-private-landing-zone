import {
  readFile,
} from "node:fs/promises";
import {
  resolve,
} from "node:path";

import {
  z,
} from "zod";

import {
  sha256,
} from "../../build/provenance.js";
import type {
  RecoverySecurityBaseline,
} from "./types.js";

const baselineSchema = z.object({
  documentId: z.literal(
    "ALZ-SECURITY-BASELINE",
  ),
  documentVersion:
    z.string().min(1),
  requiredDataClassification:
    z.enum([
      "PUBLIC",
      "INTERNAL",
      "CONFIDENTIAL",
      "RESTRICTED",
    ]),
  defaultDenyEgress:
    z.literal(true),
  customerManagedEncryption:
    z.literal(true),
  providerEdgeRecovery:
    z.literal(true),
  immutableRecovery:
    z.literal(true),
  centralControlCanDecrypt:
    z.literal(false),
  isolatedPreviewRestore:
    z.literal(true),
  tamperEvidentEvidence:
    z.literal(true),
  compromiseContainment:
    z.literal(true),
  actEnabled:
    z.literal(false),
  lockedControls:
    z.array(
      z.string().min(1),
    ).min(1),
});

function scalar(
  value: string,
): string | boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return value.replace(
    /^["']|["']$/g,
    "",
  );
}

function parseFrontMatter(
  raw: string,
): Record<string, unknown> {
  const match =
    raw.match(
      /^---\n([\s\S]*?)\n---(?:\n|$)/,
    );

  if (!match) {
    throw new Error(
      "SECURITY_BASELINE_INVALID: YAML front matter is required.",
    );
  }

  const output:
    Record<string, unknown> = {};
  let listKey:
    string | undefined;

  for (const sourceLine of
    match[1].split("\n")) {
    const line =
      sourceLine.trimEnd();

    if (!line.trim()) {
      continue;
    }

    const list =
      line.match(
        /^\s+-\s+(.+)$/,
      );

    if (list && listKey) {
      (
        output[listKey] as
          unknown[]
      ).push(
        scalar(list[1]),
      );
      continue;
    }

    const entry =
      line.match(
        /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/,
      );

    if (!entry) {
      throw new Error(
        "SECURITY_BASELINE_INVALID: unsupported front matter syntax.",
      );
    }

    const [, key, rawValue] =
      entry;

    if (!rawValue) {
      output[key] = [];
      listKey = key;
      continue;
    }

    output[key] =
      scalar(rawValue.trim());
    listKey = undefined;
  }

  return output;
}

export function parseSecurityBaseline(
  raw: string,
  documentRef =
    "config/security-baseline.md",
): RecoverySecurityBaseline {
  const parsed =
    baselineSchema.parse(
      parseFrontMatter(raw),
    );

  return {
    ...parsed,
    documentRef,
    expectedSha256:
      sha256(raw),
  };
}

export async function loadSecurityBaseline(
  path =
    "config/security-baseline.md",
): Promise<RecoverySecurityBaseline> {
  const resolved =
    resolve(path);
  const raw =
    await readFile(
      resolved,
      "utf8",
    );

  return parseSecurityBaseline(
    raw,
    path,
  );
}
