import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_PROFILES,
  runtimeProfile,
} from "../src/runtime-profile/catalog.js";

test("runtime catalog contains the accepted eight operating profiles", () => {
  assert.equal(
    RUNTIME_PROFILES.length,
    8,
  );

  assert.deepEqual(
    RUNTIME_PROFILES.map(
      (profile) => profile.id,
    ),
    [
      "GOVERNED_ENTERPRISE_CONNECTED",
      "SOVEREIGN_PUBLIC",
      "PRIVATE_SOVEREIGN_CONNECTED",
      "PRIVATE_SOVEREIGN_DISCONNECTED",
      "PRIVATE_SOVEREIGN_MULTI_SITE",
      "SOVEREIGN_EDGE",
      "HYBRID_SOVEREIGN_BOUNDARY",
      "MANAGED_SOVEREIGN_TENANT",
    ],
  );
});

test("every runtime profile preserves local traceability and blocks generic infrastructure act", () => {
  for (const profile of
    RUNTIME_PROFILES) {
    assert.equal(
      profile
        .localTraceabilityRequired,
      true,
    );
    assert.equal(
      profile
        .genericInfrastructureAct,
      false,
    );
  }
});

test("private sovereign disconnected is local-only and disables A2A", () => {
  const profile =
    runtimeProfile(
      "PRIVATE_SOVEREIGN_DISCONNECTED",
    );

  assert.equal(
    profile.sovereignty,
    "PRIVATE_SOVEREIGN",
  );
  assert.equal(
    profile.connectivity,
    "DISCONNECTED",
  );
  assert.equal(
    profile.controlPlane,
    "LOCAL_REQUIRED",
  );
  assert.equal(
    profile.modelLocality,
    "LOCAL_ONLY",
  );
  assert.equal(
    profile.a2a,
    "DISABLED",
  );
  assert.equal(
    profile
      .externalTelemetryAllowed,
    false,
  );
});

test("multi-site private sovereignty confines A2A and telemetry to the sovereign domain", () => {
  const profile =
    runtimeProfile(
      "PRIVATE_SOVEREIGN_MULTI_SITE",
    );

  assert.equal(
    profile.connectivity,
    "SAME_SOVEREIGN_DOMAIN_ONLY",
  );
  assert.equal(
    profile.a2a,
    "SAME_SOVEREIGN_DOMAIN_ONLY",
  );
  assert.equal(
    profile
      .externalTelemetryAllowed,
    false,
  );
});

test("hybrid profile is explicit about external exchange instead of claiming strict private sovereignty", () => {
  const profile =
    runtimeProfile(
      "HYBRID_SOVEREIGN_BOUNDARY",
    );

  assert.equal(
    profile.sovereignty,
    "HYBRID_SOVEREIGN",
  );
  assert.equal(
    profile.connectivity,
    "CONNECTED",
  );
  assert.equal(
    profile
      .externalTelemetryAllowed,
    true,
  );
});
