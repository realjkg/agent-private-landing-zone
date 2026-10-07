import {
  createChangeSet,
  type ChangeSet,
  type ResourceChange,
} from "./changeset.js";

function field(
  document: string,
  name: string,
): string | undefined {
  const match =
    document.match(
      new RegExp(
        "^" + name + ":\\s*([^\\n#]+)",
        "m",
      ),
    );

  return match?.[1]?.trim();
}

function metadataName(
  document: string,
): string | undefined {
  const metadata =
    document.match(
      /^metadata:\s*\n([\s\S]*?)(?=^[^\s]|\Z)/m,
    )?.[1];

  return metadata
    ? field(metadata, "\\s+name")
    : undefined;
}

export function normalizeCrossplaneRender(
  yaml: string,
): ChangeSet {
  const documents =
    yaml
      .split(/^---\s*$/m)
      .map((value) => value.trim())
      .filter(Boolean);

  const resources:
    ResourceChange[] = [];

  for (
    const [index, document] of
    documents.entries()
  ) {
    const apiVersion =
      field(
        document,
        "apiVersion",
      );
    const kind =
      field(document, "kind");
    const name =
      metadataName(document);

    if (!kind) {
      continue;
    }

    resources.push({
      address:
        "crossplane:" +
        (name ?? "unknown-" + index),
      type:
        apiVersion && kind
          ? apiVersion + "/" + kind
          : kind,
      operation: "UNKNOWN",
    });
  }

  if (resources.length === 0) {
    resources.push({
      address:
        "crossplane:render:unknown",
      type: "render-output",
      operation: "UNKNOWN",
    });
  }

  return createChangeSet(
    "CROSSPLANE",
    resources,
  );
}
