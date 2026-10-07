import {
  readdirSync,
  readFileSync,
} from "node:fs";
import {
  resolve,
} from "node:path";

const workflowDir =
  resolve(
    ".github",
    "workflows",
  );

const files =
  readdirSync(
    workflowDir,
  ).filter(
    (name) =>
      name.endsWith(".yml") ||
      name.endsWith(".yaml"),
  );

const failures = [];

for (const name of files) {
  const path =
    resolve(
      workflowDir,
      name,
    );
  const lines =
    readFileSync(
      path,
      "utf8",
    ).split("\n");

  for (
    let index = 0;
    index < lines.length;
    index += 1
  ) {
    const line =
      lines[index];
    const match =
      line.match(
        /^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/,
      );

    if (!match) {
      continue;
    }

    const reference =
      match[1];

    if (
      reference.startsWith("./")
    ) {
      continue;
    }

    const at =
      reference.lastIndexOf(
        "@",
      );

    if (at < 1) {
      failures.push({
        file: name,
        line:
          index + 1,
        reference,
        reason:
          "external action has no ref",
      });
      continue;
    }

    const ref =
      reference.slice(at + 1);

    if (
      !/^[0-9a-f]{40}$/i.test(
        ref,
      )
    ) {
      failures.push({
        file: name,
        line:
          index + 1,
        reference,
        reason:
          "external action is not pinned to an immutable 40-character commit SHA",
      });
    }
  }
}

if (failures.length > 0) {
  console.error(
    "Unpinned GitHub Actions references:",
  );

  for (
    const failure of
    failures
  ) {
    console.error(
      "  " +
        failure.file +
        ":" +
        failure.line +
        " " +
        failure.reference +
        " — " +
        failure.reason,
    );
  }

  process.exitCode = 1;
} else {
  console.log(
    "All external GitHub Actions references are pinned to immutable commit SHAs.",
  );
}
