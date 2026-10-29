import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import { join } from "node:path";

import { openLogNoFollow } from "./safe-write.js";

/**
 * How the runner starts a producer (`./alz qualify …`, `./alz apply …`) and what that child receives.
 *
 * The environment is built, never inherited (docs/evidence-runner.md, "Identities"; delegated decision 2, #39 6433391052):
 *
 *  - a short allowlist of terminal and locale variables and `PATH`, so `./alz` can find `node` and `git`;
 *  - `HOME` replaced by a private, empty folder of the run, so no child can read the operator's CLI logins (`~/.aws`,
 *    `~/.azure`, `~/.config/gcloud`), `~/.terraformrc` or anything else under the real home;
 *  - the pilot's federated identity channel, `ALZ_*`, except any variable whose name says it holds a static secret, which
 *    refuses the step by name instead (the runner forwards references such as token-file paths and role ARNs, never a
 *    credential);
 *  - `AGENTIC_EVIDENCE_KEY_FILE`, the path of the local evidence key (the console's job environment does the same), never
 *    `AGENTIC_EVIDENCE_KEY` itself;
 *  - for the read-only provider producers only, the federated markers they check for (`AZURE_FEDERATED_TOKEN_FILE`).
 *
 * Everything else is dropped, notably the operator's session: `AWS_PROFILE`, AWS keys and session tokens, `AWS_CONFIG_FILE`,
 * `AZURE_CONFIG_DIR`, `ARM_*`, `CLOUDSDK_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GITHUB_TOKEN`, `SSH_AUTH_SOCK`, `NODE_OPTIONS`
 * and loader variables. `test/evidence-stages.test.ts` runs a real child and checks this against a list of session variables.
 */
const PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TERM", "COLORTERM", "TZ", "COLUMNS", "LINES", "NO_COLOR", "USER", "LOGNAME", "TMPDIR"];
/** Federated markers a read-only producer checks for by presence (src/qualification/identity.ts). A path, not a credential. */
export const READONLY_FEDERATED_MARKERS = ["AZURE_FEDERATED_TOKEN_FILE"];
/**
 * `ALZ_*` names that would carry a static secret, not a reference: never forwarded; the step is refused naming them. Matched
 * without regard to case, so a Terraform input such as `ALZ_DISCOVERY_TF_VAR_db_password` is caught too (review N1 on #349),
 * as are Terraform registry tokens (`TF_TOKEN_*`) and inline Google credentials (`GOOGLE_CREDENTIALS`). A file path such as
 * `GOOGLE_APPLICATION_CREDENTIALS` or a `*_TOKEN_FILE` is a reference and is forwarded.
 */
const STATIC_SECRET = /(ACCESS_KEY_ID|SECRET|SESSION_TOKEN|CLIENT_CERTIFICATE|PASSWORD|PASSPHRASE|PRIVATE_KEY|(^|_)TF_TOKEN_|(^|_)GOOGLE_CREDENTIALS$|_TOKEN$|_KEY$)/i;
/** The evidence key's default path, as the vault and the console compute it (src/evidence/vault.ts, src/operator-ui/server.ts). */
const EVIDENCE_KEY_DEFAULT = [".config", "agentic-landing-zone", "evidence.key"];

export type ChildEnvironment = { ok: true; env: Record<string, string> } | { ok: false; refused: string[] };

/**
 * The environment of one child. `home` is the run's private folder that stands in for `HOME`; `realHome` only locates the
 * default evidence key file, whose path (never its content) is passed on.
 */
export function childEnvironment(parent: NodeJS.ProcessEnv, options: { home: string; realHome?: string; readonlyProducer?: boolean }): ChildEnvironment {
  const env: Record<string, string> = {};
  const refused: string[] = [];
  for (const name of PASSTHROUGH) {
    const value = parent[name];
    if (typeof value === "string" && value !== "") env[name] = value;
  }
  for (const [name, value] of Object.entries(parent)) {
    if (!name.startsWith("ALZ_") || typeof value !== "string" || value === "") continue;
    if (STATIC_SECRET.test(name.slice(4))) { refused.push(name); continue; }
    env[name] = value;
  }
  if (options.readonlyProducer) {
    for (const name of READONLY_FEDERATED_MARKERS) {
      const value = parent[name];
      if (typeof value === "string" && value !== "") env[name] = value;
    }
  }
  const keyFile = parent.AGENTIC_EVIDENCE_KEY_FILE ?? (options.realHome ? join(options.realHome, ...EVIDENCE_KEY_DEFAULT) : undefined);
  if (keyFile) env.AGENTIC_EVIDENCE_KEY_FILE = keyFile;
  env.HOME = options.home;
  if (refused.length > 0) return { ok: false, refused: refused.sort() };
  return { ok: true, env };
}

/**
 * How a child's standard streams are connected. `TERMINAL`: all three are the person's terminal, inherited, so every prompt
 * of `./alz apply` is answered by the person and the runner holds no pipe to the child's input (it cannot answer for them).
 * `LOGGED`: no input at all, and the output goes to a log file of the run (quiet by default; AGENTS.md, output budget).
 */
export type ChildIo = { kind: "TERMINAL" } | { kind: "LOGGED"; logFile: string };
export type ChildRequest = { command: string; args: string[]; cwd: string; env: Record<string, string>; io: ChildIo };
export type ChildResult = { exitCode: number | null; signal: string | null; error?: string };
/** Starts one child and waits for it. Production is `spawnChild`; tests pass a fake that records each request. */
export type Spawner = (request: ChildRequest) => Promise<ChildResult>;

/** The stdio a request maps to. Exported so a test can pin that a TERMINAL child's stdin is inherited, never a pipe. */
export function stdioOf(io: ChildIo, logFd?: number): ["inherit", "inherit", "inherit"] | ["ignore", number, number] {
  if (io.kind === "TERMINAL") return ["inherit", "inherit", "inherit"];
  if (logFd === undefined) throw new Error("A logged child needs its log file open.");
  return ["ignore", logFd, logFd];
}

export const spawnChild: Spawner = (request) => new Promise((done) => {
  let logFd: number | undefined;
  try {
    if (request.io.kind === "LOGGED") logFd = openLogNoFollow(request.io.logFile);
  } catch (error) {
    done({ exitCode: null, signal: null, error: (error as Error).message });
    return;
  }
  const close = () => { if (logFd !== undefined) { try { closeSync(logFd); } catch { /* already closed */ } logFd = undefined; } };
  let child;
  try {
    child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: stdioOf(request.io, logFd), shell: false, windowsHide: true });
  } catch (error) {
    close();
    done({ exitCode: null, signal: null, error: (error as Error).message });
    return;
  }
  child.once("error", (error) => { close(); done({ exitCode: null, signal: null, error: error.message }); });
  child.once("close", (code, signal) => { close(); done({ exitCode: code, signal }); });
});

/** The `./alz` launcher of the repository, which the runner starts with arguments (never through a shell). */
export const launcherOf = (root: string): string => join(root, "alz");
