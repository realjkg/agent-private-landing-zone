import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import type { ApplyEnvironment, ApplyRefusalCode, ApprovalSubject, ApproverEntry, ApprovalStatement, PilotContract, RequestStatement, SealedRequest, SignedApproval } from "./types.js";
import { canonicalPublicKey } from "./contract.js";
import { NonceStoreError, type NonceStore } from "./nonces.js";

/**
 * The single place approvals are verified (docs/act-pilot-plan.md, item 3).
 * An approval is an Ed25519 signature by a key on the reviewed contract's
 * approver allowlist over a statement binding artifact, environment, exact
 * target, expiry and a one-time nonce. A typed name is never proof, and neither
 * is the operator's OS username. Who requested is established by the requester's
 * own signature on the sealed request (`verifyRequestSignature`), made with an
 * allowlisted key at seal and bound into the artifact hash; where the
 * environment forbids a requester-approver (PROD), an approval from that id or
 * key is refused. Any invalid approval refuses the whole set.
 */
type ApprovalCode = Extract<
  ApplyRefusalCode,
  | "APPROVAL_INSUFFICIENT" | "APPROVAL_UNVERIFIED" | "APPROVER_NOT_ALLOWED" | "APPROVAL_EXPIRED"
  | "APPROVAL_REPLAYED" | "APPROVAL_MISBOUND" | "SAME_APPROVER_TWICE" | "APPROVER_IS_REQUESTER" | "REQUESTER_SIGNATURE_MISSING"
>;
type ApprovalVerdict =
  | { ok: true; approvers: { approverId: string; issuedAt: string }[] }
  | { ok: false; code: ApprovalCode; message: string };

/**
 * Domain separation: a signature over an approval statement is valid for nothing else, and an approval of one kind of
 * action is valid for no other kind. An apply approval signs the sealed plan's artifact hash under the apply domain; a
 * cleanup approval signs the cleanup proposal's hash under the cleanup domain (docs/act-pilot-plan.md, cleanup). The two
 * never verify against each other, whatever hash they name, so an apply approval can never authorize a cleanup. The same
 * holds for requests: the requester of an apply signs under the apply request domain, the requester of a cleanup under the
 * cleanup request domain, so a request signature is never carried from an apply onto a cleanup or back.
 */
const DOMAINS: Readonly<Record<ApprovalSubject, string>> = {
  APPLY: "alz-apply-approval-v1\n", CLEANUP: "alz-cleanup-approval-v1\n", REQUEST: "alz-apply-request-v1\n", CLEANUP_REQUEST: "alz-cleanup-request-v1\n",
};
/** The two request domains: the requester of an apply (a sealed plan) and the requester of a cleanup (a cleanup proposal). */
export type RequestSubject = Extract<ApprovalSubject, "REQUEST" | "CLEANUP_REQUEST">;

/**
 * Whether the requester of a change may also approve it (owner decisions on issue #39, 2026-10-27: 6432129534, 6432161993).
 * DEV and QA: one person may request and approve. PROD: three distinct people, the requester plus two approvers, and an
 * approval from the requester's key or id is refused. A frozen code constant, never a contract field or a flag, so no file or caller can widen it.
 * The same rule governs a cleanup (owner decision 6440801434, item 1: production cleanup uses the production apply quorum),
 * through the same check (`approverIsRequester`), so the two can never drift apart.
 */
export const REQUESTER_MAY_APPROVE: Readonly<Record<ApplyEnvironment, boolean>> = Object.freeze({ DEV: true, QA: true, PROD: false });

/** The verified requester of a change or a cleanup, as `verifyRequestSignature` returns it. */
export type VerifiedRequester = { requesterId: string; publicKeyCanonical: string };

/**
 * The one requester-separation check, for an apply and a cleanup, in the driver and in `approve`: true when the environment
 * forbids a requester-approver (`REQUESTER_MAY_APPROVE`) and this approver is the requester, by id (case-insensitive) or by
 * key under any id. `approverKeyCanonical` is the approver's public key in canonical form, or undefined when it is unknown.
 */
