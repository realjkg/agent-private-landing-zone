import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  discoverEnvironment,
} from "../discovery/discover.js";
import type {
  Provider,
} from "../discovery/types.js";
import {
  qualifyProductionIdentity,
} from "../qualification/identity.js";
import {
  qualifyProviderProduction,
} from "../qualification/provider-production.js";
import {
  executeTool,
} from "../tools/broker.js";
import type {
  ToolContext,
  ToolResult,
} from "../tools/types.js";

function arg(
  name: string,
): string | undefined {
  const args =
    process.argv.slice(2);
  const index =
    args.indexOf(name);
  return index >= 0
    ? args[index + 1]
    : undefined;
}

function requiredArg(
  name: string,
): string {
  const value = arg(name);
  if (!value) {
    throw new Error(
      "PROVIDER_QUALIFICATION_ARGUMENT_REQUIRED: " +
        name,
    );
  }
  return value;
}

function provider(): Provider {
  const value =
    requiredArg(
      "--provider",
    ).toUpperCase();

  if (
    value !== "AWS" &&
    value !== "AZURE"
  ) {
    throw new Error(
      "PROVIDER_QUALIFICATION_PROVIDER_INVALID",
    );
  }

  return value;
}

function rows(
  result:
    | ToolResult
    | ToolResult[],
): ToolResult[] {
  return Array.isArray(result)
    ? result
    : [result];
}

function present(
  value: string | undefined,
): string | undefined {
  return value
    ? "present"
    : undefined;
}

function safeOutputPath(
  value: string,
): string {
  const root =
    resolve(process.cwd());
  const target =
    resolve(root, value);
  const relation =
    relative(root, target);

  if (
    relation === ".." ||
    relation.startsWith(
      ".." + sep,
    )
  ) {
    throw new Error(
      "PROVIDER_QUALIFICATION_OUTPUT_ESCAPE",
    );
  }

  return target;
}

const selectedProvider =
  provider();
const sourceCommit =
  arg("--source-commit") ??
  process.env.GITHUB_SHA ??
  "";
const output =
  safeOutputPath(
    arg("--output") ??
      (
        ".runs/qualification/provider-" +
        selectedProvider.toLowerCase() +
        ".json"
      ),
  );

const environment =
  await discoverEnvironment({
    provider:
      selectedProvider,
  });

const readContext:
  ToolContext = {
    cwd: process.cwd(),
    allowCloudRead: true,
    allowMutation: false,
  };

let identity;
let validationResults:
  ToolResult[];
let preview: ToolResult;

