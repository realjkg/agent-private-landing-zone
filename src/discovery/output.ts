import type {
  DiscoveredResource,
  EnvironmentState,
} from "./types.js";
import { writeEncryptedEvidence } from "../evidence/vault.js";
import type {
  Emitter,
} from "../observability/bus.js";

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function writeDiscoveryRun(
  state: EnvironmentState,
  emitter?: Emitter,
): Promise<string> {
  const timestamp = state.discoveredAt
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");

  const filename =
    timestamp +
    "-" +
    sanitize(state.provider) +
    "-" +
    sanitize(state.classification);

  return writeEncryptedEvidence(
    "discovery",
    filename,
    state,
    emitter,
  );
}

export function formatResourceRows(
  resources: DiscoveredResource[],
): string[] {
  if (resources.length === 0) {
    return ["  No resources discovered."];
  }

  const headers = [
    "RESOURCE",
    "TYPE",
    "OWNERSHIP",
    "POLICY",
    "SOURCE",
  ];

  const rows = resources.map((resource) => [
    resource.name,
    resource.resourceType,
    resource.ownership,
    resource.mutationPolicy,
    resource.sourceOfTruth,
  ]);

  const widths = headers.map((header, index) =>
    Math.min(
      34,
      Math.max(
        header.length,
        ...rows.map((row) => row[index].length),
      ),
    ),
  );

  const clip = (value: string, width: number): string =>
    value.length > width
      ? value.slice(
          0,
          Math.max(0, width - 1),
        ) + "…"
      : value;

  const render = (row: string[]): string =>
    row
      .map((value, index) =>
        clip(
          value,
          widths[index],
        ).padEnd(widths[index]),
      )
      .join("  ");

  return [
    "  " + render(headers),
    "  " +
      widths
        .map((width) =>
          "─".repeat(width),
        )
        .join("  "),
    ...rows.map(
      (row) => "  " + render(row),
    ),
  ];
}