export function approverIsRequester(environment: ApplyEnvironment, approverId: string, approverKeyCanonical: string | undefined, requester: VerifiedRequester): boolean {
  // Fail closed: only an environment the frozen rule names as true lets the requester approve.
  if (REQUESTER_MAY_APPROVE[environment] === true) return false;
  return approverId.toLowerCase() === requester.requesterId.toLowerCase() || (approverKeyCanonical !== undefined && approverKeyCanonical === requester.publicKeyCanonical);
}
const REQUEST_KEYS = ["artifactSha256", "environment", "nonce", "requesterId", "schemaVersion"];
const SKEW_MS = 60_000;
const NONCE = /^[a-f0-9]{32}$/;
const STATEMENT_KEYS = ["approverId", "artifactSha256", "environment", "expiresAt", "issuedAt", "nonce", "schemaVersion", "target"];
const TARGET_KEYS = ["account", "backend", "workspace"];

const signedBytes = (statement: ApprovalStatement, subject: ApprovalSubject): Buffer => Buffer.from(DOMAINS[subject] + canonicalJson(statement));
const sameKeys = (value: object, keys: string[]): boolean => Object.keys(value).sort().join() === keys.join();
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Signs an approval of `subject` (default: an apply of a sealed plan). The statement's `artifactSha256` names the sealed plan's artifact, or the cleanup proposal's hash. */
export function signApproval(statement: ApprovalStatement, privateKeyPem: string, subject: ApprovalSubject = "APPLY"): SignedApproval {
  const signature = sign(null, signedBytes(statement, subject), createPrivateKey(privateKeyPem));
  return { statement, signatureBase64: signature.toString("base64") };
}

const requestBytes = (statement: RequestStatement, subject: RequestSubject): Buffer => Buffer.from(DOMAINS[subject] + canonicalJson(statement));

/**
 * The requester's signature over a sealed request (REQUEST, the default) or a cleanup proposal (CLEANUP_REQUEST): never valid as
 * an approval of anything, and a request of one kind never verifies as the other.
 */
export function signRequest(statement: RequestStatement, privateKeyPem: string, subject: RequestSubject = "REQUEST"): SealedRequest {
  return { statement, signatureBase64: sign(null, requestBytes(statement, subject), createPrivateKey(privateKeyPem)).toString("base64") };
}

/**
 * The key half of the requester check: the id is on the contract's allowlist and the key handed in is that entry's own.
 * Undefined when both hold. It does not judge the environment; every product path calls `requesterRefusal`, which does.
 */
export function requesterKeyRefusal(contract: PilotContract, requesterId: string, privateKeyPem: string): { ok: false; code: "REQUESTER_NOT_ALLOWED" | "REQUESTER_KEY_MISMATCH"; message: string } | undefined {
  const entry = contract.approvers.find((a) => a.id === requesterId);
  if (!entry) return { ok: false, code: "REQUESTER_NOT_ALLOWED", message: "The requester is not on the contract's allowlist. Nothing ran." };
  const offered = requesterPublicKey(privateKeyPem);
  if (offered === undefined || offered !== canonicalPublicKey(entry.publicKeyPem)) {
    return { ok: false, code: "REQUESTER_KEY_MISMATCH", message: "The key given is not the allowlisted key of requester " + entry.id + ". Nothing ran." };
  }
  return undefined;
}

/** Why a requester may not request in this environment: their allowlist entry does not name it. */
const requesterEnvironmentMessage = (requesterId: string, environment: ApplyEnvironment): string =>
  "The requester " + requesterId + " is not allowed to request in " + environment + ": their allowlist entry in the contract does not name " + environment + ".";

/**
 * The check before anything is signed or run on a requester's behalf, at seal, propose-cleanup and propose-removal: the id is on
 * the contract's allowlist, the entry's own `environments` name this environment (a requester allowed only in DEV cannot
 * request a QA or PROD change, cleanup or removal), and the key handed in is that entry's own. Undefined when all hold.
 * `verifyRequestSignature` applies the same environment rule wherever a request is verified.
 */
