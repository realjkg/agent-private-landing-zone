# Linux confinement inputs

seccomp.json is vendored without modification from moby/profiles commit 4b8214fc4971e06172938a1f1554ccff6647ee80, seccomp/default.json, under the adjacent Apache-2.0 license. It is an explicit architecture-aware default-deny profile, not a claim of workload-minimal syscalls. Review upstream changes as code; never silently regenerate at startup.

alz-runtime.apparmor adds workload filesystem/executable confinement. The production overlay has no network by default. Preview tools and private-model/SSO networking require separately reviewed profiles and target qualification. Do not widen this profile simply to make an optional tool pass.
