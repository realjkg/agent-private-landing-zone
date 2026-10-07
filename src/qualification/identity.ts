export type ProductionIdentityMode =
  | "WORKLOAD_IDENTITY"
  | "FEDERATED_IDENTITY"
  | "ASSUME_ROLE"
  | "MANAGED_IDENTITY";

export type ProductionIdentityProvider =
  | "AWS"
  | "AZURE";

export type ProductionIdentityEvidence = {
  provider:
    ProductionIdentityProvider;
  awsCallerArn?: string;
  azureUserType?: string;
  environment?: Record<
    string,
    string | undefined
  >;
  opaqueSecretReferencesOnly:
    boolean;
  modelVisibleSecretMaterial:
    boolean;
};

export type ProductionIdentityQualification = {
  ready: boolean;
  mode?:
    ProductionIdentityMode;
  blockers: string[];
};

function present(
  environment:
    Record<
      string,
      string | undefined
    >,
  key: string,
): boolean {
  return Boolean(
    environment[key]?.trim(),
  );
}

function awsMode(
  evidence:
    ProductionIdentityEvidence,
  blockers: string[],
): ProductionIdentityMode | undefined {
  const env =
    evidence.environment ?? {};
  const arn =
    evidence.awsCallerArn ?? "";

  const staticAccessKey =
    present(
      env,
      "AWS_ACCESS_KEY_ID",
    ) &&
    present(
      env,
      "AWS_SECRET_ACCESS_KEY",
    ) &&
    !present(
      env,
      "AWS_SESSION_TOKEN",
    ) &&
    !present(
      env,
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    );

  if (staticAccessKey) {
    blockers.push(
      "AWS qualification detected a static access-key credential pattern without a session token.",
    );
  }

  if (
    arn.includes(":root") ||
    arn.includes(":user/")
  ) {
    blockers.push(
      "AWS production qualification requires an assumed, federated, or workload identity rather than root or IAM user identity.",
    );
  }

  if (
    present(
      env,
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    ) &&
    present(
      env,
      "AWS_ROLE_ARN",
    )
  ) {
    return "WORKLOAD_IDENTITY";
  }

  if (
    arn.includes(
      ":assumed-role/",
    )
  ) {
    return "ASSUME_ROLE";
  }

  return undefined;
}

function azureMode(
  evidence:
    ProductionIdentityEvidence,
  blockers: string[],
): ProductionIdentityMode | undefined {
  const env =
    evidence.environment ?? {};
  const userType =
    evidence.azureUserType
      ?.trim()
      .toLowerCase();

  const prohibitedCredentialKeys = [
    "AZURE_CLIENT_SECRET",
    "ARM_CLIENT_SECRET",
    "AZURE_CLIENT_CERTIFICATE_PATH",
    "ARM_CLIENT_CERTIFICATE_PATH",
    "AZURE_PASSWORD",
  ];

  if (
    prohibitedCredentialKeys.some(
      (key) =>
        present(env, key),
    )
  ) {
    blockers.push(
      "Azure qualification detected a client-secret, certificate, or password credential pattern that is outside the approved production identity modes.",
    );
  }

  if (
    userType === "user"
  ) {
    blockers.push(
      "Azure production qualification requires managed, workload, or federated identity rather than an interactive user identity.",
    );
  }

  if (
    present(
      env,
      "AZURE_FEDERATED_TOKEN_FILE",
    )
  ) {
    return "FEDERATED_IDENTITY";
  }

  if (
    present(
      env,
      "IDENTITY_ENDPOINT",
    ) ||
    present(
      env,
      "MSI_ENDPOINT",
    ) ||
    present(
      env,
      "IMDS_ENDPOINT",
    )
  ) {
    return "MANAGED_IDENTITY";
  }

  return undefined;
}

export function qualifyProductionIdentity(
  evidence:
    ProductionIdentityEvidence,
): ProductionIdentityQualification {
  const blockers: string[] =
    [];

  if (
    !evidence.opaqueSecretReferencesOnly
  ) {
    blockers.push(
      "Production secret handling requires opaque references.",
    );
  }

  if (
    evidence.modelVisibleSecretMaterial
  ) {
    blockers.push(
      "Secret material is visible to model context.",
    );
  }

  const mode =
    evidence.provider ===
      "AWS"
      ? awsMode(
          evidence,
          blockers,
        )
      : azureMode(
          evidence,
          blockers,
        );

  if (!mode) {
    blockers.push(
      evidence.provider +
        " approved production identity mode could not be established from the supplied evidence.",
    );
  }

  return {
    ready:
      blockers.length === 0,
    ...(mode
      ? { mode }
      : {}),
    blockers: [
      ...new Set(
        blockers,
      ),
    ],
  };
}
