import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson } from "../teardown/manifest.js";
import type { ResolvedTarget } from "../teardown/driver/types.js";
import type { ApplyEnvironment, ApplyRefusalCode, ApproverEntry, ApprovalStatement, PilotContract, SignedApproval } from "./types.js";
import { canonicalPublicKey } from "./contract.js";
import { NonceStoreError, type NonceStore } from "./nonces.js";

/**
 * The single place approvals are verified (docs/act-pilot-plan.md, item 3).
 * An approval is an Ed25519 signature by a key on the pinned contract's
 * approver allowlist over a statement binding artifact, environment, exact
 * target, expiry and a one-time nonce. A typed name is never proof, and neither
 * is the operator's OS username, so who requested an apply is not checked: what
 * matters is that enough distinct keys signed this exact artifact and target.
 * Any invalid approval refuses the whole set.
 */
type ApprovalCode = Extract<
  ApplyRefusalCode,
  | "APPROVAL_INSUFFICIENT" | "APPROVAL_UNVERIFIED" | "APPROVER_NOT_ALLOWED" | "APPROVAL_EXPIRED"
  | "APPROVAL_REPLAYED" | "APPROVAL_MISBOUND" | "SAME_APPROVER_TWICE"
>;
type ApprovalVerdict =
  | { ok: true; approvers: { approverId: string; issuedAt: string }[] }
  | { ok: false; code: ApprovalCode; message: string };

/** Domain separation: a signature over an approval statement is valid for nothing else. */
const DOMAIN = "alz-apply-approval-v1\n";
const SKEW_MS = 60_000;
const NONCE = /^[a-f0-9]{32}$/;
const STATEMENT_KEYS = ["approverId", "artifactSha256", "environment", "expiresAt", "issuedAt", "nonce", "schemaVersion", "target"];
const TARGET_KEYS = ["account", "backend", "workspace"];

const signedBytes = (statement: ApprovalStatement): Buffer => Buffer.from(DOMAIN + canonicalJson(statement));
const sameKeys = (value: object, keys: string[]): boolean => Object.keys(value).sort().join() === keys.join();
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export function signApproval(statement: ApprovalStatement, privateKeyPem: string): SignedApproval {
  const signature = sign(null, signedBytes(statement), createPrivateKey(privateKeyPem));
  return { statement, signatureBase64: signature.toString("base64") };
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

function signatureValid(approval: SignedApproval, entry: ApproverEntry): boolean {
  try {
    const key = createPublicKey(entry.publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, signedBytes(approval.statement), key, Buffer.from(approval.signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export type VerifyApprovalsInput = {
  approvals: SignedApproval[];
  artifactSha256: string;
  environment: ApplyEnvironment;
  target: ResolvedTarget;
  /** The pinned contract: the allowlist, the counts and the age limit are read from it. The caller has already checked `target` against the contract (targetForEnvironment); approvals are bound to exactly this target. */
  contract: PilotContract;
  now: Date;
  nonces: NonceStore;
};

export function verifyApprovalSet(input: VerifyApprovalsInput): ApprovalVerdict {
  const { approvals, artifactSha256, environment, target, contract, now, nonces } = input;
  const allowlist: ApproverEntry[] = contract.approvers;
  const maxAgeMinutes = contract.maxApprovalAgeMinutes;
  // Contract validation is the one place that enforces the minimums (DEV 1, QA 1, PROD 2).
  const required = contract.requiredApprovals[environment];
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
    if (!signatureValid(approval, entry)) return refuse("APPROVAL_UNVERIFIED", "An approval signature does not verify against the allowlisted key.");
    if (!entry.environments.includes(environment)) return refuse("APPROVER_NOT_ALLOWED", "An approver is not allowed for this environment.");
    signerKeys.add(canonicalPublicKey(entry.publicKeyPem));
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
    const ok = nonces.consumeAll(approvals.map(({ statement: s }) => ({ nonce: s.nonce, approverId: s.approverId, artifactSha256: s.artifactSha256 })));
    return ok ? { ok: true } : { ok: false, code: "APPROVAL_REPLAYED", message: "An approval was already used." };
  } catch (error) {
    if (error instanceof NonceStoreError) return { ok: false, code: "APPROVAL_REPLAYED", message: "Approvals cannot be consumed: " + error.message + "." };
    throw error;
  }
}
