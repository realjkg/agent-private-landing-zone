import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  join,
} from "node:path";
import { homedir } from "node:os";

import type {
  Emitter,
} from "../observability/bus.js";

const VERSION = "evidence-v1" as const;
const ALGORITHM = "aes-256-gcm" as const;

export type EvidenceEnvelope = {
  version: typeof VERSION;
  algorithm: typeof ALGORITHM;
  createdAt: string;
  purpose: string;
  plaintextSha256: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

export type EvidenceKeyInfo = {
  source: "ENV" | "FILE";
  path?: string;
  securePermissions: boolean;
};

function sha256(value: Buffer): string {
  return createHash("sha256")
    .update(value)
    .digest("hex");
}

function defaultKeyPath(): string {
  return (
    process.env.AGENTIC_EVIDENCE_KEY_FILE ??
    join(
      homedir(),
      ".config",
      "agentic-landing-zone",
      "evidence.key",
    )
  );
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");

  if (key.length !== 32) {
    throw new Error(
      "EVIDENCE_KEY_INVALID: expected a 32-byte base64 key.",
    );
  }

  return key;
}

export async function ensureEvidenceKey(): Promise<{
  key: Buffer;
  info: EvidenceKeyInfo;
}> {
  const fromEnv =
    process.env.AGENTIC_EVIDENCE_KEY;

  if (fromEnv) {
    return {
      key: decodeKey(fromEnv),
      info: {
        source: "ENV",
        securePermissions: true,
      },
    };
  }

  const path = defaultKeyPath();

  await mkdir(dirname(path), {
    recursive: true,
    mode: 0o700,
  });

  try {
    const existing =
      await readFile(path, "utf8");
    const metadata = await stat(path);

    return {
      key: decodeKey(existing),
      info: {
        source: "FILE",
        path,
        securePermissions:
          (metadata.mode & 0o077) === 0,
      },
    };
  } catch (error) {
    const code =
      error &&
      typeof error === "object" &&
      "code" in error
        ? String(error.code)
        : "";

    if (code !== "ENOENT") {
      throw error;
    }
  }

  const key = randomBytes(32);

  await writeFile(
    path,
    key.toString("base64") + "\n",
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );

  return {
    key,
    info: {
      source: "FILE",
      path,
      securePermissions: true,
    },
  };
}

export function encryptEvidence(
  purpose: string,
  value: unknown,
  key: Buffer,
): EvidenceEnvelope {
  const plaintext = Buffer.from(
    JSON.stringify(value),
    "utf8",
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    ALGORITHM,
    key,
    iv,
  );
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: VERSION,
    algorithm: ALGORITHM,
    createdAt: new Date().toISOString(),
    purpose,
    plaintextSha256: sha256(plaintext),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptEvidence<T>(
  envelope: EvidenceEnvelope,
  key: Buffer,
): T {
  if (
    envelope.version !== VERSION ||
    envelope.algorithm !== ALGORITHM
  ) {
    throw new Error(
      "EVIDENCE_FORMAT_UNSUPPORTED",
    );
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(envelope.iv, "base64"),
  );

  decipher.setAuthTag(
    Buffer.from(
      envelope.authTag,
      "base64",
    ),
  );

  const plaintext = Buffer.concat([
    decipher.update(
      Buffer.from(
        envelope.ciphertext,
        "base64",
      ),
    ),
    decipher.final(),
  ]);

  if (
    sha256(plaintext) !==
    envelope.plaintextSha256
  ) {
    throw new Error(
      "EVIDENCE_INTEGRITY_MISMATCH",
    );
  }

  return JSON.parse(
    plaintext.toString("utf8"),
  ) as T;
}

export async function writeEncryptedEvidence(
  purpose: string,
  filename: string,
  value: unknown,
  emitter?: Emitter,
): Promise<string> {
  try {
    const { key, info } =
      await ensureEvidenceKey();

    if (!info.securePermissions) {
      throw new Error(
        "EVIDENCE_KEY_PERMISSIONS_INSECURE",
      );
    }

    const directory = join(
      ".runs",
      "evidence",
      purpose,
    );

    await mkdir(directory, {
      recursive: true,
      mode: 0o700,
    });

    const path = join(
      directory,
      filename + ".evidence",
    );

    const envelope =
      encryptEvidence(
        purpose,
        value,
        key,
      );

    await writeFile(
      path,
      JSON.stringify(envelope) + "\n",
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );

    emitter?.emit({
      signal: "evidence-lifecycle",
      status: "OK",
      component: "evidence-vault",
      attributes: {
        purpose,
        filename,
      },
    });

    return path;
  } catch (error) {
    // Every vault write failure is a real evidence-lifecycle occurrence.
    emitter?.emit({
      signal: "evidence-lifecycle",
      status: "FAILED",
      component: "evidence-vault",
      detail:
        error instanceof Error
          ? error.message
          : "evidence write failed",
      attributes: { purpose },
    });
    throw error;
  }
}

export async function readEncryptedEvidence<T>(
  path: string,
): Promise<T> {
  const { key, info } =
    await ensureEvidenceKey();

  if (!info.securePermissions) {
    throw new Error(
      "EVIDENCE_KEY_PERMISSIONS_INSECURE",
    );
  }

  const raw =
    await readFile(path, "utf8");

  return decryptEvidence<T>(
    JSON.parse(raw) as EvidenceEnvelope,
    key,
  );
}
