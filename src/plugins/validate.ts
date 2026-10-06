import {
  PLUGIN_CATALOG,
  type PluginDefinition,
} from "./catalog.js";

const MAX_REVIEW_AGE_DAYS = 90;
const DAY_MS = 86_400_000;

export function validatePluginCatalog(
  now = new Date(),
): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const plugin of PLUGIN_CATALOG) {
    if (ids.has(plugin.id)) {
      errors.push(
        "Duplicate plug-in id: " + plugin.id,
      );
    }
    ids.add(plugin.id);

    if (
      plugin.status === "IMPLEMENTED" &&
      !plugin.testedVersion
    ) {
      errors.push(
        plugin.id +
          " is implemented but has no testedVersion.",
      );
    }

    if (
      plugin.stage.includes("BUILD") &&
      !plugin.capabilities.includes("PREVIEW")
    ) {
      errors.push(
        plugin.id +
          " BUILD plug-in must provide preview/change evidence.",
      );
    }

    if (
      plugin.stage.includes("BUILD") &&
      !plugin.capabilities.includes("NORMALIZE")
    ) {
      errors.push(
        plugin.id +
          " BUILD plug-in must normalize change evidence.",
      );
    }

    if (
      !plugin.capabilities.includes("SBOM") ||
      !plugin.capabilities.includes(
        "SECURITY_SCAN",
      )
    ) {
      errors.push(
        plugin.id +
          " must participate in SBOM and security scanning.",
      );
    }

    const reviewed =
      Date.parse(plugin.lastReviewed);

    if (!Number.isFinite(reviewed)) {
      errors.push(
        plugin.id +
          " has an invalid lastReviewed date.",
      );
      continue;
    }

    const ageDays =
      (now.getTime() - reviewed) /
      DAY_MS;

    if (ageDays > MAX_REVIEW_AGE_DAYS) {
      errors.push(
        plugin.id +
          " compatibility review is stale (" +
          Math.floor(ageDays) +
          " days).",
      );
    }
  }

  const forbidden = new Set([
    "ARM",
    "ARM_TEMPLATE",
    "POWERSHELL",
  ]);

  for (const plugin of PLUGIN_CATALOG) {
    if (forbidden.has(plugin.id)) {
      errors.push(
        plugin.id +
          " is not an allowed first-class plug-in.",
      );
    }
  }

  return errors;
}

export function implementedPlugins():
  PluginDefinition[] {
  return PLUGIN_CATALOG.filter(
    (plugin) =>
      plugin.status === "IMPLEMENTED",
  );
}
