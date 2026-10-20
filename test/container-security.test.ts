import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateBases } from "../scripts/container-bases.mjs";
import { validateRuntime } from "../scripts/container-preflight.mjs";

const read = (p: string) => readFileSync(p, "utf8");
const lock = JSON.parse(read("config/container-bases.json"));
const dockerfile = read("Dockerfile");
const image = "ghcr.io/realjkg/agent-private-landing-zone@sha256:" + "a".repeat(64);
test("all external image stages are locked; tag-only, wrong identity and architecture drift fail", () => {
  validateBases(lock, dockerfile);
  assert.throws(() => validateBases(lock, dockerfile.replace(/@sha256:[a-f0-9]{64}/, "")));
  assert.throws(() => validateBases(lock, dockerfile.replace("node:26-alpine", "evil:26-alpine")));
  assert.throws(() => validateBases(lock, dockerfile.replace(/@sha256:[a-f0-9]{64}/, "@sha256:" + "0".repeat(64))));
  const changed = structuredClone(lock); delete changed.bases[0].platforms.arm64;
  assert.throws(() => validateBases(changed, dockerfile));
});
test("production preflight rejects unconfined, privileged, mutable and wrong-mount runtimes", () => {
  const sec = read("security/seccomp.json");
  const host = { OSType: "linux", Architecture: "arm64", SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin"] };
  const runtime = { State: { Running: true }, Config: { Image: image, User: "1000:1000" },
    AppArmorProfile: "alz-runtime", Mounts: [{ Type: "volume", Destination: "/app/.runs", RW: true },
      { Type: "volume", Destination: "/run/alz-keys", RW: false }],
    HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: "none", Init: true,
      PidsLimit: 128, Memory: 1073741824, NanoCpus: 2000000000, CapDrop: ["ALL"],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=67108864,mode=1777' },
      SecurityOpt: ["no-new-privileges:true", "seccomp=" + sec, "apparmor=alz-runtime"] } };
  const status = "Seccomp:\t2\nNoNewPrivs:\t1\n";
  const verify = (r = runtime, h = host, s = status, aa = "alz-runtime (enforce)\n") => validateRuntime(h, r, s, aa, image, sec);
  verify();
  for (const change of [{ Privileged: true }, { NetworkMode: "host" }, { ReadonlyRootfs: false }, { CapAdd: ["SYS_ADMIN"] },
    { SecurityOpt: ["seccomp=unconfined"] }, { Memory: 0 }, { Tmpfs: { "/app": "rw" } }, { DeviceRequests: [{}] }, { VolumesFrom: ["other"] }])
    assert.throws(() => verify({ ...runtime, HostConfig: { ...runtime.HostConfig, ...change } } as typeof runtime));
  assert.throws(() => verify(runtime, { ...host, OSType: "darwin" }));
  assert.throws(() => verify(runtime, host, "Seccomp:\t0\nNoNewPrivs:\t0\n"));
  assert.throws(() => verify(runtime, host, status, "alz-runtime (complain)"));
  assert.throws(() => verify({ ...runtime, Mounts: [{ Type: "bind", Destination: "/app/.runs", RW: true }] }));
});
test("production confinement stays separate from development; signing has no PR trigger", () => {
  assert.doesNotMatch(read("compose.yaml"), /apparmor|seccomp|ALZ_IMAGE/);
  assert.match(read("compose.production.yaml"), /network_mode: none/);
  assert.match(read("compose.production.yaml"), /apparmor=alz-runtime/);
  const release = read(".github/workflows/container-release.yml");
  assert.doesNotMatch(release, /pull_request:/);
  assert.match(release, /environment: production-image-release/);
  assert.match(release, /prevent_self_review/);
  const seccomp = JSON.parse(read("security/seccomp.json"));
  assert.equal(seccomp.defaultAction, "SCMP_ACT_ERRNO");
  assert.ok(seccomp.archMap.some((a: any) => a.architecture === "SCMP_ARCH_AARCH64"));
  assert.ok(seccomp.archMap.some((a: any) => a.architecture === "SCMP_ARCH_X86_64"));
});
