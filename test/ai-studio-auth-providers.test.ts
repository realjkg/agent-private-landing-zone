import assert from "node:assert/strict";
import test from "node:test";
import { admitAiStudioAuthProvider, awsKnowledgeAuthRequirement } from "../src/integrations/ai-studio/auth-providers.js";

const valid = {
  id: "alz-oidc",
  name: "Sovereign ALZ OIDC",
  kind: "OIDC",
  issuerUrl: "https://identity.example.org",
  authorizationUrl: "https://identity.example.org/authorize",
  tokenUrl: "https://identity.example.org/token",
  clientIdRef: "vault://ai-studio/alz-client-id",
  scopes: ["ALZ_DISCOVERY_READ", "ALZ_EVIDENCE_READ"],
  redirectUris: ["https://studio.example.org/oauth/callback"]
} as const;

test("remote OIDC provider metadata is admitted without raw secrets", () => {
  const r = admitAiStudioAuthProvider({ ...valid, scopes: [...valid.scopes], redirectUris: [...valid.redirectUris] });
  assert.equal(r.allowed, true);
});
test("client credentials require secret reference, not raw credentials", () => {
  const p = { id: "alz-machine", name: "ALZ Machine", kind: "OAUTH2_CLIENT_CREDENTIALS",
    tokenUrl: "https://identity.example.org/token", clientIdRef: "secret://alz/id",
    clientSecretRef: "keyring://alz/secret", scopes: ["ALZ_DISCOVERY_READ"] };
  assert.equal(admitAiStudioAuthProvider(p).allowed, true);
  assert.equal(admitAiStudioAuthProvider({ ...p, clientSecretRef: "plaintext-secret" }).allowed, false);
  assert.equal(admitAiStudioAuthProvider({ ...p, redirectUris: ["https://evil.example/redirect"] }).allowed, false);
});
test("hosted connector rejects localhost and non-HTTPS endpoints", () => {
  for (const tokenUrl of ["http://identity.example/token", "https://localhost/token",
    "https://127.0.0.1/token", "https://user:pass@identity.example/token"]) {
    assert.equal(admitAiStudioAuthProvider({ ...valid, tokenUrl, scopes: [...valid.scopes], redirectUris: [...valid.redirectUris] }).allowed, false);
  }
});
test("unknown fields, unsupported scopes, empty redirect and malformed ids fail closed", () => {
  const base = { ...valid, scopes: [...valid.scopes], redirectUris: [...valid.redirectUris] };
  for (const changed of [{ ...base, password: "insecure" }, { ...base, scopes: ["ALZ_MUTATION"] },
    { ...base, redirectUris: [] }, { ...base, id: "../../unsafe" }, { ...base, issuerUrl: "http://issuer.example" }]) {
    assert.equal(admitAiStudioAuthProvider(changed).allowed, false);
  }
});
test("knowledge MCP requires no OAuth provider", () => {
  assert.equal(awsKnowledgeAuthRequirement(), "NONE");
});