if (
  selectedProvider === "AWS"
) {
  const account =
    environment.resources.find(
      (resource) =>
        resource.resourceType ===
        "AWS::Organizations::Account",
    );
  const callerArn =
    typeof account?.metadata
      ?.callerArn === "string"
      ? account.metadata.callerArn
      : undefined;

  identity =
    qualifyProductionIdentity({
      provider: "AWS",
      awsCallerArn:
        callerArn,
      environment: {
        AWS_ACCESS_KEY_ID:
          present(
            process.env
              .AWS_ACCESS_KEY_ID,
          ),
        AWS_SECRET_ACCESS_KEY:
          present(
            process.env
              .AWS_SECRET_ACCESS_KEY,
          ),
        AWS_SESSION_TOKEN:
          present(
            process.env
              .AWS_SESSION_TOKEN,
          ),
        AWS_WEB_IDENTITY_TOKEN_FILE:
          present(
            process.env
              .AWS_WEB_IDENTITY_TOKEN_FILE,
          ),
        AWS_ROLE_ARN:
          present(
            process.env
              .AWS_ROLE_ARN,
          ),
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  const input = {
    templatePath:
      requiredArg(
        "--aws-template",
      ),
    stackName:
      requiredArg(
        "--aws-stack",
      ),
    changeSetType:
      "UPDATE" as const,
  };

  validationResults =
    rows(
      executeTool(
        {
          tool:
            "cloudformation_validate",
          input,
        },
        readContext,
      ),
    );

  preview =
    rows(
      executeTool(
        {
          tool:
            "cloudformation_preview",
          input,
        },
        {
          ...readContext,
          allowPreviewWrite: true,
        },
      ),
    )[0];
} else {
  const accountResult =
    rows(
      executeTool(
        {
          tool:
            "azure_account_show",
        },
        readContext,
      ),
    )[0];

  let azureUserType:
    string | undefined;

  if (accountResult.ok) {
    try {
      const account =
        JSON.parse(
          accountResult.stdout,
        ) as {
          user?: {
            type?: string;
          };
        };
      azureUserType =
        account.user?.type;
    } catch {
      azureUserType =
        undefined;
    }
  }

  identity =
    qualifyProductionIdentity({
      provider: "AZURE",
      azureUserType,
      environment: {
        AZURE_FEDERATED_TOKEN_FILE:
          present(
            process.env
              .AZURE_FEDERATED_TOKEN_FILE,
          ),
        IDENTITY_ENDPOINT:
          present(
            process.env
              .IDENTITY_ENDPOINT,
          ),
        MSI_ENDPOINT:
          present(
            process.env
              .MSI_ENDPOINT,
          ),
        IMDS_ENDPOINT:
          present(
            process.env
              .IMDS_ENDPOINT,
          ),
        AZURE_CLIENT_SECRET:
          present(
            process.env
              .AZURE_CLIENT_SECRET,
          ),
        ARM_CLIENT_SECRET:
          present(
            process.env
              .ARM_CLIENT_SECRET,
          ),
        AZURE_CLIENT_CERTIFICATE_PATH:
          present(
            process.env
              .AZURE_CLIENT_CERTIFICATE_PATH,
          ),
        ARM_CLIENT_CERTIFICATE_PATH:
          present(
            process.env
              .ARM_CLIENT_CERTIFICATE_PATH,
          ),
        AZURE_PASSWORD:
          present(
            process.env
              .AZURE_PASSWORD,
          ),
      },
      opaqueSecretReferencesOnly:
        true,
      modelVisibleSecretMaterial:
        false,
    });

  const scope =
    (
      arg("--azure-scope") ??
      "subscription"
    ) as
      | "subscription"
      | "resource-group";

  if (
    scope !== "subscription" &&
    scope !== "resource-group"
  ) {
    throw new Error(
      "PROVIDER_QUALIFICATION_AZURE_SCOPE_INVALID",
    );
  }

  const input = {
    bicepFile:
      requiredArg(
        "--azure-bicep",
      ),
    azureScope: scope,
    ...(scope ===
    "resource-group"
      ? {
          resourceGroup:
            requiredArg(
              "--azure-resource-group",
            ),
        }
      : {
          location:
            requiredArg(
              "--azure-location",
            ),
        }),
    deploymentName:
      "alz-provider-qualification",
  };

  validationResults =
    rows(
      executeTool(
        {
          tool:
            "bicep_lint",
          input,
        },
        {
          cwd:
            process.cwd(),
          allowCloudRead:
            false,
          allowMutation: false,
        },
      ),
    );

  preview =
    rows(
      executeTool(
        {
          tool:
            "bicep_what_if",
          input,
        },
        readContext,
      ),
    )[0];
}

const qualification =
  qualifyProviderProduction({
    sourceCommit,
    provider:
      selectedProvider,
    identity,
    environment,
    validationResults,
    preview,
    actEnabled: false,
  });

mkdirSync(
  dirname(output),
  {
    recursive: true,
    mode: 0o700,
  },
);
writeFileSync(
  output,
  JSON.stringify(
    qualification,
    null,
    2,
  ) + "\n",
  {
    encoding: "utf8",
    mode: 0o600,
  },
);

console.log(
  selectedProvider +
    " provider qualification: " +
    (
      qualification.ready
        ? "READY"
        : "BLOCKED"
    ),
);
console.log(
  "Evidence: " +
    output,
);
console.log(
  "ACT: DISABLED",
);

if (!qualification.ready) {
  for (
    const blocker of
    qualification.blockers
  ) {
    console.error(
      "! " + blocker,
    );
  }
  process.exitCode = 1;
}
