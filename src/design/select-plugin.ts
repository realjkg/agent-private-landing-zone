import type {
  IaCEngine,
} from "../build/types.js";
import type {
  Provider,
} from "../discovery/types.js";
import {
  PLUGIN_CATALOG,
  type PluginDefinition,
} from "../plugins/catalog.js";
import type {
  DesignPluginSelection,
} from "./types.js";

type PluginId =
  PluginDefinition["id"];

function requestedPlugin(
  request: string,
  fallback: IaCEngine,
): PluginId {
  const value = request.toLowerCase();

  if (/aws[ -]?cdk|\bcdk\b/.test(value)) {
    return "AWS_CDK";
  }
  if (/cloudformation|\bcfn\b/.test(value)) {
    return "CLOUDFORMATION";
  }
  if (/\bbicep\b/.test(value)) {
    return "BICEP";
  }
  if (/opentofu|\btofu\b/.test(value)) {
    return "OPENTOFU";
  }
  if (/crossplane|kubernetes|\bk8s\b/.test(value)) {
    return "CROSSPLANE";
  }
  if (/\bansible\b/.test(value)) {
    return "ANSIBLE";
  }
  if (/\bpulumi\b/.test(value)) {
    return "PULUMI";
  }
  if (/\bterraform\b/.test(value)) {
    return "TERRAFORM";
  }

  return fallback;
}

function evidencePath(
  plugin: PluginId,
): DesignPluginSelection["evidencePath"] {
  switch (plugin) {
    case "TERRAFORM":
    case "OPENTOFU":
      return "PLAN";
    case "PULUMI":
      return "PREVIEW";
    case "BICEP":
      return "WHAT_IF";
    case "CLOUDFORMATION":
      return "CHANGE_SET";
    case "AWS_CDK":
      return "CDK_SYNTH_CHANGE_SET";
    case "CROSSPLANE":
      return "CONTROLLER_PREVIEW";
    case "ANSIBLE":
      return "CHECK_MODE";
  }
}

export function selectDesignPlugin(
  provider: Provider,
  request: string,
  fallback: IaCEngine,
): DesignPluginSelection {
  const id = requestedPlugin(
    request,
    fallback,
  );

  const plugin = PLUGIN_CATALOG.find(
    (candidate) => candidate.id === id,
  );

  if (!plugin) {
    throw new Error(
      "DESIGN_PLUGIN_NOT_REGISTERED: " + id,
    );
  }

  const providerCompatible =
    plugin.providers.includes(provider);

  if (!providerCompatible) {
    return {
      plugin: id,
      status: "INCOMPATIBLE",
      buildEligible: false,
      evidencePath: evidencePath(id),
      rationale:
        id +
        " is not registered for " +
        provider +
        "; Design must select a compatible plug-in.",
    };
  }

  const buildCapable =
    plugin.stage.includes("BUILD");

  if (!buildCapable) {
    return {
      plugin: id,
      status: "INCOMPATIBLE",
      buildEligible: false,
      evidencePath: evidencePath(id),
      rationale:
        id +
        " is a CONFIGURE/MANAGE plug-in, not a primary Build engine.",
    };
  }

  const implemented =
    plugin.status === "IMPLEMENTED";

  return {
    plugin: id,
    status:
      implemented
        ? "READY"
        : "PLANNED",
    buildEligible: implemented,
    evidencePath: evidencePath(id),
    rationale:
      id === "AWS_CDK"
        ? "AWS CDK synthesizes to CloudFormation; governed change evidence is normalized through a CloudFormation Change Set."
        : implemented
          ? id +
            " has an implemented preview-only adapter."
          : id +
            " is registered for Design but its execution adapter is not yet implemented.",
  };
}
