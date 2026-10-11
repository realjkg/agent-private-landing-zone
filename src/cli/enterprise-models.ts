import { CANDIDATE_MODELS, candidatesForRole } from "../models/candidates.js";
import { MODEL_CATALOG } from "../models/catalog.js";
import { SOVEREIGN_MODEL_AUTHORITY, substrateAllowedByDefault, type ModelReasoningRole } from "../models/execution-contract.js";
import { option, runReport } from "../enterprise/report.js";

// ./alz enterprise models [--role ROUTER|PRIMARY_ENGINEER|VALIDATOR|SPECIALIST] [--local] [--laptop-24gb]
// Lists the model candidates tracked for architecture fit. A candidate is not in
// the active runtime until it passes the same qualification as the models in the
// catalog (./alz models verify); nothing is run or downloaded here.
const ROLES = ["ROUTER", "PRIMARY_ENGINEER", "VALIDATOR", "SPECIALIST"];

await runReport((args) => {
  const role = option(args, "role");
  if (role !== undefined && !ROLES.includes(role)) throw new Error("MODEL_ROLE_INVALID");
  const filters = { requireLocal: args.includes("--local"), laptopMemoryGb: args.includes("--laptop-24gb") ? 24 : undefined };
  // The filters apply to every role when no --role is given, not only to a chosen one.
  const roles = role ? [role as ModelReasoningRole] : (ROLES as ModelReasoningRole[]);
  const kept = new Set(roles.flatMap((name) => candidatesForRole(name, filters)).map((model) => model.id));
  const chosen = role ? candidatesForRole(roles[0], filters) : CANDIDATE_MODELS.filter((model) => kept.has(model.id));
  const active = new Set(MODEL_CATALOG.map((model) => model.model));
  return { ok: true, lines: [
    "MODEL CANDIDATES (" + chosen.length + ")",
    ...chosen.map((model) => model.id + ": " + (model.runtimeModel && active.has(model.runtimeModel) ? "IN ACTIVE CATALOG" : "CANDIDATE ONLY, NOT QUALIFIED") +
      "; roles " + model.roles.join("/") + "; 24 GB laptop " + model.laptop24Fit +
      "; substrates " + model.substrates.map((id) => id + (substrateAllowedByDefault(id) ? "" : " (external, not sovereign by default)")).join(", ")),
    "Model authority: advisoryOnly=" + SOVEREIGN_MODEL_AUTHORITY.advisoryOnly + ", actEnabled=" + SOVEREIGN_MODEL_AUTHORITY.actEnabled + ".",
  ] };
});
