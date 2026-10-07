import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  spawnSync,
} from "node:child_process";
import {
  resolve,
  sep,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";
import {
  promptGuide,
} from "../session/help.js";
import {
  parseRecoveryTargets,
} from "../recovery/target-loader.js";
import {
  explainRecoveryIntent,
  parseRecoveryTargetIntent,
  recoveryIntentFromAnswers,
  recoveryTargetStatus,
  recoveryTestReadiness,
} from "../recovery/profile/operator.js";

const root = resolve(
  fileURLToPath(
    new URL("../..", import.meta.url),
  ),
);

function workspacePath(
  value: string,
): string {
  const path = resolve(
    root,
    value,
  );

  if (
    path !== root &&
    !path.startsWith(
      root + sep,
    )
  ) {
    throw new Error(
      [
        "Problem: path escapes the accelerator workspace.",
        "Recommended fix: use a file path inside the repository.",
        "Safe alternative: copy the target file into config/ and retry.",
        "No infrastructure changes were made.",
      ].join("\n"),
    );
  }

  return path;
}

function localBin(
  name: string,
): string {
  return resolve(
    root,
    "node_modules",
    ".bin",
    process.platform === "win32"
      ? name + ".cmd"
      : name,
  );
}

function run(
  command: string,
  args: string[],
  capture = false,
): string {
  const result = spawnSync(
    command,
    args,
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      shell: false,
      stdio: capture
        ? ["ignore", "pipe", "inherit"]
        : "inherit",
    },
  );

  if (
    result.error ||
    result.status !== 0
  ) {
    throw new Error(
      "Operator command failed: " +
        command +
        " " +
        args.join(" "),
    );
  }

  return capture
    ? result.stdout ?? ""
    : "";
}

function runTs(
  script: string,
  args: string[] = [],
): void {
  run(
    localBin("tsx"),
    [
      resolve(root, script),
      ...args,
    ],
  );
}

function choice(
  value: string | undefined,
  allowed: string[],
  fallback: string,
): string {
  const selected =
    (value ?? fallback).toLowerCase();

  if (!allowed.includes(selected)) {
    throw new Error(
      "Expected one of: " +
        allowed.join(", "),
    );
  }

  return selected;
}

function help(): void {
  console.log();
  console.log("Agent Private Landing Zone");
  console.log("────────────────────────────────");
  console.log("Operator commands");
  console.log();
  console.log(
    "  ./alz demo [aws|azure] [terraform|pulumi|opentofu|bicep|cloudformation|cdk|crossplane|ansible] [brownfield|greenfield|unknown]",
  );
  console.log(
    "  ./alz design [aws|azure] [terraform|pulumi|opentofu|bicep|cloudformation|cdk|crossplane|ansible] [brownfield|greenfield|unknown]",
  );
  console.log(
    "  ./alz inspect [aws|azure]",
  );
  console.log(
    "  ./alz session [aws|azure] [terraform|pulumi|opentofu|bicep|cloudformation|cdk|crossplane|ansible]",
  );
  console.log(
    "  ./alz target init <target-id> <owner> <aws|azure> <scope-id> <startup|enterprise> <development|production> <non-critical|business|critical> [--compliance=PACK@1,...]",
  );
  console.log(
    "  ./alz target check <intent-file>",
  );
  console.log(
    "  ./alz target explain <intent-file>",
  );
  console.log(
    "  ./alz recovery status [target-file]",
  );
  console.log(
    "  ./alz recovery test [target-file]",
  );
  console.log("  ./alz doctor");
  console.log("  ./alz verify");
  console.log("  ./alz plugins");
  console.log("  ./alz prompts");
  console.log("  ./alz models list");
  console.log("  ./alz models verify [--all]");
  console.log("  ./alz sbom");
  console.log("  ./alz scan");
  console.log();
  console.log(
    "ACT remains disabled. inspect/session use read-only provider access.",
  );
  console.log();
}