export function requesterRefusal(contract: PilotContract, environment: ApplyEnvironment, requesterId: string, privateKeyPem: string): { ok: false; code: "REQUESTER_NOT_ALLOWED" | "REQUESTER_KEY_MISMATCH"; message: string } | undefined {
  const keyRefusal = requesterKeyRefusal(contract, requesterId, privateKeyPem);
  if (keyRefusal) return keyRefusal;
  const entry = contract.approvers.find((a) => a.id === requesterId) as ApproverEntry;
  if (!entry.environments.includes(environment)) return { ok: false, code: "REQUESTER_NOT_ALLOWED", message: requesterEnvironmentMessage(requesterId, environment) + " Nothing ran." };
  return undefined;
}

/** The public half of a requester's key, canonical, or undefined for anything that is not an Ed25519 private key. */
export function requesterPublicKey(privateKeyPem: string): string | undefined {
  try {
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return undefined;
    return createPublicKey(key).export({ type: "spki", format: "der" }).toString("hex");
  } catch {
    return undefined;
  }
}

export type RequestVerdict =
  | { ok: true; requesterId: string; publicKeyCanonical: string }
  | { ok: false; code: "REQUESTER_SIGNATURE_MISSING" | "REQUESTER_NOT_ALLOWED" | "REQUESTER_SIGNATURE_UNVERIFIED" | "REQUESTER_MISBOUND"; message: string };

/**
 * Verifies the requester signature a sealed plan (subject REQUEST, the default) or a cleanup proposal (CLEANUP_REQUEST) carries
 * against the reviewed contract's allowlist. The requester's entry must name the environment (`environments` governs requesting as
 * it governs approving), so a request signed under a contract that allowed it is refused once the committed contract no longer
 * does. The statement must name exactly this artifact (the plan's artifact hash, or the proposal's own hash), environment and
 * the record's own requester id.
 */
export function verifyRequestSignature(input: { request: unknown; artifactSha256: string; environment: ApplyEnvironment; requesterId: string; contract: PilotContract; subject?: RequestSubject }): RequestVerdict {
  const subject: RequestSubject = input.subject ?? "REQUEST";
  const what = subject === "CLEANUP_REQUEST" ? "cleanup proposal" : "sealed plan";
  const refuse = (code: Exclude<RequestVerdict, { ok: true }>["code"], message: string): RequestVerdict => ({ ok: false, code, message });
  const request = input.request as Partial<SealedRequest> | null | undefined;
  if (!request || typeof request !== "object") {
    return refuse("REQUESTER_SIGNATURE_MISSING", "The " + what + " carries no requester signature. " + (subject === "CLEANUP_REQUEST" ? "Propose the cleanup again with the requester's key." : "Seal it again with the requester's key."));
  }
  const s = request.statement as Partial<RequestStatement> | undefined;
  if (typeof request.signatureBase64 !== "string" || !s || typeof s !== "object" || !sameKeys(s, REQUEST_KEYS) || s.schemaVersion !== 1 ||
    !isText(s.requesterId) || !isText(s.artifactSha256) || !isText(s.environment) || !isText(s.nonce) || !NONCE.test(s.nonce)) {
    return refuse("REQUESTER_SIGNATURE_UNVERIFIED", "The requester signature is malformed or carries unknown fields.");
  }
  const entry = input.contract.approvers.find((a) => a.id === s.requesterId);
  if (!entry) return refuse("REQUESTER_NOT_ALLOWED", "The requester is not on the contract's allowlist.");
  let valid = false;
  try {
    const key = createPublicKey(entry.publicKeyPem);
    valid = key.asymmetricKeyType === "ed25519" && verify(null, requestBytes(s as RequestStatement, subject), key, Buffer.from(request.signatureBase64, "base64"));
  } catch { valid = false; }
  if (!valid) return refuse("REQUESTER_SIGNATURE_UNVERIFIED", "The requester signature does not verify against the allowlisted key for a request of a " + (subject === "CLEANUP_REQUEST" ? "cleanup" : "sealed plan") + ".");
  if (s.artifactSha256 !== input.artifactSha256 || s.environment !== input.environment || s.requesterId !== input.requesterId) {
    return refuse("REQUESTER_MISBOUND", "The requester signature names another artifact, environment or requester than this " + what + ".");
  }
  if (!entry.environments.includes(input.environment)) return refuse("REQUESTER_NOT_ALLOWED", requesterEnvironmentMessage(s.requesterId, input.environment));
  return { ok: true, requesterId: s.requesterId, publicKeyCanonical: canonicalPublicKey(entry.publicKeyPem) };
}

