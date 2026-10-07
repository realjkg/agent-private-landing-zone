import {
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  resolve,
} from "node:path";
import {
  mkdir,
} from "node:fs/promises";

import {
  captureControlPlaneRecovery,
  drillControlPlaneRecovery,
  restoreControlPlaneRecovery,
  verifyControlPlaneRecoverySnapshot,
} from "../recovery/control-plane/index.js";

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

function valuesAfter(
  name: string,
): string[] {
  const args =
    process.argv.slice(2);
  const values:
    string[] = [];

  for (
    let index = 0;
    index < args.length;
    index += 1
  ) {
    if (
      args[index] === name &&
      args[index + 1]
    ) {
      values.push(
        args[index + 1],
      );
      index += 1;
    }
  }

  return values;
}

function hasFlag(
  name: string,
): boolean {
  return process.argv
    .slice(2)
    .includes(name);
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

async function explicitEvidenceKey():
  Promise<
    Buffer | undefined
  > {
  const inline =
    process.env
      .AGENTIC_EVIDENCE_KEY;

  if (inline) {
    const key =
      Buffer.from(
        inline.trim(),
        "base64",
      );
    if (key.length !== 32) {
      throw new Error(
        "CONTROL_PLANE_EVIDENCE_KEY_INVALID",
      );
    }
    return key;
  }

  const file =
    process.env
      .AGENTIC_EVIDENCE_KEY_FILE;

  if (!file) {
    return undefined;
  }

  const key =
    Buffer.from(
      (
        await readFile(
          file,
          "utf8",
        )
      ).trim(),
      "base64",
    );

  if (key.length !== 32) {
    throw new Error(
      "CONTROL_PLANE_EVIDENCE_KEY_INVALID",
    );
  }

  return key;
}

async function writeReport(
  value: unknown,
): Promise<void> {
  const output =
    valueAfter(
      "--output",
    );

  if (!output) {
    return;
  }

  const target =
    resolve(output);
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

const [
  command = "help",
] =
  process.argv.slice(2);

try {
  if (
    command === "capture"
  ) {
    const manifest =
      await captureControlPlaneRecovery({
        root:
          valueAfter(
            "--root",
          ) ?? ".",
        destination:
          required(
            "--destination",
          ),
        checkpointPaths:
          valuesAfter(
            "--checkpoint",
          ),
      });

    await writeReport(
      manifest,
    );

    console.log(
      "Control-plane recovery point captured.",
    );
    console.log(
      "Files: " +
        manifest.files.length,
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
    const blockers =
      await verifyControlPlaneRecoverySnapshot(
        required(
          "--snapshot",
        ),
      );
    const result = {
      ready:
        blockers.length === 0,
      blockers,
      actEnabled: false,
    };

    await writeReport(
      result,
    );

    console.log(
      result.ready
        ? "Control-plane recovery snapshot verified."
        : "Control-plane recovery snapshot blocked.",
    );

    if (!result.ready) {
      for (const blocker of
        blockers) {
        console.error(
          "! " + blocker,
        );
      }
      process.exitCode = 1;
    }
  } else if (
    command === "drill"
  ) {
    const verifyEvidence =
      hasFlag(
        "--verify-evidence",
      );
    const result =
      await drillControlPlaneRecovery({
        snapshot:
          required(
            "--snapshot",
          ),
        verifyEncryptedEvidence:
          verifyEvidence,
        evidenceKey:
          verifyEvidence
            ? await explicitEvidenceKey()
            : undefined,
      });

    await writeReport(
      result,
    );

    console.log(
      result.ready
        ? "Control-plane isolated restore drill verified."
        : "Control-plane isolated restore drill blocked.",
    );
    console.log(
      "ACT: DISABLED",
    );

    if (!result.ready) {
      for (const blocker of
        result.blockers) {
        console.error(
          "! " + blocker,
        );
      }
      process.exitCode = 1;
    }
  } else if (
    command === "restore"
  ) {
    const verifyEvidence =
      hasFlag(
        "--verify-evidence",
      );
    const result =
      await restoreControlPlaneRecovery({
        snapshot:
          required(
            "--snapshot",
          ),
        target:
          required(
            "--target",
          ),
        verifyEncryptedEvidence:
          verifyEvidence,
        evidenceKey:
          verifyEvidence
            ? await explicitEvidenceKey()
            : undefined,
      });

    await writeReport(
      result,
    );

    console.log(
      result.ready
        ? "Control plane restored and verified."
        : "Control-plane restore blocked.",
    );
    console.log(
      "ACT: DISABLED",
    );

    if (!result.ready) {
      for (const blocker of
        result.blockers) {
        console.error(
          "! " + blocker,
        );
      }
      process.exitCode = 1;
    }
  } else {
    console.log(
      "Use capture, verify, drill, or restore.",
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Control-plane recovery failed.",
  );
  process.exitCode = 1;
}
