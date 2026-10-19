/**
 * AI Studio authentication-provider admission contract.
 *
 * Metadata-only: credentials and tokens are never accepted or persisted here.
 * The hosted MCP connector must resolve auth references in its own trusted
 * secret store, verify tokens, and scope each tool call through the ALZ broker.
 */
export type AiStudioAuthKind = "OAUTH2_AUTHORIZATION_CODE_PKCE" | "OAUTH2_CLIENT_CREDENTIALS" | "OIDC";
export type AiStudioAuthScope = "ALZ_DISCOVERY_READ" | "ALZ_EVIDENCE_READ" | "ALZ_POLICY_ASSESS" | "ALZ_IAC_PREVIEW";
export type AiStudioAuthProvider = {
  id: string;
  name: string;
  kind: AiStudioAuthKind;
  issuerUrl?: string;
  authorizationUrl?: string;
  tokenUrl: string;
  clientIdRef: string;
  clientSecretRef?: string;
  scopes: AiStudioAuthScope[];
  audience?: string;
  redirectUris?: string[];
};
export type AuthAdmission = { allowed: true; sanitized: AiStudioAuthProvider } | { allowed: false; errors: string[] };

const KINDS = new Set<AiStudioAuthKind>(["OAUTH2_AUTHORIZATION_CODE_PKCE", "OAUTH2_CLIENT_CREDENTIALS", "OIDC"]);
const SCOPES = new Set<AiStudioAuthScope>(["ALZ_DISCOVERY_READ", "ALZ_EVIDENCE_READ", "ALZ_POLICY_ASSESS", "ALZ_IAC_PREVIEW"]);
const SECRET_REF = /^(secret|vault|keyring):\/\/[A-Za-z0-9][A-Za-z0-9/_:.@-]*$/;
const ID = /^[a-z][a-z0-9-]{2,63}$/;
const RESERVED = /(?:password|secret|token|apikey|api_key|authorization|accesskey)\s*[:=]/i;

function safeHttps(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !!u.hostname && !u.username && !u.password && !u.hash &&
      !["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname.toLowerCase());
  } catch { return false; }
}
function validRef(value: string | undefined): boolean { return !!value && SECRET_REF.test(value); }

export function admitAiStudioAuthProvider(input: unknown): AuthAdmission {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { allowed: false, errors: ["AUTH_SCHEMA_INVALID: object required"] };
  }
  const p = input as Record<string, unknown>;
  const allowedKeys = new Set(["id","name","kind","issuerUrl","authorizationUrl","tokenUrl","clientIdRef","clientSecretRef","scopes","audience","redirectUris"]);
  for (const key of Object.keys(p)) if (!allowedKeys.has(key)) errors.push("AUTH_UNKNOWN_FIELD: " + key);
  if (typeof p.id !== "string" || !ID.test(p.id)) errors.push("AUTH_ID_INVALID");
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 120 || RESERVED.test(p.name)) errors.push("AUTH_NAME_INVALID");
  if (!KINDS.has(p.kind as AiStudioAuthKind)) errors.push("AUTH_KIND_UNSUPPORTED");
  if (typeof p.tokenUrl !== "string" || !safeHttps(p.tokenUrl)) errors.push("AUTH_TOKEN_URL_INVALID");
  if (p.issuerUrl !== undefined && (typeof p.issuerUrl !== "string" || !safeHttps(p.issuerUrl))) errors.push("AUTH_ISSUER_INVALID");
  if (!validRef(p.clientIdRef as string | undefined)) errors.push("AUTH_CLIENT_ID_REF_REQUIRED");
  if (p.clientSecretRef !== undefined && !validRef(p.clientSecretRef as string)) errors.push("AUTH_SECRET_REF_INVALID");
  if (!Array.isArray(p.scopes) || p.scopes.length === 0 || p.scopes.some(x => !SCOPES.has(x)) ||
      new Set(p.scopes).size !== p.scopes.length) errors.push("AUTH_SCOPES_INVALID");
  if (p.audience !== undefined && (typeof p.audience !== "string" || !p.audience.trim() || p.audience.length > 256 || RESERVED.test(p.audience))) errors.push("AUTH_AUDIENCE_INVALID");
  if (p.kind === "OAUTH2_CLIENT_CREDENTIALS") {
    if (!validRef(p.clientSecretRef as string | undefined)) errors.push("AUTH_CONFIDENTIAL_CLIENT_REF_REQUIRED");
    if (p.authorizationUrl !== undefined || p.redirectUris !== undefined) errors.push("AUTH_MACHINE_FLOW_MUST_NOT_REDIRECT");
  } else {
    if (typeof p.authorizationUrl !== "string" || !safeHttps(p.authorizationUrl)) errors.push("AUTH_AUTHORIZATION_URL_REQUIRED");
    if (!Array.isArray(p.redirectUris) || p.redirectUris.length === 0 ||
        p.redirectUris.some(x => typeof x !== "string" || !safeHttps(x))) errors.push("AUTH_REDIRECT_URIS_INVALID");
    if (p.kind === "OIDC" && p.issuerUrl === undefined) errors.push("AUTH_OIDC_ISSUER_REQUIRED");
  }
  return errors.length ? { allowed: false, errors } : { allowed: true, sanitized: input as AiStudioAuthProvider };
}

/** AWS Knowledge MCP is intentionally unauthenticated. Never bind an unrelated OAuth provider to it. */
export function awsKnowledgeAuthRequirement(): "NONE" { return "NONE"; }
