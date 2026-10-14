import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalOperatorServer, missingWorkspaceBuild } from "../operator-ui/server.js";
import { startObservabilityRuntime } from "../observability/runtime.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Long-running runtime: the loopback health/readiness/metrics doors come up
// with the web UI. A taken ALZ_HEALTH_PORT degrades to one warn line — the
// workspace keeps serving.
const observability = await startObservabilityRuntime({ serve: true });

const { server, pilotToken } = createLocalOperatorServer({ root });

function worktreeDirty(directory: string): boolean {
  try {
    return execFileSync("git", ["status", "--porcelain"],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
  } catch {
    return false; // Not a git checkout, or git missing: nothing to report here.
  }
}
const port = Number.parseInt(process.env.ALZ_OPERATOR_PORT ?? "8788", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("ALZ_OPERATOR_PORT must be an unprivileged local TCP port");
}
server.listen(port, "127.0.0.1", () => {
  console.log("Sovereign ALZ — local browser workspace");
  console.log("Open http://127.0.0.1:" + port + " on this machine.");
  // Auto-open only following affirmative interactive setup consent, macOS only.
  // No shell interpolation, remote destination or implicit browser launch by ./alz workspace.
  if (process.platform === "darwin" && process.env.ALZ_OPEN_BROWSER === "1") {
    const opener = spawn("/usr/bin/open", ["http://127.0.0.1:" + port], {
      stdio: "ignore", detached: true,
    });
    opener.on("error", () => console.log("Open the local URL above in your browser."));
    opener.unref();
  }
  if (observability.healthAddress) {
    console.log(
      "Observability " +
        observability.healthAddress +
        " (loopback-only /healthz /readyz /metrics)",
    );
  }
  console.log("ACT DISABLED unless the pinned pilot contract enables it; synthetic scenarios require no cloud access.");
  // The pilot apply wizard (docs/act-pilot-walkthrough.md) runs in this console only for a person who pastes this session token.
  // It is printed here, in your terminal, and nowhere else: not in the page, a link or a log. It changes at every start.
  console.log("Pilot apply session token (paste it into the wizard once; keep it private; it ends when this console stops):");
  console.log("  " + pilotToken);
  // First-run readiness: say up front what would block every run, instead of
  // leaving the operator to discover it in the browser. Advisory only — the
  // workspace still serves, and each workflow keeps its own checks.
  const missing = missingWorkspaceBuild(root);
  if (missing.length > 0) {
    console.log("SETUP INCOMPLETE — missing build output: " + missing.join(", "));
    console.log("  Run ./alz bootstrap (or: npm run build && npm run build:ui), then restart.");
  }
  if (worktreeDirty(root)) {
    console.log("NOTE — this checkout has uncommitted changes. Workflows refuse to run");
    console.log("  until they are committed or stashed, so evidence names an exact commit.");
  }
  console.log("Ctrl+C ends the local session.");
});
