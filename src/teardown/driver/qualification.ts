import { sha256 } from "../../build/provenance.js";
import { canonicalJson } from "../manifest.js";
import { DRIVER_ENGINES, type DriverEngine, type EngineAdapter } from "./types.js";

/**
 * Engine activation is qualification-based. An engine runs only when a record
 * says this adapter, with this exact argument list, was qualified against this
 * engine version. Each engine is judged alone: a qualified engine is never
 * held back by an unqualified one, and one engine's bad record disables only
 * that engine.
 */
export type QualificationRecord = {
  engine: DriverEngine;
  adapterVersion: string;
  engineVersion: string;
  argvDigest: string;
  qualifiedAt: string;
  /** Hash of the qualification evidence the record stands for. */
  evidenceHash: string;
};

export type EngineActivation =
  | { engine: DriverEngine; enabled: true; record: QualificationRecord }
  | { engine: DriverEngine; enabled: false; reason: string };

const HASH = /^[a-f0-9]{64}$/;

/** The digest an adapter pins: its exact argument lists, in order. */
export function argvDigest(argvs: readonly (readonly string[])[]): string {
  return sha256(canonicalJson(argvs));
}

function wellFormed(record: unknown): record is QualificationRecord {
  const r = record as Partial<QualificationRecord> | null;
  return !!r && typeof r === "object" &&
    (DRIVER_ENGINES as readonly string[]).includes(r.engine as string) &&
    typeof r.adapterVersion === "string" && r.adapterVersion.length > 0 &&
    typeof r.engineVersion === "string" && r.engineVersion.length > 0 &&
    typeof r.argvDigest === "string" && HASH.test(r.argvDigest) &&
    typeof r.qualifiedAt === "string" && !Number.isNaN(Date.parse(r.qualifiedAt)) &&
    typeof r.evidenceHash === "string" && HASH.test(r.evidenceHash);
}

/** Decides one engine from the records and adapters alone. */
export function engineActivation(
  engine: DriverEngine,
  records: readonly QualificationRecord[],
  adapters: readonly EngineAdapter[],
  engineVersion: string | undefined,
): EngineActivation {
  const deny = (reason: string): EngineActivation => ({
    engine, enabled: false, reason: engine + " is not enabled: " + reason,
  });
  const adapter = adapters.find((candidate) => candidate.engine === engine);
  if (!adapter) return deny("no adapter is registered for it.");
  if (!engineVersion) return deny("the request names no engine version to match a qualification against.");
  const own = records.filter((record) => wellFormed(record) && record.engine === engine);
  if (own.length === 0) {
    return deny("no qualification record exists. Qualify the adapter and supply a record for adapter version " +
      adapter.adapterVersion + ", engine version " + engineVersion + " and argv digest " + adapter.argvDigest + ".");
  }
  const match = own.find((record) => record.adapterVersion === adapter.adapterVersion &&
    record.argvDigest === adapter.argvDigest && record.engineVersion === engineVersion);
  if (match) return { engine, enabled: true, record: match };
  const missing: string[] = [];
  if (!own.some((record) => record.argvDigest === adapter.argvDigest)) {
    missing.push("argv digest " + adapter.argvDigest + " (the adapter's argument list changed since it was qualified)");
  }
  if (!own.some((record) => record.adapterVersion === adapter.adapterVersion)) {
    missing.push("adapter version " + adapter.adapterVersion);
  }
  if (!own.some((record) => record.engineVersion === engineVersion)) {
    missing.push("engine version " + engineVersion);
  }
  return deny("no single qualification record matches" +
    (missing.length > 0 ? "; no record has " + missing.join(", ") : " all of adapter version, engine version and argv digest together") +
    ". Re-qualify the adapter.");
}

/** Every engine's activation, each decided independently. */
export function enabledEngines(
  records: readonly QualificationRecord[],
  adapters: readonly EngineAdapter[],
  engineVersions: Partial<Record<DriverEngine, string>>,
): EngineActivation[] {
  return DRIVER_ENGINES.map((engine) => engineActivation(engine, records, adapters, engineVersions[engine]));
}
