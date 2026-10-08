import type { EnvironmentReadRequest, EnvironmentReadResponse, EnvironmentReadTransport } from "./types.js";

type SecretResolver = (ref: string) => Promise<string>;

function normalizedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("ENVIRONMENT_ORIGIN_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("ENVIRONMENT_ORIGIN_INVALID: HTTPS host origin only");
  }
  return url.origin;
}

/** Only operator-pinned HTTPS origins can be contacted. Credentials are resolved within transport, never returned to the agent. */
export function createFetchEnvironmentTransport(config: {
  allowedOrigins: string[];
  resolveSecret?: SecretResolver;
  authentication?: "BEARER" | "VMWARE_SESSION";
  fetchImpl?: typeof fetch;
}): EnvironmentReadTransport {
  const allowed = new Set(config.allowedOrigins.map(normalizedOrigin));
  const requestFetch = config.fetchImpl ?? fetch;
  return async (request: EnvironmentReadRequest): Promise<EnvironmentReadResponse> => {
    if (request.method !== "GET") throw new Error("ENVIRONMENT_READ_ONLY");
    const origin = normalizedOrigin(request.origin);
    if (!allowed.has(origin)) throw new Error("ENVIRONMENT_ORIGIN_NOT_ALLOWLISTED");
    if (!request.path.startsWith("/") || request.path.startsWith("//") || request.path.includes("..") || /[\r\n]/.test(request.path)) {
      throw new Error("ENVIRONMENT_PATH_BLOCKED");
    }
    const url = new URL(request.path, origin);
    if (url.origin !== origin || url.protocol !== "https:") throw new Error("ENVIRONMENT_EGRESS_BLOCKED");
    const headers: Record<string, string> = { accept: "application/json, text/plain" };
    if (request.authRef) {
      if (!/^(secret|vault|keyring):\/\/[a-zA-Z0-9._/-]{1,128}$/.test(request.authRef)) {
        throw new Error("ENVIRONMENT_CREDENTIAL_REF_INVALID");
      }
      if (!config.resolveSecret) throw new Error("ENVIRONMENT_SECRET_RESOLVER_REQUIRED");
      const secret = await config.resolveSecret(request.authRef);
      if (!secret || /[\r\n]/.test(secret)) throw new Error("ENVIRONMENT_SECRET_UNAVAILABLE");
      if (config.authentication === "VMWARE_SESSION") headers["vmware-api-session-id"] = secret;
      else headers.authorization = "Bearer " + secret;
    }
    const timeoutMs = Math.min(Math.max(request.timeoutMs, 1000), 10000);
    const max = Math.min(Math.max(request.maxResponseBytes, 1024), 2_000_000);
    const response = await requestFetch(url, {
      method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
    });
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, body: "" };
    const pieces: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > max) throw new Error("ENVIRONMENT_RESPONSE_TOO_LARGE");
        pieces.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
    return { status: response.status, body: new TextDecoder().decode(bytes) };
  };
}
