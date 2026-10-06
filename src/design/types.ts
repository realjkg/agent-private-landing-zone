import type {
  EnvironmentClassification,
  Provider,
} from "../discovery/types.js";
import type {
  DeltaAction,
} from "../delta/types.js";
import type {
  PluginDefinition,
} from "../plugins/catalog.js";

export type DesignStatus =
  | "PROPOSED"
  | "REVIEW_REQUIRED"
  | "BLOCKED";

export type PluginSelectionStatus =
  | "READY"
  | "PLANNED"
  | "INCOMPATIBLE";

export type DesignPluginSelection = {
  plugin: PluginDefinition["id"];
  status: PluginSelectionStatus;
  buildEligible: boolean;
  evidencePath:
    | "PLAN"
    | "PREVIEW"
    | "WHAT_IF"
    | "CHANGE_SET"
    | "CDK_SYNTH_CHANGE_SET"
    | "CONTROLLER_PREVIEW"
    | "CHECK_MODE";
  rationale: string;
};

export type DesignEntry = {
  resourceId: string;
  resourceType: string;
  action: DeltaAction;
  rationale: string;
  requiresExplicitAuthorization: boolean;
};

export type DesignSpec = {
  designId: string;
  designHash: string;
  provider: Provider;
  environment: EnvironmentClassification;
  objective: string;
  status: DesignStatus;
  plugin: DesignPluginSelection;
  entries: DesignEntry[];
  constraints: string[];
  reuse: string[];
  additions: string[];
  forbiddenChanges: string[];
  securityControls: string[];
  resiliencyControls: string[];
  assumptions: string[];
  evidenceRefs: string[];
  generatedAt: string;
};
