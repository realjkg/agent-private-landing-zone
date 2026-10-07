import type {
  RecoveryProfileDiff,
  RecoveryTargetIntent,
} from "./types.js";

function flatten(
  value: unknown,
  prefix = "",
  output:
    Record<
      string,
      string | number | boolean
    > = {},
): Record<
  string,
  string | number | boolean
> {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output[prefix] = value;
    }

    return output;
  }

  if (Array.isArray(value)) {
    output[prefix] =
      value.join(",");
    return output;
  }

  for (const [
    key,
    item,
  ] of Object.entries(
    value as Record<
      string,
      unknown
    >,
  )) {
    flatten(
      item,
      prefix
        ? prefix + "." + key
        : key,
      output,
    );
  }

  return output;
}

export function semanticRecoveryDiff(
  from: unknown,
  to: unknown,
): RecoveryProfileDiff {
  const left = flatten(from);
  const right = flatten(to);
  const paths =
    new Set([
      ...Object.keys(left),
      ...Object.keys(right),
    ]);

  const changes:
    RecoveryProfileDiff[
      "changes"
    ] = [];

  for (const path of
    [...paths].sort()) {
    const previous =
      left[path];
    const next =
      right[path];

    if (
      previous !== undefined &&
      next !== undefined &&
      previous !== next
    ) {
      changes.push({
        path,
        from: previous,
        to: next,
      });
    }
  }

  return {
    changed:
      changes.length > 0,
    changes,
  };
}

export function promoteIntentToProduction(
  intent: RecoveryTargetIntent,
): RecoveryTargetIntent {
  return {
    ...intent,
    environment:
      "PRODUCTION",
  };
}
