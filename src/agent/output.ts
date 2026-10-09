import type { AgentState } from "./types.js";
import { writeEncryptedEvidence } from "../evidence/vault.js";
import type {
  Emitter,
} from "../observability/bus.js";

function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function writeAgentRun(
  state: AgentState,
  emitter?: Emitter,
): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "");

  const filename =
    timestamp +
    "-" +
    sanitize(state.provider) +
    "-" +
    sanitize(state.intent);

  return writeEncryptedEvidence(
    "agent",
    filename,
    state,
    emitter,
  );
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