function verify(): void {
  console.log(
    "Verifying code, policy boundaries, compatibility, and core scenarios...",
  );

  run(
    localBin("tsc"),
    ["-p", "tsconfig.json", "--noEmit"],
  );

  const tests = readdirSync(
    resolve(root, "test"),
  )
    .filter((name) =>
      name.endsWith(".test.ts"),
    )
    .sort()
    .map((name) =>
      resolve(root, "test", name),
    );

  run(
    localBin("tsx"),
    ["--test", ...tests],
  );

  runTs("src/cli/security.ts");
  runTs("src/cli/plugins.ts");
  runTs("src/cli/toolbox.ts");

  for (const args of [
    [
      "--provider",
      "aws",
      "--mock",
      "brownfield",
    ],
    [
      "--provider",
      "azure",
      "--mock",
      "brownfield",
    ],
    [
      "--provider",
      "azure",
      "--mock",
      "greenfield",
    ],
    [
      "--provider",
      "aws",
      "--mock",
      "unknown",
    ],
  ]) {
    runTs(
      "src/cli/discover.ts",
      args,
    );
  }

  run(
    "npm",
    ["audit", "--audit-level=high"],
  );

  console.log();
  console.log("✓ operator verification complete");
}

function sbom(): void {
  const directory = resolve(
    root,
    ".runs",
    "sbom",
  );
  mkdirSync(
    directory,
    {
      recursive: true,
      mode: 0o700,
    },
  );

  const output = run(
    "npm",
    [
      "sbom",
      "--sbom-format=cyclonedx",
      "--package-lock-only",
    ],
    true,
  );

  const path = resolve(
    directory,
    "agent-private-landing-zone.cdx.json",
  );

  writeFileSync(
    path,
    output,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );

  console.log(
    "SBOM written to " + path,
  );
}

function scan(): void {
  run(
    "npm",
    ["audit", "--audit-level=high"],
  );

  const trivy = spawnSync(
    "trivy",
    ["--version"],
    {
      encoding: "utf8",
      shell: false,
      stdio: "ignore",
    },
  );

  if (trivy.status !== 0) {
    console.log(
      "Trivy is not installed locally; dependency audit passed. CI performs the full filesystem/misconfiguration scan.",
    );
    return;
  }

  run(
    "trivy",
    [
      "fs",
      "--scanners",
      "vuln,misconfig",
      "--severity",
      "HIGH,CRITICAL",
      "--exit-code",
      "1",
      root,
    ],
  );
}

const argv =
  process.argv.slice(2);

const [
  command = "help",
  first,
  second,
  third,
] = argv;

