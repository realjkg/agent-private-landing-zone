import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  tmpdir,
} from "node:os";
import {
  dirname,
  join,
  resolve,
} from "node:path";

import {
  readControlPlaneRecovery,
  restoreControlPlaneRecovery,
  writeControlPlaneRecovery,
} from "../recovery/control-plane/bundle.js";

function valueAfter(
  name: string,
): string | undefined {
  const args =
    process.argv.slice(2);
  const index =
    args.indexOf(name);

  return index >= 0
    ? args[index + 1]
    : undefined;
}

function required(
  name: string,
): string {
  const value =
    valueAfter(name);

  if (!value) {
    throw new Error(
      "CONTROL_PLANE_ARGUMENT_REQUIRED: " +
        name,
    );
  }

  return value;
}

async function writeReport(
  value: unknown,
): Promise<void> {
  const report =
    valueAfter("--report");

  if (!report) {
    return;
  }

  const target =
    resolve(report);

  await mkdir(
    dirname(target),
    {
      recursive: true,
      mode: 0o700,
    },
  );

  await writeFile(
    target,
    JSON.stringify(
      value,
      null,
      2,
    ) + "\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

function bundleSummary(
  bundle:
    Awaited<
      ReturnType<
        typeof readControlPlaneRecovery
      >
    >,
) {
  return {
    ready: true,
    release:
      bundle.release,
    state:
      bundle.state,
    files:
      bundle.files.length,
    bundleHash:
      bundle.bundleHash,
    keyReference:
      bundle.keyReference,
    mutationAttempted:
      false,
    actEnabled: false,
  };
}

async function drill(
  evidencePath: string,
) {
  const directory =
    await mkdtemp(
      join(
        tmpdir(),
        "alz-control-plane-drill-",
      ),
    );
  const target =
    join(
      directory,
      "restored",
    );

  try {
    return await restoreControlPlaneRecovery({
      evidencePath,
      restoreRoot:
        target,
    });
  } finally {
    await rm(
      directory,
      {
        recursive: true,
        force: true,
      },
    );
  }
}

const [
  command = "help",
] =
  process.argv.slice(2);

try {
  if (
    command === "capture"
  ) {
    const root =
      resolve(
        required("--root"),
      );
    const evidence =
      resolve(
        required(
          "--evidence",
        ),
      );
    const result =
      await writeControlPlaneRecovery(
        root,
        evidence,
      );
    const summary =
      bundleSummary(
        result.bundle,
      );

    await writeReport(
      summary,
    );

    console.log(
      "Control-plane recovery evidence: " +
        result.path,
    );
    console.log(
      "Files protected: " +
        result.bundle.files
          .length,
    );
    console.log(
      "Evidence key included: NO",
    );
    console.log(
      "ACT: DISABLED",
    );
  } else if (
    command === "verify"
  ) {
    const evidence =
      resolve(
        required(
          "--evidence",
        ),
      );
    const bundle =
      await readControlPlaneRecovery(
        evidence,
      );
    const summary =
      bundleSummary(bundle);

    await writeReport(
      summary,
    );

    console.log(
      "✓ encrypted control-plane recovery bundle verified",
    );
    console.log(
      "✓ release identity " +
        bundle.release
          .productVersion +
        " / " +
        bundle.release
          .sourceCommit.slice(
            0,
            12,
          ),
    );
    console.log(
      "✓ evidence key material excluded",
    );
    console.log(
      "✓ ACT remains disabled",
    );
  } else if (
    command === "drill"
  ) {
    const evidence =
      resolve(
        required(
          "--evidence",
        ),
      );
    const result =
      await drill(evidence);

    await writeReport(
      result,
    );

    if (!result.verified) {
      for (const blocker of
        result.blockers) {
        console.error(
          "! " + blocker,
        );
      }
      process.exitCode = 1;
    } else {
      console.log(
        "✓ isolated control-plane restore drill verified",
      );
      console.log(
        "✓ restored release integrity verified",
      );
      console.log(
        "✓ ACT remains disabled",
      );
    }
  } else if (
    command === "restore"
  ) {
    const evidence =
      resolve(
        required(
          "--evidence",
        ),
      );
    const restoreRoot =
      resolve(
        required(
          "--restore-root",
        ),
      );
    const result =
      await restoreControlPlaneRecovery({
        evidencePath:
          evidence,
        restoreRoot,
      });

    await writeReport(
      result,
    );

    if (!result.verified) {
      for (const blocker of
        result.blockers) {
        console.error(
          "! " + blocker,
        );
      }
      process.exitCode = 1;
    } else {
      console.log(
        "✓ control plane restored and verified",
      );
      console.log(
        "✓ release artifact integrity verified",
      );
      console.log(
        "✓ restored files " +
          result
            .restoredFiles,
      );
      console.log(
        "✓ ACT remains disabled",
      );
    }
  } else {
    console.log(
      "Use capture, verify, drill, or restore.",
    );
    console.log(
      "capture --root <release-root> --evidence <encrypted-bundle>",
    );
    console.log(
      "verify --evidence <encrypted-bundle>",
    );
    console.log(
      "drill --evidence <encrypted-bundle>",
    );
    console.log(
      "restore --evidence <encrypted-bundle> --restore-root <empty-directory>",
    );
    console.log(
      "ACT remains disabled.",
    );

    if (
      command !== "help" &&
      command !== "--help" &&
      command !== "-h"
    ) {
      process.exitCode = 2;
    }
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Control-plane recovery failed.",
  );
  process.exitCode = 1;
}
