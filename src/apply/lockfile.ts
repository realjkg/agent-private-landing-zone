/**
 * Reads provider sources and versions from a Terraform dependency lock file (`.terraform.lock.hcl`), so
 * `./alz apply prepare` records what the lock file pins instead of asking the operator. Only the `provider "..."`
 * blocks and their `version = "..."` line are read; anything unexpected is refused rather than guessed.
 */
import { AWS_DENIED_TYPES_REVIEWED_AGAINST } from "./providers/aws.js";
import { AZURE_DENIED_TYPES_REVIEWED_AGAINST } from "./providers/azure.js";

export type LockedProvider = { source: string; version: string };

const SOURCE = /^[a-z0-9.-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/;

export class LockFileError extends Error {
  constructor(readonly code: "LOCK_FILE_EMPTY" | "LOCK_FILE_UNREADABLE" | "LOCK_FILE_DUPLICATE_PROVIDER", message: string) {
    super(message);
  }
}

/**
 * Every provider block, sorted by source. A block without exactly one well-formed version is refused. Strict, so it can never
 * read less than Terraform does (review of #327, round 5): a carriage return anywhere, and the word `provider` anywhere outside
 * the blocks it read (an indented or otherwise unrecognized block, a lock that mentions a provider but parses to none), are
 * refused as unreadable. The engine's check after init (`provider_selections`) is the authoritative one; this is the early error.
 */
export function lockedProviders(text: string): LockedProvider[] {
  if (text.includes("\r")) throw new LockFileError("LOCK_FILE_UNREADABLE", "The lock file has carriage returns (CRLF line endings), which this app does not read. Rewrite it with terraform init and LF line endings.");
  const found: LockedProvider[] = [];
  const blocks = [...text.matchAll(/^provider\s+"([^"\n]+)"\s*\{\n([\s\S]*?)^\}/gm)];
  let rest = text;
  for (const block of blocks.slice().reverse()) rest = rest.slice(0, block.index) + rest.slice(block.index + block[0].length);
  if (/provider/i.test(rest)) {
    throw new LockFileError("LOCK_FILE_UNREADABLE", "The lock file names a provider in a form this app does not read (an indented or unrecognized block). Rewrite it with terraform init.");
  }
  for (const [, source, body] of blocks) {
    const versions = [...body.matchAll(/^\s*version\s*=\s*"([^"\n]*)"\s*$/gm)].map((match) => match[1]);
    if (!SOURCE.test(source) || versions.length !== 1 || !VERSION.test(versions[0])) {
      throw new LockFileError("LOCK_FILE_UNREADABLE", "The lock file has a provider entry this app cannot read safely: " + source.slice(0, 120));
    }
    if (found.some((entry) => entry.source === source)) {
      throw new LockFileError("LOCK_FILE_DUPLICATE_PROVIDER", "The lock file names a provider twice: " + source);
    }
    found.push({ source, version: versions[0] });
  }
  if (found.length === 0) throw new LockFileError("LOCK_FILE_EMPTY", "The lock file pins no providers. Run terraform init once in the project and commit the lock file.");
  return found.sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * The provider versions the pilot's denied-type lists were reviewed against, in full (review of #327, round 4): read from the
 * one source of truth beside each list (`AWS_DENIED_TYPES_REVIEWED_AGAINST`, `AZURE_DENIED_TYPES_REVIEWED_AGAINST`). A newer
 * schema can add a type that deploys a template or runs code at apply, which the lists would not name, so a lock file that pins
 * either provider at any other version is refused (`PROVIDER_VERSION_NOT_REVIEWED`). Bumping a provider means re-reviewing the
 * denied types against the new schema and changing the constant, in a reviewed commit. Other providers are not judged here.
 */
const reviewedVersionOf = (reviewed: string): [string, string] => {
  const match = /^hashicorp\/([a-z0-9_-]+) (\d+\.\d+\.\d+)$/.exec(reviewed);
  if (!match) throw new Error("A reviewed provider version is not of the form hashicorp/<name> <x.y.z>: " + reviewed);
  return ["registry.terraform.io/hashicorp/" + match[1], match[2]];
};
export const REVIEWED_PROVIDER_VERSIONS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  [AWS_DENIED_TYPES_REVIEWED_AGAINST, AZURE_DENIED_TYPES_REVIEWED_AGAINST].map(reviewedVersionOf),
));

/** The first locked aws or azurerm provider whose version is not the reviewed one, or undefined. */
export function unreviewedProviderVersion(providers: readonly LockedProvider[]): { source: string; locked: string; reviewed: string } | undefined {
  for (const { source, version } of providers) {
    const reviewed = REVIEWED_PROVIDER_VERSIONS[source];
    if (reviewed !== undefined && version !== reviewed) return { source, locked: version, reviewed };
  }
  return undefined;
}

/** The operator's sentence for a refused version, naming both versions. */
export const unreviewedVersionMessage = (found: { source: string; locked: string; reviewed: string }): string =>
  "The lock file pins " + found.source + " " + found.locked + ", but the pilot's denied-type lists were reviewed against " + found.reviewed +
  ". Lock " + found.reviewed + ", or re-review the denied types against the new schema and change the reviewed version in a reviewed commit before this version can be used.";
