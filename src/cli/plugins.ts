import {
  implementedPlugins,
  validatePluginCatalog,
} from "../plugins/validate.js";
import {
  PLUGIN_CATALOG,
} from "../plugins/catalog.js";

const errors = validatePluginCatalog();

console.log();
console.log("Agentic Landing Zone");
console.log("────────────────────────────────");
console.log("PLUG-IN COMPATIBILITY");
console.log();

for (const plugin of PLUGIN_CATALOG) {
  console.log(
    plugin.id.padEnd(16) +
      plugin.status.padEnd(13) +
      (plugin.testedVersion ?? "version-on-enable"),
  );
}

console.log();
console.log(
  "Implemented  " +
    implementedPlugins()
      .map((plugin) => plugin.id)
      .join(", "),
);

if (errors.length > 0) {
  console.log();
  console.log("FAILED");
  for (const error of errors) {
    console.log("  • " + error);
  }
  process.exitCode = 1;
} else {
  console.log();
  console.log("✓ catalog current");
  console.log(
    "✓ every plug-in participates in SBOM/security scanning",
  );
  console.log(
    "✓ every Build plug-in exposes preview + normalization semantics",
  );
}
