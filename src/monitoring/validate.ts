import {
  monitoringProvider,
} from "./catalog.js";
import type {
  MonitoringBinding,
  MonitoringValidation,
} from "./types.js";
import {
  runtimeProfile,
} from "../runtime-profile/catalog.js";
import type {
  RuntimeProfileId,
} from "../runtime-profile/types.js";

export function opaqueSecretRef(
  value: string,
): boolean {
  return (
    value.startsWith("secret://") ||
    value.startsWith("vault://") ||
    value.startsWith("keyring://")
  );
}

export function validateMonitoringBinding(
  profileId: RuntimeProfileId,
  binding: MonitoringBinding,
): MonitoringValidation {
  const profile =
    runtimeProfile(profileId);
  const provider =
    monitoringProvider(
      binding.provider,
    );
  const reasons: string[] = [];

  if (
    profile.sovereignty ===
      "PRIVATE_SOVEREIGN" &&
    !provider.privateCapable
  ) {
    reasons.push(
      binding.provider +
        " is not valid inside a strict private-sovereign runtime profile.",
    );
  }

  if (
    profile.connectivity ===
      "DISCONNECTED" &&
    binding.deployment !== "LOCAL"
  ) {
    reasons.push(
      "Disconnected sovereign profiles require local monitoring deployment.",
    );
  }

  if (
    !profile
      .externalTelemetryAllowed &&
    binding.deployment ===
      "EXTERNAL"
  ) {
    reasons.push(
      "External telemetry is prohibited by the runtime profile.",
    );
  }

  if (
    profile.connectivity ===
      "SAME_SOVEREIGN_DOMAIN_ONLY" &&
    binding.deployment ===
      "EXTERNAL"
  ) {
    reasons.push(
      "Monitoring must remain inside the approved sovereign domain.",
    );
  }

  if (
    profile.connectivity ===
      "DISCONNECTED" &&
    !provider.supportsDisconnected
  ) {
    reasons.push(
      binding.provider +
        " does not support disconnected operation.",
    );
  }

  if (
    provider.directEventExport &&
    !binding.endpoint
  ) {
    reasons.push(
      "Direct monitoring export requires an endpoint.",
    );
  }

  if (
    binding.provider ===
      "SPLUNK_HEC" &&
    !binding.authRef
  ) {
    reasons.push(
      "Splunk HEC requires an opaque authentication reference.",
    );
  }

  if (
    binding.authRef &&
    !opaqueSecretRef(
      binding.authRef,
    )
  ) {
    reasons.push(
      "Monitoring credentials must be supplied as opaque secret references.",
    );
  }

  return {
    allowed:
      reasons.length === 0,
    reasons,
  };
}
