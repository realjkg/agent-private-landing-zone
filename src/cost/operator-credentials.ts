import { spawnSync } from "node:child_process";
import { approvedToolDirs, resolveExecutable } from "../tools/child-env.js";

export type OperatorReadCredentials = { env: NodeJS.ProcessEnv; region?: string };
export type OperatorReadCredentialResult = { ok: true; credentials: OperatorReadCredentials } | { ok: false; message: string };

type AwsCommand = (args: string[], env: NodeJS.ProcessEnv) => { status: number | null; stdout: string } | undefined;

function awsCli(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string } | undefined {
  const path = resolveExecutable("aws", approvedToolDirs(env));
  if (!path) return undefined;
  const result = spawnSync(path, args, { encoding: "utf8", env, shell: false, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/**
 * Resolve a short-lived IAM Identity Center session without passing the profile cache or ambient HOME to the broker child.
 * Credentials are held only in memory, injected into one exact read-only tool call, then released by normal GC.
 */
export function operatorReadCredentials(options: { env?: NodeJS.ProcessEnv; runAws?: AwsCommand; now?: () => number } = {}): OperatorReadCredentialResult {
  const env = options.env ?? process.env;
  const runAws = options.runAws ?? awsCli;
  const call = (args: string[]) => runAws(args, env);
  // Existing broker web-identity injection remains the preferred route on a governed runner.
  if (env.ALZ_DISCOVERY_AWS_ROLE_ARN && env.ALZ_DISCOVERY_AWS_WEB_IDENTITY_TOKEN_FILE) {
    const region = env.ALZ_DISCOVERY_AWS_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
    return { ok: true, credentials: { env: {}, ...(region && /^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(region) ? { region } : {}) } };
  }
  const profile = env.AWS_PROFILE ?? env.AWS_DEFAULT_PROFILE;
  if (!profile || !/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(profile)) {
    return { ok: false, message: "Set AWS_PROFILE to an authenticated IAM Identity Center profile, then retry the read-only cost command." };
  }
  // Refuse credential_process profiles: exporting from one would execute profile-selected code outside the broker.
  const processCredential = call(["configure", "get", "credential_process", "--profile", profile]);
  const sourceProfile = call(["configure", "get", "source_profile", "--profile", profile]);
  const credentialSource = call(["configure", "get", "credential_source", "--profile", profile]);
  const ssoSession = call(["configure", "get", "sso_session", "--profile", profile]);
  const ssoUrl = call(["configure", "get", "sso_start_url", "--profile", profile]);
  const ssoAccount = call(["configure", "get", "sso_account_id", "--profile", profile]);
  const ssoRole = call(["configure", "get", "sso_role_name", "--profile", profile]);
  const configReads = [processCredential, sourceProfile, credentialSource, ssoSession, ssoUrl, ssoAccount, ssoRole];
  if (configReads.some((result) => !result || result.status !== 0 && result.status !== 1)) {
    return { ok: false, message: "The IAM Identity Center profile could not be inspected safely. No AWS query was made." };
  }
  if (sourceProfile!.stdout.trim() || credentialSource!.stdout.trim() || processCredential!.stdout.trim() || !(ssoSession!.stdout.trim() || ssoUrl!.stdout.trim()) ||
      !/^\d{12}$/.test(ssoAccount!.stdout.trim()) || !/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(ssoRole!.stdout.trim())) {
    return { ok: false, message: "This read path accepts IAM Identity Center profiles only. Use a configured SSO profile with no credential_process, or the governed DISCOVERY web-identity identity." };
  }
  const exported = call(["configure", "export-credentials", "--profile", profile, "--format", "process"]);
  if (!exported || exported.status !== 0) {
    return { ok: false, message: "The IAM Identity Center session could not export temporary read credentials. Run aws sso login --profile " + profile + " and retry." };
  }
  let parsed: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string };
  try { parsed = JSON.parse(exported.stdout) as typeof parsed; } catch {
    return { ok: false, message: "AWS CLI returned an invalid temporary credential response; no AWS query was made." };
  }
  const now = (options.now ?? Date.now)();
  const expiry = parsed.Expiration ? Date.parse(parsed.Expiration) : NaN;
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey || !parsed.SessionToken || !Number.isFinite(expiry) || expiry <= now || expiry > now + 13 * 60 * 60_000) {
    return { ok: false, message: "AWS CLI did not return valid short-lived IAM Identity Center credentials; no AWS query was made." };
  }
  const regionResult = call(["configure", "get", "region", "--profile", profile]);
  const configuredRegion = regionResult?.status === 0 ? regionResult.stdout.trim() : "";
  const region = /^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(configuredRegion) ? configuredRegion :
    [env.AWS_REGION, env.AWS_DEFAULT_REGION].find((candidate) => candidate && /^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(candidate));
  return {
    ok: true,
    credentials: {
      env: {
        ALZ_DISCOVERY_AWS_ACCESS_KEY_ID: parsed.AccessKeyId,
        ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY: parsed.SecretAccessKey,
        ALZ_DISCOVERY_AWS_SESSION_TOKEN: parsed.SessionToken,
        ...(region ? { ALZ_DISCOVERY_AWS_REGION: region, ALZ_DISCOVERY_AWS_DEFAULT_REGION: region } : {}),
      },
      region,
    },
  };
}
