import { PLUGIN_CATALOG } from "../plugins/catalog.js";

export type OfflineCase = {
  id: string;
  engine: (typeof PLUGIN_CATALOG)[number]["id"];
  provider: string;
  estate: "greenfield" | "brownfield" | "unknown";
  expected: "PREVIEW" | "DENY_UNKNOWN" | "DENY_GREENFIELD" |
    "NOT_APPLICABLE" | "PLAN_REQUIRED";
};
export function catalogOfflineCases(): OfflineCase[] {
  const result: OfflineCase[] = [];
  const estates = ["greenfield", "brownfield", "unknown"] as const;
  for (const plugin of PLUGIN_CATALOG) {
    if (plugin.status !== "IMPLEMENTED") continue;
    for (const provider of ["AWS", "AZURE"] as const) {
      for (const estate of estates) {
        const expected: OfflineCase["expected"] =
          !plugin.providers.includes(provider) ? "NOT_APPLICABLE" :
          estate === "unknown" ? "DENY_UNKNOWN" :
          estate === "greenfield" && provider === "AWS" &&
          ["CLOUDFORMATION", "AWS_CDK"].includes(plugin.id)
            ? "DENY_GREENFIELD" : "PREVIEW";
        result.push({ id: [plugin.id, provider, estate].join("-").toLowerCase(),
          engine: plugin.id, provider, estate, expected });
      }
    }
    for (const provider of plugin.providers) {
      if (provider === "AWS" || provider === "AZURE") continue;
      for (const estate of estates) result.push({
        id: [plugin.id, provider, estate].join("-").toLowerCase(),
        engine: plugin.id, provider, estate, expected: "PLAN_REQUIRED",
      });
    }
  }
  if (new Set(result.map(r => r.id)).size !== result.length)
    throw new Error("DUPLICATE_ADAPTER_CASE");
  return result;
}
