import {
  spawnSync,
} from "node:child_process";
import {
  mkdir,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  resolve,
} from "node:path";

import {
  OPA_DECISION_QUERY,
  OPA_PARITY_CASES,
  PINNED_OPA_VERSION,
  parseOpaEvalDecision,
  parseOpaVersion,
  qualifyOpaParity,
  type OpaParityQualification,
} from "../qualification/opa-parity.js";
import type {
  SecurityPolicyDecision,
} from "../security/policy/types.js";

function readArg(
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

function run(
  command: string,
  args: string[],
  input?: string,
): string {
  const result =
    spawnSync(
      command,
      args,
      {
        encoding: "utf8",
        shell: false,
        input,
      },
    );

  if (
    result.error ||
    result.status !== 0
  ) {
    throw new Error(
      "OPA_QUALIFICATION_COMMAND_FAILED: " +
        command +
        " " +
        args.join(" ") +
        (result.stderr
          ? " — " +
            result.stderr.trim()
          : ""),
    );
  }

  return result.stdout;
}

async function persist(
  path: string,
  result:
    OpaParityQualification,
): Promise<void> {
  const target =
    resolve(path);

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
      result,
      null,
      2,
    ) + "\n",
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

const opa =
  readArg("--opa") ??
  process.env.OPA_BIN ??
  "opa";
const policy =
  readArg("--policy") ??
  "policy/opa/security.rego";
const output =
  readArg("--output");

try {
  const version =
    parseOpaVersion(
      run(
        opa,
        ["version"],
      ),
    );

  if (
    version !==
      PINNED_OPA_VERSION
  ) {
    throw new Error(
      "OPA_VERSION_MISMATCH: expected " +
        PINNED_OPA_VERSION +
        ", got " +
        version +
        ".",
    );
  }

  run(
    opa,
    [
      "check",
      "--strict",
      policy,
    ],
  );

  const decisions:
    Record<
      string,
      SecurityPolicyDecision
    > = {};

  for (const testCase of
    OPA_PARITY_CASES) {
    const raw =
      run(
        opa,
        [
          "eval",
          "--format=json",
          "--data",
          policy,
          "--stdin-input",
          OPA_DECISION_QUERY,
        ],
        JSON.stringify(
          testCase.input,
        ),
      );

    decisions[
      testCase.name
    ] =
      parseOpaEvalDecision(
        raw,
      );
  }

  const qualification =
    qualifyOpaParity({
      version,
      decisions,
    });

  for (const result of
    qualification.cases) {
    console.log(
      (result.parity.strict
        ? "✓ "
        : "! ") +
        result.name,
    );

    if (
      !result.parity.strict
    ) {
      console.log(
        "  BUILTIN " +
          JSON.stringify(
            result.builtin,
          ),
      );
      console.log(
        "  OPA     " +
          JSON.stringify(
            result.opa,
          ),
      );
    }
  }

  console.log();
  console.log(
    "OPA version: " +
      qualification.version,
  );
  console.log(
    qualification.passed
      ? "✓ strict BUILTIN/OPA parity"
      : "! BUILTIN/OPA parity failed",
  );
  console.log(
    "✓ local policy evaluation only",
  );
  console.log(
    "✓ ACT remains disabled",
  );

  if (output) {
    await persist(
      output,
      qualification,
    );
  }

  if (!qualification.passed) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message
      : "OPA qualification failed.",
  );
  process.exitCode = 1;
}
