import {
  existsSync,
} from "node:fs";
import {
  relative,
  resolve,
  sep,
} from "node:path";

export function workspaceFile(
  cwd: string,
  value: string | undefined,
  label: string,
): string {
  if (!value) {
    throw new Error(
      label + " is required.",
    );
  }

  const root = resolve(cwd);
  const path = resolve(root, value);
  const relation = relative(root, path);

  if (
    relation === ".." ||
    relation.startsWith(".." + sep)
  ) {
    throw new Error(
      label + " escapes the workspace.",
    );
  }

  if (!existsSync(path)) {
    throw new Error(
      label + " does not exist.",
    );
  }

  return path;
}

export function safeName(
  value: string | undefined,
  label: string,
): string {
  if (
    !value ||
    !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(
      value,
    )
  ) {
    throw new Error(
      label +
        " must start with a letter and contain only letters, numbers, or hyphens.",
    );
  }

  return value;
}