function wellFormed(approval: unknown): approval is SignedApproval {
  if (!approval || typeof approval !== "object") return false;
  const { statement: s, signatureBase64 } = approval as Partial<SignedApproval>;
  if (typeof signatureBase64 !== "string" || !s || typeof s !== "object" || !sameKeys(s, STATEMENT_KEYS)) return false;
  const t = s.target as Partial<ResolvedTarget> | undefined;
  return s.schemaVersion === 1 && isText(s.approverId) && isText(s.artifactSha256) && isText(s.environment)
    && isText(s.issuedAt) && isText(s.expiresAt) && isText(s.nonce)
    && !!t && typeof t === "object" && sameKeys(t, TARGET_KEYS) && TARGET_KEYS.every((k) => isText(t[k as keyof ResolvedTarget]));
}

function signatureValid(approval: SignedApproval, entry: ApproverEntry, subject: ApprovalSubject): boolean {
  try {
    const key = createPublicKey(entry.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, signedBytes(approval.statement, subject), key, Buffer.from(approval.signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export type VerifyApprovalsInput = {
  approvals: SignedApproval[];
  artifactSha256: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** The reviewed contract: the allowlist, the counts and the age limit are read from it. The caller has already checked `target` against the contract (targetForEnvironment); approvals are bound to exactly this target. */
  contract: PilotContract;
  now: Date;
  nonces: NonceStore;
  /** What is being approved (default APPLY). A signature made for the other subject does not verify. */
  subject?: Extract<ApprovalSubject, "APPLY" | "CLEANUP">;
  /**
   * The verified requester of the plan or the cleanup proposal (`verifyRequestSignature`). Required for both: a set with no
   * requester is refused (`REQUESTER_SIGNATURE_MISSING`), so no caller can skip the rule by leaving it out. Where the environment
   * refuses a requester-approver (PROD), an approval from this id or key is `APPROVER_IS_REQUESTER` (`approverIsRequester`).
   */
  requester: VerifiedRequester;
};

export function verifyApprovalSet(input: VerifyApprovalsInput): ApprovalVerdict {
  const { approvals, artifactSha256, environment, target, contract, now, nonces } = input;
  const subject: ApprovalSubject = input.subject ?? "APPLY";
  const requester = input.requester as Partial<VerifiedRequester> | undefined;
  if (!requester || typeof requester !== "object" || !isText(requester.requesterId) || !isText(requester.publicKeyCanonical)) {
    return { ok: false, code: "REQUESTER_SIGNATURE_MISSING", message: "No verified requester was given for this approval set; every apply and every cleanup has one." };
  }
  const allowlist: ApproverEntry[] = contract.approvers;
  const maxAgeMinutes = contract.maxApprovalAgeMinutes;
  // Contract validation is the one place that enforces the minimums (DEV 1, QA 1, PROD 2).
  const required = contract.requiredApprovals[environment];
  if (required === undefined || (contract.enabledEnvironments && !contract.enabledEnvironments.includes(environment))) {
    return { ok: false, code: "APPROVER_NOT_ALLOWED", message: "This environment is not enabled by the pilot contract." };
  }
  const refuse = (code: ApprovalCode, message: string): ApprovalVerdict => ({ ok: false, code, message });
  const nowMs = now.getTime();
  const seenNonces = new Set<string>();
  const approvers: { approverId: string; issuedAt: string }[] = [];
  const signerKeys = new Set<string>();

  if (!Array.isArray(approvals)) return refuse("APPROVAL_UNVERIFIED", "Approvals are not a list.");
  for (const approval of approvals) {
    if (!wellFormed(approval)) return refuse("APPROVAL_UNVERIFIED", "An approval is malformed or carries unknown fields.");
    const s = approval.statement;
    const entry = allowlist.find((a) => a.id === s.approverId);
    if (!entry) return refuse("APPROVER_NOT_ALLOWED", "An approver is not on the allowlist.");
    if (!signatureValid(approval, entry, subject)) return refuse("APPROVAL_UNVERIFIED", "An approval signature does not verify against the allowlisted key for this kind of action.");
    if (!entry.environments.includes(environment)) return refuse("APPROVER_NOT_ALLOWED", "An approver is not allowed for this environment.");
    const signerKey = canonicalPublicKey(entry.publicKeyPem);
    if (approverIsRequester(environment, s.approverId, signerKey, requester as VerifiedRequester)) {
      return refuse("APPROVER_IS_REQUESTER", "An approval comes from the requester of this " + (subject === "CLEANUP" ? "cleanup" : "change") + " (its id or its key). " + environment + " needs the requester and the approvers to be distinct people.");
    }
    signerKeys.add(signerKey);
    if (s.artifactSha256 !== artifactSha256 || s.environment !== environment
      || s.target.account !== target.account || s.target.backend !== target.backend || s.target.workspace !== target.workspace) {
      return refuse("APPROVAL_MISBOUND", "An approval is bound to a different artifact, environment or target.");
    }
    const issued = Date.parse(s.issuedAt);
    const expires = Date.parse(s.expiresAt);
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
      return refuse("APPROVAL_UNVERIFIED", "An approval has invalid timestamps.");
    }
    if (issued > nowMs + SKEW_MS) return refuse("APPROVAL_UNVERIFIED", "An approval is issued in the future.");
    if (nowMs >= expires || nowMs - issued > maxAgeMinutes * 60_000) return refuse("APPROVAL_EXPIRED", "An approval has expired.");
    if (expires - issued > maxAgeMinutes * 60_000) return refuse("APPROVAL_EXPIRED", "An approval outlives the maximum approval age.");
    if (!NONCE.test(s.nonce)) return refuse("APPROVAL_UNVERIFIED", "An approval nonce is malformed.");
    if (seenNonces.has(s.nonce)) return refuse("APPROVAL_REPLAYED", "An approval nonce is repeated.");
    seenNonces.add(s.nonce);
    try {
      if (nonces.has(s.nonce)) return refuse("APPROVAL_REPLAYED", "An approval was already used.");
    } catch (error) {
      if (error instanceof NonceStoreError) return refuse("APPROVAL_REPLAYED", "Replay cannot be ruled out: " + error.message + ".");
      throw error;
    }
    approvers.push({ approverId: s.approverId, issuedAt: s.issuedAt });
  }

  if (new Set(approvers.map((a) => a.approverId)).size !== approvers.length) {
    return refuse("SAME_APPROVER_TWICE", "One approver signed more than once.");
  }
  if (signerKeys.size !== approvers.length) return refuse("SAME_APPROVER_TWICE", "One public key signed under more than one approver id.");
  if (approvers.length < required) {
    return refuse("APPROVAL_INSUFFICIENT", `${approvers.length} verified approval(s); ${required} required.`);
  }
  return { ok: true, approvers };
}

/** Records every nonce atomically. A second consume of any nonce fails and records nothing. */
export function consumeApprovals(nonces: NonceStore, approvals: SignedApproval[]): { ok: true } | { ok: false; code: "APPROVAL_REPLAYED"; message: string } {
  try {
    // The requester's nonce is not consumed here: the request signature binds one artifact, the ledger applies an artifact once, and a
    // plan given back after KILL_SWITCH_AFTER_APPROVALS or APPROVALS_SPENT keeps its request signature for the new approvals.
    const ok = nonces.consumeAll(approvals.map(({ statement: s }) => ({ nonce: s.nonce, approverId: s.approverId, artifactSha256: s.artifactSha256 })));
    return ok ? { ok: true } : { ok: false, code: "APPROVAL_REPLAYED", message: "An approval was already used." };
  } catch (error) {
    if (error instanceof NonceStoreError) return { ok: false, code: "APPROVAL_REPLAYED", message: "Approvals cannot be consumed: " + error.message + "." };
    throw error;
  }
}
