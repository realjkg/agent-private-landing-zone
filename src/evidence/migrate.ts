import {
  readdir,
  readFile,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  basename,
  join,
} from "node:path";

import {
  writeEncryptedEvidence,
} from "./vault.js";

export type EvidenceMigrationResult = {
  migrated: number;
  sources: string[];
};

async function migrateJsonDirectory(
  directory: string,
  result: EvidenceMigrationResult,
): Promise<void> {
  if (!existsSync(directory)) {
    return;
  }

  const entries =
    await readdir(directory, {
      withFileTypes: true,
    });

  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".json")
    ) {
      continue;
    }

    const path = join(
      directory,
      entry.name,
    );
    const raw =
      await readFile(path, "utf8");

    let value: unknown;

    try {
      value = JSON.parse(raw);
    } catch {
      value = {
        encoding: "utf8",
        raw,
      };
    }

    await writeEncryptedEvidence(
      "legacy",
      "migrated-" +
        Date.now() +
        "-" +
        entry.name.replace(
          /[^a-zA-Z0-9._-]/g,
          "-",
        ),
      {
        source: path,
        migratedAt:
          new Date().toISOString(),
        value,
      },
    );

    await unlink(path);
    result.migrated += 1;
    result.sources.push(path);
  }
}

export async function migrateLegacyEvidence(): Promise<EvidenceMigrationResult> {
  const result: EvidenceMigrationResult = {
    migrated: 0,
    sources: [],
  };

  for (const directory of [
    join(".runs", "agent"),
    join(".runs", "build"),
    join(".runs", "discovery"),
  ]) {
    await migrateJsonDirectory(
      directory,
      result,
    );
  }

  for (const legacySqlite of [
    join(
      ".runs",
      "state",
      "agent-checkpoints.sqlite",
    ),
    join(
      ".runs",
      "state",
      "agent-checkpoints.sqlite-wal",
    ),
    join(
      ".runs",
      "state",
      "agent-checkpoints.sqlite-shm",
    ),
  ]) {
    if (!existsSync(legacySqlite)) {
      continue;
    }

    const raw =
      await readFile(legacySqlite);

    await writeEncryptedEvidence(
      "legacy",
      "migrated-" +
        Date.now() +
        "-" +
        basename(legacySqlite),
      {
        source: legacySqlite,
        migratedAt:
          new Date().toISOString(),
        encoding: "base64",
        value: raw.toString("base64"),
      },
    );

    await unlink(legacySqlite);
    result.migrated += 1;
    result.sources.push(
      legacySqlite,
    );
  }

  return result;
}


export async function findLegacyPlaintextEvidence(): Promise<string[]> {
  const found: string[] = [];

  for (const directory of [
    join(".runs", "agent"),
    join(".runs", "build"),
    join(".runs", "discovery"),
  ]) {
    if (!existsSync(directory)) {
      continue;
    }

    const entries =
      await readdir(directory, {
        withFileTypes: true,
      });

    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.endsWith(".json")
      ) {
        found.push(
          join(directory, entry.name),
        );
      }
    }
  }

  for (const legacySqlite of [
    join(
      ".runs",
      "state",
      "agent-checkpoints.sqlite",
    ),
    join(
      ".runs",
      "state",
      "agent-checkpoints.sqlite-wal",
    ),
    join(
      ".runs",
      "state",
      "agent-checkpoints.sqlite-shm",
    ),
  ]) {
    if (existsSync(legacySqlite)) {
      found.push(legacySqlite);
    }
  }

  return found;
}
