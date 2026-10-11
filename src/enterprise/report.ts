import { readFileSync } from "node:fs";

// Shared plumbing for the read-only ./alz enterprise reports: each report reads
// one JSON file (if it takes any), prints lines and exits 0 (clean), 2 (the
// checked document is rejected) or 1 (usage or unreadable input). A report
// calls no network, runs nothing and grants no authority.

export type Report = { lines: string[]; ok: boolean };

export function option(args: string[], name: string): string | undefined {
  const index = args.indexOf("--" + name);
  const value = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error("ENTERPRISE_ARGUMENT_REQUIRED: --" + name);
  return value;
}

export function jsonOption(args: string[], name: string): unknown {
  const path = option(args, name);
  return path === undefined ? undefined : JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The first line of an error, which for the libraries here is a stable code. */
export const reason = (error: unknown): string => (error instanceof Error ? error.message : "unknown error").split("\n")[0].slice(0, 300);

export async function runReport(build: (args: string[]) => Report | Promise<Report>, args = process.argv.slice(2)): Promise<void> {
  try {
    const report = await build(args);
    console.log(report.lines.join("\n"));
    process.exitCode = report.ok ? 0 : 2;
  } catch (error) {
    console.error("ENTERPRISE_REPORT_FAILED: " + reason(error));
    process.exitCode = 1;
  }
}
