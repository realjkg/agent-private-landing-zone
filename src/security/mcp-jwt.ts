import { createPublicKey, randomUUID, verify, type KeyObject } from "node:crypto";
import type { BearerVerifier } from "../integrations/ai-studio/operations-mcp-http.js";

type RsaJwk = { kty: "RSA"; kid: string; n: string; e: string; alg?: string; use?: string; key_ops?: string[] };
export type McpJwtPolicy = {
  issuer: string;
  audience: string;
  tenant: string;
  stage: "DEVELOPMENT" | "STAGING" | "PRODUCTION";
  /** Pinned, trusted host input. No token-controlled jku/x5u or remote fetch. */
  jwks: { keys: RsaJwk[] };
  /** Must consult the trusted session/revocation authority; errors deny access. */
  isActive: (session: { subject: string; jti: string; tenant: string; stage: string }) => Promise<boolean>;
  now?: () => number;
};
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const identifier = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(x);
function decode(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error("JWT_ENCODING");
  const bytes = Buffer.from(part, "base64url");
  if (bytes.toString("base64url") !== part) throw new Error("JWT_ENCODING");
  return bytes;
}

/** RS256 access-token verifier. OIDC ID tokens are not accepted as MCP grants. */
export function createMcpJwtVerifier(policy: McpJwtPolicy): BearerVerifier {
  const url = new URL(policy.issuer);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      !identifier(policy.audience) || !identifier(policy.tenant) ||
      !["DEVELOPMENT", "STAGING", "PRODUCTION"].includes(policy.stage) ||
      typeof policy.isActive !== "function" || !Array.isArray(policy.jwks?.keys) ||
      policy.jwks.keys.length < 1 || policy.jwks.keys.length > 16)
    throw new Error("MCP_JWT_POLICY_INVALID");
  const keys = new Map<string, KeyObject>();
  for (const jwk of policy.jwks.keys) {
    if (!identifier(jwk.kid) || keys.has(jwk.kid) || jwk.kty !== "RSA" ||
        jwk.alg && jwk.alg !== "RS256" || jwk.use && jwk.use !== "sig" ||
        jwk.key_ops && (jwk.key_ops.length !== 1 || jwk.key_ops[0] !== "verify") ||
        Object.keys(jwk).some(k => !["kty", "kid", "n", "e", "alg", "use", "key_ops"].includes(k)))
      throw new Error("MCP_JWK_INVALID");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error("MCP_JWK_WEAK");
    keys.set(jwk.kid, key);
  }
  // Snapshot configuration: later mutation of caller-owned policy cannot widen trust.
  const { issuer, audience, tenant, stage, isActive, now = Date.now } = policy;
  return async token => {
    try {
      if (typeof token !== "string" || token.length > 8192) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const header: unknown = JSON.parse(decode(parts[0]).toString("utf8"));
      if (!object(header) || header.alg !== "RS256" || header.typ !== "at+jwt" ||
          !identifier(header.kid) || Object.keys(header).some(k => !["alg", "kid", "typ"].includes(k))) return null;
      const key = keys.get(header.kid);
      if (!key || !verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, decode(parts[2]))) return null;
      const claims: unknown = JSON.parse(decode(parts[1]).toString("utf8"));
      if (!object(claims)) return null;
      const seconds = Math.floor(now() / 1000);
      const exp = claims.exp, iat = claims.iat, nbf = claims.nbf;
      if (!Number.isSafeInteger(seconds) || claims.iss !== issuer || claims.aud !== audience || claims.tenant !== tenant || claims.stage !== stage ||
          !identifier(claims.sub) || !identifier(claims.jti) ||
          !Number.isSafeInteger(exp) || !Number.isSafeInteger(iat) || !Number.isSafeInteger(nbf) ||
          (exp as number) <= seconds || (iat as number) > seconds || (nbf as number) > seconds ||
          (nbf as number) < (iat as number) || (exp as number) <= (nbf as number) ||
          (exp as number) - (iat as number) > 900 || (iat as number) < seconds - 900 ||
          typeof claims.scope !== "string") return null;
      const scopes = claims.scope.split(" ");
      if (!scopes.includes("ALZ_DISCOVERY_READ") || scopes.some(s => s !== "ALZ_DISCOVERY_READ")) return null;
      if (await isActive({ subject: claims.sub, jti: claims.jti, tenant, stage }) !== true) return null;
      // Session lookup can take time: expire again after awaiting it.
      const verifiedAt = now();
      if (!Number.isFinite(verifiedAt) || (exp as number) * 1000 <= verifiedAt || verifiedAt < seconds * 1000) return null;
      return { verifiedBy: "TRUSTED_GATEWAY", identity: {
        subject: claims.sub, audience, scopes: ["ALZ_DISCOVERY_READ"],
        expiresAt: (exp as number) * 1000, traceId: randomUUID()
      }};
    } catch { return null; }
  };
}
