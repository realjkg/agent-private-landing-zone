import type {
  DesignSpec,
} from "./types.js";
import {
  writeEncryptedEvidence,
} from "../evidence/vault.js";

export async function writeDesignSpec(
  design: DesignSpec,
): Promise<string> {
  const filename =
    design.generatedAt
      .replace(/[:.]/g, "-") +
    "-" +
    design.provider.toLowerCase() +
    "-" +
    design.designId;

  return writeEncryptedEvidence(
    "design",
    filename,
    design,
  );
}
