import { createApiEnvironmentProvider, createSignedEdgeEnvironmentProvider } from "../environment/read-only.js";
import type { EnvironmentBinding } from "../environment/types.js";
import type { RuntimeProfileId } from "../runtime-profile/types.js";
import { jsonOption, reason, record, runReport } from "../enterprise/report.js";

// ./alz enterprise environment --input FILE
// FILE is one of:
//   { "binding": { environmentId, provider, runtimeProfile, deployment, origin, authRef? } }
//     checks the binding against the runtime profile's sovereignty and egress rules.
//     authRef is a reference such as secret://name, never a credential. No request is sent.
//   { "edge": { rawManifest, signatureBase64, trustedPublicKeyPem, runtimeProfile } }
//     verifies a signed offline manifest and shows its inventory.
// Providers are read-only (GET, or a signed file). Nothing here contacts an environment.
const BINDING_KEYS = ["environmentId", "provider", "runtimeProfile", "deployment", "origin", "authRef"];

await runReport(async (args) => {
  const input = record(jsonOption(args, "input"));
  try {
    if (input.edge !== undefined) {
      const edge = record(input.edge);
      const snapshot = await createSignedEdgeEnvironmentProvider({
        rawManifest: String(edge.rawManifest), signatureBase64: String(edge.signatureBase64),
        trustedPublicKeyPem: String(edge.trustedPublicKeyPem), runtimeProfile: edge.runtimeProfile as RuntimeProfileId,
      }).discover();
      return { ok: true, lines: ["SIGNED EDGE MANIFEST VERIFIED", snapshot.environmentId + ": health " + snapshot.health + ", " + snapshot.inventory.length + " assets",
        ...snapshot.warnings, "Read-only. Mutation is not supported."] };
    }
    const binding = record(input.binding);
    if (Object.keys(binding).some((key) => !BINDING_KEYS.includes(key))) throw new Error("ENVIRONMENT_BINDING_FIELD_UNKNOWN");
    // Building the provider validates the binding; the transport is never called because nothing is discovered.
    const provider = createApiEnvironmentProvider(binding as EnvironmentBinding, () => Promise.reject(new Error("ENVIRONMENT_NO_LIVE_CALLS")));
    if (provider.capabilities().mutation) throw new Error("ENVIRONMENT_MUTATION_UNEXPECTED");
    return { ok: true, lines: ["ENVIRONMENT BINDING ACCEPTED", String(binding.environmentId) + ": " + String(binding.provider) + " via " + String(binding.runtimeProfile) +
      " (" + String(binding.deployment) + ")", "Reads are GET only. This check sent no request and holds no credential.",
      "Customer reachability, RBAC and CA trust still need qualification in your sandbox."] };
  } catch (error) {
    return { ok: false, lines: ["ENVIRONMENT CONFIGURATION REJECTED: " + reason(error)] };
  }
});
