import {
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import {
  spawnSync,
} from "node:child_process";
import {
  resolve,
} from "node:path";
import {
  fileURLToPath,
} from "node:url";

const root = resolve(
  fileURLToPath(
    new URL("../..", import.meta.url),
  ),
);

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
  console.log("Agentic Landing Zone");
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
    "  ./alz session [aws|azure] [terraform|pulumi]",
  );
  console.log("  ./alz doctor");
  console.log("  ./alz verify");
  console.log("  ./alz plugins");
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
    "agentic-landing-zone.cdx.json",
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

const [
  command = "help",
  first,
  second,
  third,
] = process.argv.slice(2);

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
      ["terraform", "pulumi"],
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
  } else if (command === "doctor") {
    runTs("src/cli/security.ts");
    runTs("src/cli/plugins.ts");
    runTs("src/cli/toolbox.ts");
  } else if (command === "verify") {
    verify();
  } else if (command === "plugins") {
    runTs("src/cli/plugins.ts");
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
