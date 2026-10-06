import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentState } from "./types.js";

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function writeAgentRun(
  state: AgentState,
): Promise<string> {
  const directory = join(".runs", "agent");
  await mkdir(directory, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");

  const filename =
    \`\${timestamp}-\${sanitize(state.provider)}-\${sanitize(state.intent)}.json\`;

  const path = join(directory, filename);

  await writeFile(
    path,
    JSON.stringify(state, null, 2) + "\\n",
    "utf8",
  );

  return path;
}

export function phaseDurations(
  state: AgentState,
): Array<{
  phase: string;
  durationMs: number;
}> {
  return state.events
    .filter(
      (event) =>
        typeof event.durationMs === "number",
    )
    .map((event) => ({
      phase: event.phase,
      durationMs: event.durationMs ?? 0,
    }));
}
