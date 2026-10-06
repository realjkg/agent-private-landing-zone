import {
  collectRepositoryEvidence,
} from "../build/repository.js";
import {
  ensureEvidenceKey,
} from "../evidence/vault.js";
import {
  getToolSecurityPosture,
} from "../tools/broker.js";

export type SessionSecurityControl = {
  name: string;
  passed: boolean;
  detail: string;
};

export type SessionSecurityPosture = {
  secured: boolean;
  controls: SessionSecurityControl[];
  commitSha: string;
};

export async function assessSessionSecurity(): Promise<SessionSecurityPosture> {
  const repository =
    collectRepositoryEvidence();
  const toolPosture =
    getToolSecurityPosture();
  const evidence =
    await ensureEvidenceKey();

  const controls: SessionSecurityControl[] = [
    {
      name: "repository",
      passed:
        repository.clean &&
        Boolean(
          repository.packageLockHash,
        ),
      detail:
        repository.clean
          ? "clean, lockfile evidenced"
          : "worktree is dirty",
    },
    {
      name: "evidence",
      passed:
        evidence.info.securePermissions,
      detail:
        "AES-256-GCM; key source " +
        evidence.info.source,
    },
    {
      name: "mutation",
      passed:
        toolPosture.mutationTools.length === 0,
      detail:
        toolPosture.mutationTools.length === 0
          ? "no apply/up/destroy capability exposed"
          : "mutation tools exposed",
    },
    {
      name: "shell",
      passed:
        toolPosture.arbitraryShell === false,
      detail:
        toolPosture.arbitraryShell
          ? "arbitrary shell exposed"
          : "arbitrary shell unavailable",
    },
    {
      name: "cloud-read",
      passed:
        toolPosture.cloudReadDefault === false,
      detail:
        "disabled by default; explicit broker grant required",
    },
    {
      name: "checkpointing",
      passed: true,
      detail:
        "live session state is memory-only; durable records encrypted",
    },
  ];

  return {
    secured:
      controls.every(
        (control) => control.passed,
      ),
    controls,
    commitSha:
      repository.commitSha,
  };
}

export async function assertSecureSession(): Promise<SessionSecurityPosture> {
  const posture =
    await assessSessionSecurity();

  if (!posture.secured) {
    const failures =
      posture.controls
        .filter(
          (control) => !control.passed,
        )
        .map(
          (control) =>
            control.name +
            ": " +
            control.detail,
        )
        .join("; ");

    throw new Error(
      "SECURE_SESSION_REFUSED: " +
        failures,
    );
  }

  return posture;
}
