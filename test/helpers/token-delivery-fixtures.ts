import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DELIVERY_ISSUER, DELIVERY_PATHS, DELIVERY_WORKFLOW, deliveryEnvironment, expectedAudience, type DeliveryMetadata, type DeliveryPathId,
} from "../../src/apply/token-delivery.js";
import type { ExecutionIdentity } from "../../src/tools/identity.js";

// SYNTHETIC identity delivery fixtures (docs/act-pilot-identity-delivery.md). The tokens are unsigned look-alikes with fake claims:
// nothing here is a credential, and nothing here is evidence that any cloud or GitHub accepts anything.

export const REPO = "fixture-owner/fixture-repo";
export const RUN_ID = "4242";
export const GCP_CONFIG_AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/alz-pilot-pool/providers/oidc";

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An unsigned JWT look-alike: a header, the claims and a fake signature. */
export const fakeJwt = (claims: Record<string, unknown>): string => b64({ alg: "RS256", typ: "JWT", kid: "fixture" }) + "." + b64(claims) + ".ZmFrZS1zaWduYXR1cmU";

/** The claims GitHub would put in this identity's token, as the design expects them, `seconds` the time of minting. */
export function deliveryClaims(path: DeliveryPathId, identity: ExecutionIdentity, seconds: number): Record<string, unknown> {
  const environment = deliveryEnvironment(path, identity);
  return {
    iss: DELIVERY_ISSUER, aud: expectedAudience(path, GCP_CONFIG_AUDIENCE), sub: "repo:" + REPO + ":environment:" + environment, environment,
    repository: REPO, event_name: "workflow_dispatch", ref: "refs/heads/main", workflow_ref: REPO + "/" + DELIVERY_WORKFLOW + "@refs/heads/main",
    runner_environment: "self-hosted", run_id: RUN_ID, jti: randomUUID(), iat: seconds - 5, nbf: seconds - 5, exp: seconds + 300,
  };
}

export type Delivered = { root: string; sessionDir: string; env: Record<string, string>; tokenFile: (identity: ExecutionIdentity) => string; metaFile: (identity: ExecutionIdentity) => string };

/**
 * A private session directory `<root>/<path>` as the delivery jobs leave it while they hold: one 0600 token and metadata file per
 * identity, and the identity variables the person at the terminal sets. GCP identities get a credential configuration naming the token.
 */
export function deliverSession(path: DeliveryPathId, now: Date, options: {
  parent?: string; claims?: Partial<Record<ExecutionIdentity, Record<string, unknown>>>; meta?: Partial<Record<ExecutionIdentity, Partial<DeliveryMetadata>>>;
} = {}): Delivered {
  // The real temporary directory: on macOS tmpdir() is under /var, a symbolic link, and a delivery root must be its own real path.
  const root = mkdtempSync(join(options.parent ?? realpathSync(tmpdir()), "alz-delivery-"));
  const sessionDir = join(root, path);
  mkdirSync(sessionDir, { mode: 0o700 });
  const spec = DELIVERY_PATHS[path];
  const seconds = Math.floor(now.getTime() / 1000);
  const env: Record<string, string> = {};
  const tokenFile = (identity: ExecutionIdentity): string => join(sessionDir, identity + ".jwt");
  const metaFile = (identity: ExecutionIdentity): string => join(sessionDir, identity + ".json");
  for (const identity of spec.identities) {
    const claims = { ...deliveryClaims(path, identity, seconds), ...options.claims?.[identity] };
    writeFileSync(tokenFile(identity), fakeJwt(claims), { mode: 0o600 });
    const meta: DeliveryMetadata = {
      schemaVersion: 1, kind: "alz-identity-delivery", path, identity, environment: deliveryEnvironment(path, identity),
      audience: expectedAudience(path, GCP_CONFIG_AUDIENCE)!, repository: REPO, runId: RUN_ID, subject: String(claims.sub),
      refreshedAt: new Date(now.getTime() - 5000).toISOString(), tokenExpiresAt: new Date((seconds + 300) * 1000).toISOString(),
      holdUntil: new Date(now.getTime() + 30 * 60 * 1000).toISOString(), refreshSeconds: 60, ...options.meta?.[identity],
    };
    writeFileSync(metaFile(identity), JSON.stringify(meta), { mode: 0o600 });
    if (spec.provider === "AWS") env["ALZ_" + identity + "_AWS_WEB_IDENTITY_TOKEN_FILE"] = tokenFile(identity);
    else if (spec.provider === "AZURE") env["ALZ_" + identity + "_ARM_OIDC_TOKEN_FILE"] = tokenFile(identity);
    else {
      const configDir = join(root, "gcp-config");
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      const config = join(configDir, identity + ".json");
      writeFileSync(config, JSON.stringify({
        type: "external_account", audience: GCP_CONFIG_AUDIENCE, subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: tokenFile(identity) },
      }), { mode: 0o600 });
      env["ALZ_" + identity + "_GOOGLE_APPLICATION_CREDENTIALS"] = config;
    }
  }
  return { root, sessionDir, env, tokenFile, metaFile };
}
