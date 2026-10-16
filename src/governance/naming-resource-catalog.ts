import { createHash } from "node:crypto";
import type { BrownfieldProvider } from "./brownfield-reuse.js";

export const NAMING_RESOURCE_KINDS = [
  "APP_LOGICAL_KEY", "AWS_S3_BUCKET", "AZURE_STORAGE_ACCOUNT", "GCP_PROJECT_ID",
] as const;
export type NamingResourceKind = typeof NAMING_RESOURCE_KINDS[number];
export type PhysicalNameIntent = {
  provider: BrownfieldProvider;
  kind: NamingResourceKind;
  proposedName: string;
  operation: "REFERENCE_EXISTING" | "CREATE_NEW" | "RENAME_EXISTING";
  /** Existing customer-owned resource ID is never made an ALZ-managed asset. */
  existingName?: string;
  namespace: {
    scope: string;
    inventoryComplete: boolean;
    existing: string[];
    reserved: string[];
  };
};
export type PhysicalNameAssessment = {
  kind: NamingResourceKind;
  verdict: "BLOCK" | "REVIEW" | "LEXICAL_MATCH_PENDING_AUTHORITY";
  reasons: string[];
  uniquenessAttested: false;
  infrastructureMutationAllowed: false;
  providerCalls: 0;
  evidenceKind: "CUSTOMER_REPORTED_NAME_INVENTORY_NOT_ATTESTED";
  sha256: string;
};
const safeName = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 256;
const safeNamespace = (v: unknown): v is string => safeName(v) && !v.includes("..");
const reservedS3Prefix = /^(xn--|sthree-|amzn-s3-demo-)/;
const reservedS3Suffix = /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/;

export function assessPhysicalResourceName(input: PhysicalNameIntent): PhysicalNameAssessment {
  const block: string[] = [], review: string[] = [];
  const kind = input?.kind;
  const name = input?.proposedName;
  const namespace = input?.namespace;
  if (!NAMING_RESOURCE_KINDS.includes(kind) ||
    !safeNamespace(namespace?.scope) || !Array.isArray(namespace?.existing) ||
    !Array.isArray(namespace?.reserved) ||
    ![...namespace.existing, ...namespace.reserved].every(safeName)) {
    block.push("Name kind, inventory or namespace is malformed.");
  }
  const providerFor: Record<NamingResourceKind, BrownfieldProvider | null> = {
    APP_LOGICAL_KEY: null, AWS_S3_BUCKET: "AWS",
    AZURE_STORAGE_ACCOUNT: "AZURE", GCP_PROJECT_ID: "GCP",
  };
  if (providerFor[kind] && input?.provider !== providerFor[kind]) {
    block.push("Resource naming profile does not match the declared hyperscaler.");
  }
  if (!safeName(name)) block.push("Resource name is missing or oversized.");
  else switch (kind) {
    case "APP_LOGICAL_KEY":
      if (!/^[a-z][a-z0-9-]{1,61}$/.test(name) || name.endsWith("-"))
        block.push("Application logical key must use the reviewed lowercase/hyphen profile.");
      break;
    case "AWS_S3_BUCKET":
      if (name.length < 3 || name.length > 63 ||
        !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(name) ||
        name.includes("..") || name.includes(".-") || name.includes("-.") ||
        reservedS3Prefix.test(name) || reservedS3Suffix.test(name) ||
        /^(?:\d{1,3}\.){3}\d{1,3}$/.test(name))
        block.push("S3 general-purpose bucket name violates format or reserved-name rules.");
      break;
    case "AZURE_STORAGE_ACCOUNT":
      if (!/^[a-z0-9]{3,24}$/.test(name))
        block.push("Azure Storage account must be 3–24 lowercase letters or digits.");
      break;
    case "GCP_PROJECT_ID":
      if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(name) ||
        /google|ssl/.test(name))
        block.push("GCP project ID violates length, character or reserved-word restrictions.");
      break;
  }
  if (input?.operation === "RENAME_EXISTING") {
    block.push("An existing physical resource name cannot be changed by an application-label-only operation.");
  } else if (input?.operation === "REFERENCE_EXISTING") {
    if (!safeName(input.existingName) || input.existingName !== name)
      block.push("Existing resource reference must preserve its exact physical name.");
  } else if (input?.operation !== "CREATE_NEW") {
    block.push("Unknown physical resource naming operation.");
  }
  if (namespace && safeName(name) && [...namespace.existing, ...namespace.reserved].some(
    (v) => v.toLowerCase() === name.toLowerCase())) {
    const legitimateReference = input.operation === "REFERENCE_EXISTING" &&
      namespace.existing.includes(name) && !namespace.reserved.includes(name);
    if (!legitimateReference) block.push("Resource name collides with a declared existing or reserved name.");
  }
  if (namespace?.inventoryComplete !== true)
    review.push("Namespace inventory is incomplete.");
  if (["AWS_S3_BUCKET", "AZURE_STORAGE_ACCOUNT", "GCP_PROJECT_ID"].includes(kind))
    review.push("Cloud-global or partition-scoped availability cannot be independently verified offline.");
  if (input.operation === "REFERENCE_EXISTING")
    review.push("Customer-owned resource identity and state binding require independent read-only verification.");
  const verdict = block.length ? "BLOCK" as const :
    review.length ? "REVIEW" as const : "LEXICAL_MATCH_PENDING_AUTHORITY" as const;
  const canonical = {
    kind, verdict, reasons: [...new Set([...block, ...review])].sort(),
    uniquenessAttested: false as const, infrastructureMutationAllowed: false as const,
    providerCalls: 0 as const,
    evidenceKind: "CUSTOMER_REPORTED_NAME_INVENTORY_NOT_ATTESTED" as const,
  };
  return { ...canonical, sha256: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}
