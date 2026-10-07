const SENSITIVE_KEY =
  /(secret|password|token|authorization|api[_-]?key|access[_-]?key|private[_-]?key|credential)/i;

const SENSITIVE_ASSIGNMENT =
  /\b(secret|password|token|authorization|api[_-]?key|access[_-]?key|private[_-]?key|credential)\b\s*[:=]\s*[^\s,;]+/gi;

const BEARER =
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;

export function sanitizeDiagnosticText(
  value: string,
  maxLength = 512,
): string {
  return value
    .replace(
      PRIVATE_KEY,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      SENSITIVE_ASSIGNMENT,
      (match) => {
        const key =
          match.split(
            /\s*[:=]\s*/,
          )[0] ??
          "sensitive";
        return (
          key +
          "=[REDACTED]"
        );
      },
    )
    .replace(
      BEARER,
      "Bearer [REDACTED]",
    )
    .slice(0, maxLength);
}

export function redactDiagnosticValue(
  value: unknown,
  key = "",
): unknown {
  if (
    key &&
    SENSITIVE_KEY.test(key)
  ) {
    return "[REDACTED]";
  }

  if (
    typeof value === "string"
  ) {
    return sanitizeDiagnosticText(
      value,
    );
  }

  if (Array.isArray(value)) {
    return value.map(
      (item) =>
        redactDiagnosticValue(
          item,
        ),
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.entries(
        value as Record<
          string,
          unknown
        >,
      ).map(
        ([childKey, child]) => [
          childKey,
          redactDiagnosticValue(
            child,
            childKey,
          ),
        ],
      ),
    );
  }

  return value;
}