try {
  if (
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    help();
  } else if (
    command === "demo" ||
    command === "design"
  ) {
    const p = choice(
      first,
      ["aws", "azure"],
      "aws",
    );
    const e = choice(
      second,
      [
        "terraform",
        "pulumi",
        "opentofu",
        "bicep",
        "cloudformation",
        "cdk",
        "crossplane",
        "ansible",
      ],
      "terraform",
    );
    const s = choice(
      third,
      [
        "brownfield",
        "greenfield",
        "unknown",
      ],
      "brownfield",
    );

    runTs(
      "src/demo.ts",
      [
        "--provider",
        p,
        "--engine",
        e,
        "--scenario",
        s,
      ],
    );
  } else if (command === "inspect") {
    const p = choice(
      first,
      ["aws", "azure"],
      "aws",
    );

    runTs(
      "src/cli/discover.ts",
      [
        "--provider",
        p,
        "--resources",
      ],
    );
  } else if (command === "session") {
    const p = choice(
      first,
      ["aws", "azure"],
      "aws",
    );
    const e = choice(
      second,
      [
        "terraform",
        "pulumi",
        "opentofu",
        "bicep",
        "cloudformation",
        "cdk",
        "crossplane",
        "ansible",
      ],
      "terraform",
    );

    runTs(
      "src/cli/session.ts",
      [
        "--provider",
        p,
        "--engine",
        e,
      ],
    );
  } else if (command === "target") {
    if (first === "init") {
      const answers =
        argv.slice(2, 9);
      const complianceFlag =
        argv
          .slice(9)
          .find((value) =>
            value.startsWith(
              "--compliance=",
            ),
          );
      const compliancePacks =
        complianceFlag
          ? complianceFlag
              .slice(
                "--compliance=".length,
              )
              .split(",")
              .filter(Boolean)
          : [];

      const intent =
        recoveryIntentFromAnswers(
          answers,
          compliancePacks,
        );
      const directory =
        resolve(
          root,
          "config",
          "recovery-intents",
        );

      mkdirSync(
        directory,
        {
          recursive: true,
          mode: 0o700,
        },
      );

      const path =
        resolve(
          directory,
          intent.targetId +
            ".json",
        );

      writeFileSync(
        path,
        JSON.stringify(
          intent,
          null,
          2,
        ) + "\n",
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );

      console.log(
        "Target intent saved: " +
          path,
      );
      console.log(
        "No infrastructure changes were made.",
      );
    } else if (
      first === "check" ||
      first === "explain"
    ) {
      if (!second) {
        throw new Error(
          [
            "Problem: an intent file is required.",
            "Recommended fix: provide a JSON file created by ./alz target init.",
            "Safe alternative: run ./alz target init to create one.",
            "No infrastructure changes were made.",
          ].join("\n"),
        );
      }

      const path =
        workspacePath(second);
      const intent =
        parseRecoveryTargetIntent(
          JSON.parse(
            readFileSync(
              path,
              "utf8",
            ),
          ) as unknown,
        );

      if (first === "check") {
        console.log(
          "Target intent is valid.",
        );
        console.log(
          "Ready for deterministic compilation when approved design and provider-edge destination evidence are available.",
        );
        console.log(
          "No infrastructure changes were made.",
        );
      } else {
        console.log();
        console.log(
          explainRecoveryIntent(
            intent,
          ),
        );
        console.log();
        console.log(
          "No infrastructure changes were made.",
        );
      }
    } else {
      throw new Error(
        [
          "Problem: unknown target command.",
          "Recommended fix: use target init, target check, or target explain.",
          "Safe alternative: run ./alz help.",
          "No infrastructure changes were made.",
        ].join("\n"),
      );
    }
  } else if (
    command === "recovery"
  ) {
    if (
      first !== "status" &&
      first !== "test"
    ) {
      throw new Error(
        [
          "Problem: unknown recovery command.",
          "Recommended fix: use recovery status or recovery test.",
          "Safe alternative: use the conversational recovery workflow for explanation.",
          "No infrastructure changes were made.",
        ].join("\n"),
      );
    }

    const targetFile =
      workspacePath(
        second ??
          process.env
            .AGENTIC_RECOVERY_TARGETS_FILE ??
          "config/recovery-targets.json",
      );

    const targets =
      parseRecoveryTargets(
        JSON.parse(
          readFileSync(
            targetFile,
            "utf8",
          ),
        ) as unknown,
      );

    for (const target of
      targets) {
      const result =
        first === "status"
          ? recoveryTargetStatus(
              target,
            )
          : recoveryTestReadiness(
              target,
            );

      console.log();
      console.log(
        result.lines.join(
          "\n",
        ),
      );
    }
  } else if (command === "doctor") {
    runTs("src/cli/security.ts");
    runTs("src/cli/plugins.ts");
    runTs("src/cli/toolbox.ts");
  } else if (command === "verify") {
    verify();
  } else if (command === "plugins") {
    runTs("src/cli/plugins.ts");
  } else if (
    command === "prompts" ||
    command === "prompt-guide"
  ) {
    console.log();
    console.log(promptGuide());
  } else if (command === "models") {
    runTs(
      "src/cli/models.ts",
      [first, second, third].filter(
        (value): value is string =>
          Boolean(value),
      ),
    );
  } else if (command === "sbom") {
    sbom();
  } else if (command === "scan") {
    scan();
  } else {
    help();
    process.exitCode = 2;
  }
} catch (error) {
  console.error();
  console.error(
    error instanceof Error
      ? error.message
      : "Operator command failed.",
  );
  process.exitCode = 1;
}
