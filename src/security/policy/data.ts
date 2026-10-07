import type {
  DataClassification,
  DataHandlingPolicy,
  SecretReference,
} from "./types.js";

export function baselineHandlingPolicy(
  classification: DataClassification,
): DataHandlingPolicy {
  switch (classification) {
    case "PUBLIC":
      return {
        classification,
        externalModelAllowed: true,
        externalStorageAllowed: true,
        secretMaterialAllowed: false,
        retentionClass: "STANDARD",
      };

    case "INTERNAL":
      return {
        classification,
        externalModelAllowed: false,
        externalStorageAllowed: false,
        secretMaterialAllowed: false,
        retentionClass: "STANDARD",
      };

    case "CONFIDENTIAL":
      return {
        classification,
        externalModelAllowed: false,
        externalStorageAllowed: false,
        secretMaterialAllowed: false,
        retentionClass: "REGULATED",
      };

    case "RESTRICTED":
      return {
        classification,
        externalModelAllowed: false,
        externalStorageAllowed: false,
        secretMaterialAllowed: false,
        retentionClass: "REGULATED",
      };
  }
}

export function exposeSecretReference(
  reference: SecretReference,
): SecretReference {
  return {
    ref: reference.ref,
    kind: reference.kind,
    owner: reference.owner,
    scope: reference.scope,
    metadata: {
      ...reference.metadata,
    },
  };
}
