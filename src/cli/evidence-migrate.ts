import {
  migrateLegacyEvidence,
} from "../evidence/migrate.js";

const result =
  await migrateLegacyEvidence();

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log("EVIDENCE MIGRATION");
console.log();
console.log(
  "Encrypted legacy records  " +
    result.migrated,
);

if (result.migrated === 0) {
  console.log(
    "No plaintext legacy evidence found.",
  );
} else {
  console.log(
    "Plaintext originals removed after successful encryption.",
  );
}

console.log();
