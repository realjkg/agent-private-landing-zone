import type { IaCEngine } from "../build/types.js";
import { sha256 } from "../build/provenance.js";

export type ChangeOperation =
  | "CREATE"
  | "UPDATE"
  | "DELETE"
  | "REPLACE"
  | "READ"
  | "SAME"
  | "UNKNOWN";

export type ResourceChange = {
  address: string;
  type?: string;
  operation: ChangeOperation;
};

export type ChangeSet = {
  engine: IaCEngine;
  resources: ResourceChange[];
  creates: number;
  updates: number;
  deletes: number;
  replacements: number;
  reads: number;
  unchanged: number;
  unknown: number;
  destructive: boolean;
  evidenceHash: string;
};

export function createChangeSet(
  engine: IaCEngine,
  resources: ResourceChange[],
): ChangeSet {
  const counts = {
    creates: 0,
    updates: 0,
    deletes: 0,
    replacements: 0,
    reads: 0,
    unchanged: 0,
    unknown: 0,
  };

  for (const resource of resources) {
    if (resource.operation === "CREATE") counts.creates += 1;
    else if (resource.operation === "UPDATE") counts.updates += 1;
    else if (resource.operation === "DELETE") counts.deletes += 1;
    else if (resource.operation === "REPLACE") counts.replacements += 1;
    else if (resource.operation === "READ") counts.reads += 1;
    else if (resource.operation === "SAME") counts.unchanged += 1;
    else counts.unknown += 1;
  }

  const normalized = {
    engine,
    resources: resources
      .map((resource) => ({
        address: resource.address,
        type: resource.type,
        operation: resource.operation,
      }))
      .sort((a, b) =>
        a.address.localeCompare(b.address),
      ),
    ...counts,
  };

  return {
    ...normalized,
    destructive:
      counts.deletes > 0 ||
      counts.replacements > 0,
    evidenceHash: sha256(
      JSON.stringify(normalized),
    ),
  };
}
