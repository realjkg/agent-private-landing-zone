/**
 * MCP endpoint authentication provider definitions.
 * AWS SigV4 is an infrastructure-provider mechanism, not an MCP auth option.
 * Never store secret values in these definitions: only opaque vault references.
 */
export type McpAuthType = "oauth2" | "oauth2.1" | "api_key";
export type SecretReference = string;

type Common = {
  id: string;
  name: string;
  description?: string;
  endpoint: string;
};

type OAuthProvider = Common & {
  type: "oauth2" | "oauth2.1";
  clientId: string;
  clientSecretRef?: SecretReference;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectUri: string;
  pkce: true;
};

type ApiKeyProvider = Common & {
  type: "api_key";
  keyRef: SecretReference;
  placement: "header";
  headerName: string;
};

export type McpAuthProvider = OAuthProvider | ApiKeyProvider;

const allowedSecret = /^(secret|vault|keyring):\/\/[A-Za-z0-9._\/-]+$/;
const allowedId = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const reservedHeaders = new Set(["host", "content-length", "cookie", "proxy-authorization", "connection"]);

function httpsUrl(raw: unknown, label: string, errors: string[]): void {
  if (typeof raw !== "string") { errors.push(label + " must be a URL"); return; }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      errors.push(label + " must be an HTTPS URL without credentials or fragment");
    }
  } catch { errors.push(label + " must be a valid HTTPS URL"); }
}

function ref(raw: unknown, label: string, errors: string[]): void {
  if (typeof raw !== "string" || !allowedSecret.test(raw)) errors.push(label + " must be an opaque secret reference");
}

export function validateMcpAuthProvider(input: unknown): McpAuthProvider {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid MCP auth provider");
  const data = input as Record<string, unknown>;
  const errors: string[] = [];
  if (!allowedId.test(String(data.id ?? ""))) errors.push("id must be a stable identifier");
  if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 120) errors.push("name is required (max 120 characters)");
  if (data.description !== undefined && (typeof data.description !== "string" || data.description.length > 1000)) errors.push("description is invalid");
  httpsUrl(data.endpoint, "endpoint", errors);

  if (data.type === "oauth2" || data.type === "oauth2.1") {
    if (typeof data.clientId !== "string" || !data.clientId.trim()) errors.push("clientId is required");
    if (data.clientSecretRef !== undefined) ref(data.clientSecretRef, "clientSecretRef", errors);
    httpsUrl(data.authorizationUrl, "authorizationUrl", errors);
    httpsUrl(data.tokenUrl, "tokenUrl", errors);
    httpsUrl(data.redirectUri, "redirectUri", errors);
    if (data.pkce !== true) errors.push("PKCE S256 must be enabled");
    if (!Array.isArray(data.scopes) || !data.scopes.every(x => typeof x === "string" && x.length > 0)) errors.push("scopes must be strings");
    const accepted = new Set(["id","name","description","endpoint","type","clientId","clientSecretRef","authorizationUrl","tokenUrl","scopes","redirectUri","pkce"]);
    for (const key of Object.keys(data)) if (!accepted.has(key)) errors.push("unsupported field: " + key);
  } else if (data.type === "api_key") {
    ref(data.keyRef, "keyRef", errors);
    if (data.placement !== "header") errors.push("API keys must be sent in headers");
    if (typeof data.headerName !== "string" || !headerName.test(data.headerName) || reservedHeaders.has(data.headerName.toLowerCase())) errors.push("invalid API key header");
    const accepted = new Set(["id","name","description","endpoint","type","keyRef","placement","headerName"]);
    for (const key of Object.keys(data)) if (!accepted.has(key)) errors.push("unsupported field: " + key);
  } else {
    errors.push("type must be oauth2, oauth2.1, or api_key");
  }
  if (errors.length) throw new Error("MCP_AUTH_PROVIDER_INVALID: " + errors.join("; "));
  return input as McpAuthProvider;
}

/** Store references only. This deliberately does not resolve credentials. */
export class McpAuthProviderRegistry {
  private readonly providers = new Map<string, McpAuthProvider>();

  create(input: unknown): McpAuthProvider {
    const provider = validateMcpAuthProvider(input);
    if (this.providers.has(provider.id)) throw new Error("MCP_AUTH_PROVIDER_EXISTS");
    this.providers.set(provider.id, structuredClone(provider));
    return structuredClone(provider);
  }

  get(id: string): McpAuthProvider | undefined {
    const provider = this.providers.get(id);
    return provider ? structuredClone(provider) : undefined;
  }

  list(): McpAuthProvider[] {
    return Array.from(this.providers.values(), p => structuredClone(p));
  }

  delete(id: string): boolean {
    return this.providers.delete(id);
  }
}
