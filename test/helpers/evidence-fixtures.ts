import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IdentityObservation, IdentityProbe } from "../../src/evidence-runner/preflight.js";
import type { RunnerDeps, Terminal } from "../../src/evidence-runner/run.js";
import type { Provider } from "../../src/evidence-runner/types.js";

/**
 * SYNTHETIC fixtures for the evidence runner's tests. Nothing here reaches a cloud: the repository root is a temporary
 * folder with copies of the release scope and the example configuration, the source commit is injected, and identity
 * probes are in-memory fakes that record which providers were asked.
 */
export const CANDIDATE = "0123456789abcdef0123456789abcdef01234567";
export const ACCOUNT = "111122223333";
export const TENANT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const SUBSCRIPTION = "11111111-2222-4333-8444-555555555555";

/** A credential-shaped value placed in the environment of every test run; it must never appear in anything written. */
export const CANARY = "AKIAEVIDENCECANARY00";

/** The shape the evidence runner reads to say ACT is authorized: an enabled contract with a non-empty authorize (the full check is ./alz apply preflight). */
export const AUTHORIZING_CONTRACT = { schemaVersion: 1, enabled: true, authorize: { DEV: ["APPLY"] } };

export function fixtureRoot(contract?: unknown): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "alz-evidence-")));
  mkdirSync(join(root, "config", "release"), { recursive: true });
  copyFileSync("config/release/scope.json", join(root, "config", "release", "scope.json"));
  copyFileSync("config/release/status.json", join(root, "config", "release", "status.json"));
  copyFileSync("config/evidence-runner.example.json", join(root, "config", "evidence-runner.example.json"));
  if (contract !== undefined) writeFileSync(join(root, "config", "act-pilot-contract.json"), typeof contract === "string" ? contract : JSON.stringify(contract));
  return root;
}

export function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, candidateCommit: CANDIDATE, targetHardwareId: "owner-mac-01", evidenceDir: ".runs/evidence",
    aws: { expectedAccountId: ACCOUNT, region: "eu-west-1", qualificationStack: "alz-qualification-noop" },
    azure: { expectedTenantId: TENANT, expectedSubscriptionId: SUBSCRIPTION, location: "westeurope" },
    ...overrides,
  };
}

export function writeConfig(root: string, config: Record<string, unknown>, path = "config/evidence-runner.json"): void {
  writeFileSync(join(root, path), JSON.stringify(config, null, 2));
}

export function scriptedTerminal(answers: string[], tty = true): Terminal & { asked: string[] } {
  const asked: string[] = [];
  return { stdinIsTTY: tty, stdoutIsTTY: tty, asked, ask: async (question) => { asked.push(question); return answers.shift() ?? ""; } };
}

export function fakeProbe(answers: Partial<Record<Provider, IdentityObservation>>): IdentityProbe & { calls: Provider[] } {
  const calls: Provider[] = [];
  const probe = (async (provider: Provider) => { calls.push(provider); return answers[provider] ?? { status: "PROBE_NOT_BUILT" }; }) as IdentityProbe & { calls: Provider[] };
  probe.calls = calls;
  return probe;
}

export const observedAws: IdentityObservation = { status: "OBSERVED", kind: "OPERATOR_CLI_LOGIN", accountId: ACCOUNT };
export const observedAzure: IdentityObservation = { status: "OBSERVED", kind: "OPERATOR_CLI_LOGIN", tenantId: TENANT, subscriptionId: SUBSCRIPTION };

export function fixtureDeps(root: string, overrides: Partial<RunnerDeps> = {}): RunnerDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    root,
    env: { AWS_SECRET_ACCESS_KEY: CANARY, AZURE_CLIENT_SECRET: CANARY, PATH: "/usr/bin" },
    terminal: scriptedTerminal([], false),
    host: "fixture-host",
    now: () => new Date("2026-10-27T00:00:00.000Z"),
    probe: fakeProbe({ aws: observedAws, azure: observedAzure }),
    source: () => ({ ok: true, commit: CANDIDATE, origin: "GIT_CHECKOUT" }),
    out: (line) => { lines.push(line); },
    pidAlive: () => true,
    lines,
    ...overrides,
  };
}
