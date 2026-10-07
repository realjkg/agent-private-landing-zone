const SENSITIVE_KEY =
  /(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|client[_-]?secret)/i;

export type MinimizedData = {
  value: unknown;
  redactedPaths: string[];
};

function walk(
  value: unknown,
  path: string,
  redacted: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map(
      (item, index) =>
        walk(
          item,
          path + "[" + index + "]",
          redacted,
        ),
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const output:
      Record<string, unknown> = {};

    for (const [
      key,
      item,
    ] of Object.entries(
      value as Record<
        string,
        unknown
      >,
    )) {
      const childPath =
        path
          ? path + "." + key
          : key;

      if (SENSITIVE_KEY.test(key)) {
        output[key] =
          "[REDACTED]";
        redacted.push(
          childPath,
        );
        continue;
      }

      output[key] =
        walk(
          item,
          childPath,
          redacted,
        );
    }

    return output;
  }

  return value;
}

export function minimizeSensitiveData(
  value: unknown,
): MinimizedData {
  const redactedPaths:
    string[] = [];

  return {
    value: walk(
      value,
      "",
      redactedPaths,
    ),
    redactedPaths:
      redactedPaths.sort(),
  };
}
