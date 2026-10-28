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

/**
 * The official package hashes of each reviewed provider version (review of #327, round 6), so a lock can only name HashiCorp's own
 * packages. Provenance, 2026-10-28: the release files from releases.hashicorp.com, whose `SHA256SUMS` carries a good signature from
 * HashiCorp's key (primary fingerprint C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F). `zh:` is each platform zip's sha256 as
 * that signed file lists it (every platform); `h1:` is what Terraform 1.16.4 `providers lock` computed from the signature-verified
 * linux_amd64 and darwin_arm64 zips. A lock entry for a reviewed version must name at least one hash, and every hash it names must be
 * one of these; any other is refused (`PROVIDER_HASH_NOT_OFFICIAL`). Another platform's `h1:` is added here by a reviewed commit.
 */
export const OFFICIAL_PROVIDER_HASHES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  "registry.terraform.io/hashicorp/aws 6.68.0": new Set([
    "h1:79hHQtjGSCiXBZK+VDiNUdI2SLXbNaHf+CHySvKFnvA=", // linux_amd64
    "h1:rB2Amjxr32AZWeWsDMQyU61xmW8IvSAUXhv4ogvx9l4=", // darwin_arm64
    "zh:96ba7624b6f0e0a1fa5477b0838194be919d815d30ce7f97e04d4520cca4c00b", "zh:f292ad91c97ac7354a04a698f346c2a0c3866d9170ca45dda6a6bfab71180be0",
    "zh:f4d293cd0e9562bfa1ba32a1fe5c3652c6a32b951e44081158737d4075696045", "zh:e4252ceda8641bfe85ad7710b428f994c080bde6c55043ab47a08015432cebdc",
    "zh:20ede4bb730b55023ad426ed13b1b4b295fac4bcc2baa4fb63d2932aa15d760d", "zh:889b15a5c2f7fb168c04c846e75932a6b2ceb7967c3bfa0a0e24be16cdee7969",
    "zh:b2511842cb6b23036c72babbaf12b4984835bb2824f938882330b51c68bdaecd", "zh:064ed007a33a22d8367db88b18d56a4dd066f07f95b1a4d80ffa2b6ee803f6f0",
    "zh:abd449fbf38cf828b8b17bc8540752733dd861160504a45b411e72e1792c758c", "zh:aa5cfdd2faf8a2848c72c13ca88786b857fd397aa713967b8b1f9610f2c76a0b",
    "zh:c11e8860c4d611dda93da2e5be27c9bd2599da6ad320f3d12ccc714ffbe6f100", "zh:7840197f73f53d676373c9aeabccd79c61c6da6e4aa1ed840e57ca46c1894126",
    "zh:490cffbc315ba21f740158a6b4195e7707ec2ee7ed357a47bb90ed18466f01a2", "zh:a83e9d46de040fa7bc56f7aa53bdeb8d7078bac65d9155b07022fd75723308b8",
    "zh:9b41c2afe2fec1a1880f9427b3ca611abfe6643b41942556a83cd7daae55acf1",
  ]),
  "registry.terraform.io/hashicorp/azurerm 4.81.0": new Set([
    "h1:olVprUWhmFTARlydw/r7VIx4fata2gy3zsAWfPGRrhg=", // linux_amd64
    "h1:XhToZua4gtih1Kv8RdStcfND83G4Tmb6GZFT4jEUhDU=", // darwin_arm64
    "zh:e60f1e9fb45df6defade2855ed6e68547409ea75d30655c556adb0c08579749b", "zh:f901d12ec82f3f8b5880a27b5cbcd7bd0d97e60c9367a2d7ed82fdd1157b39ff",
    "zh:12afb524e232fe4e3d6161927724af5dfa4831d71edd9c174917ca9b7377bfae", "zh:6beb95a3ef2f2d9c76abaa48e5450e90686a3fb6a47f1cb0ff7c5e94b6960151",
    "zh:0732e7b74264ddfa2b90ba69d01c283d3cbae9f72ed3e506c6ac92529fed7fd3", "zh:dec373b9390fa95e257291acd018ed65a7d512b428645d35e22cdbe8b245a08b",
    "zh:79a8d17fefe647040fcb9ee8821a4f09f395427c4fd49493489b9a93a9a1038e", "zh:705e075fb5ffc4bf66fd7cbabf1a65007a41621e80030a2c158a4c83b6046216",
    "zh:facf68ea5bf0f2b8ba720e7fba5f86492e1d4c591100460bb91c3f79f391f4b6", "zh:8cc3f900b3774c0ae37ae42365c4579a199cf9e5edf88e476fdf5ab1048f84ea",
    "zh:169d619ae202c4145e02fb706fb7c3679445ab3e3ff722edbf89597517a8c92e",
  ]),
});

const HASH = /^(h1:[A-Za-z0-9+/]{43}=|zh:[0-9a-f]{64})$/;
/** Each provider block's `hashes`, by source. Strict: a hash list that is not a list of well-formed `h1:`/`zh:` strings is refused. */
export function lockedHashes(text: string): Map<string, string[]> {
  lockedProviders(text);
  const found = new Map<string, string[]>();
  for (const [, source, body] of text.matchAll(/^provider\s+"([^"\n]+)"\s*\{\n([\s\S]*?)^\}/gm)) {
    const lists = [...body.matchAll(/^\s*hashes\s*=\s*\[([^\]]*)\]\s*$/gm)];
    if (lists.length > 1 || (lists.length === 0 && /hashes/.test(body))) throw new LockFileError("LOCK_FILE_UNREADABLE", "The lock file has a hash list this app cannot read safely: " + source.slice(0, 120));
    const items = lists.length === 0 ? [] : lists[0][1].split(",").map((item) => item.trim()).filter(Boolean);
    const hashes = items.map((item) => /^"([^"\n]*)"$/.exec(item)?.[1] ?? "");
    if (hashes.some((hash) => !HASH.test(hash))) throw new LockFileError("LOCK_FILE_UNREADABLE", "The lock file has a hash this app cannot read safely: " + source.slice(0, 120));
    found.set(source, hashes);
  }
  return found;
}

/** The first reviewed-version entry whose hashes are missing or not all official, or undefined. */
export function unofficialProviderHash(text: string): { source: string; version: string } | undefined {
  const hashes = lockedHashes(text);
  for (const { source, version } of lockedProviders(text)) {
    const official = OFFICIAL_PROVIDER_HASHES[source + " " + version];
    if (official === undefined) continue;
    const listed = hashes.get(source) ?? [];
    if (listed.length === 0 || listed.some((hash) => !official.has(hash))) return { source, version };
  }
  return undefined;
}
