# Runner hardening

**Status:** implemented (step 1 of the destroy-preview build order in `docs/teardown-broker-review.md`, Decision 4). This is a security-related **compatibility change**: tools run by the governed runner no longer inherit the operator's environment. Read [What changes for operators](#what-changes-for-operators).

## What it does

`runAllowlistedProcess` (used by every IaC adapter and the AWS/Azure read tools in the broker) now runs each tool through `runBoundedProcess` (`src/tools/process.ts`). The call signature is unchanged, so no adapter changed.

| Requirement | How | Where |
| --- | --- | --- |
| Allowlisted child environment | The child starts from an **empty** environment. It receives a controlled `PATH`, a private `HOME` and `TMPDIR`, `CI`, `TF_IN_AUTOMATION`, `LANG`/`LC_ALL`/`TZ`, and nothing else from the operator's shell. | `src/tools/child-env.ts` |
| Explicit credential injection | A credential reaches a tool only as `ALZ_<IDENTITY>_<VARIABLE>`, delivered as `<VARIABLE>`, and only if that executable's profile lists the variable. Anything else is refused and reported **by name**. | `child-env.ts`, `src/tools/profiles.ts` |
| Controlled executable paths | Executables resolve against approved directories, **not** the inherited `PATH`, and run by absolute path. A directory that is missing, relative or world-writable is dropped. The working directory is never searched. | `child-env.ts` |
| Controlled working directories | The directory must exist and (when a root is given) stay inside it. The broker already checks this; the runner repeats it as defense in depth. | `process.ts` |
| No generic shell construction | `shell: false`; the executable must be a bare name; arguments are plain strings with no NUL. A test pins the absence of `shell: true`, `exec(` and `execSync`. | `process.ts` |
| Approved network destinations | An endpoint or proxy override (for example `AWS_ENDPOINT_URL`, `HTTPS_PROXY`) must name an approved host: the profile's list, loopback, or the operator's `ALZ_APPROVED_HOSTS`. | `child-env.ts`, `profiles.ts` |
| Time, output and process limits | A timeout (default 120 s, `SIGKILL`) and an output cap (1 MiB per stream, enforced on the bytes returned). See [what is not enforced](#what-this-does-not-do). | `process.ts` |
| Redacted logs, protected artifacts | Injected secret values are replaced with `[REDACTED]` in output and diagnostics. Engine tools (Terraform, OpenTofu, Pulumi, CDK, Ansible, Crossplane) log **no output excerpts**, because plan, state and program output can carry secrets. Each child gets a `0700` private directory that is removed afterwards; `createPrivateDirectory` is available for artifacts. | `process.ts`, `private-workdir.ts` |

Variables that change what runs or where it is found can **never** be injected, whatever a profile says: `PATH`, `HOME`, `TMPDIR`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`, `PYTHONPATH`, `BASH_ENV`, `SHELL` and similar (`NEVER_INJECTABLE`). `HOME` matters most: a child that inherited it could read `~/.aws/credentials`, `~/.azure` or `~/.terraformrc`, which is the operator's identity.

A new executable needs a profile before the runner will run it. Adding one means writing down which variables and hosts it may use. An executable with no profile is refused, and a test checks that every executable an adapter runs has one.

## What changes for operators

1. **Ambient credentials and `HOME` are not inherited.** `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `~/.aws`, `az login` state, `GITHUB_TOKEN`, `TF_VAR_*` set in your shell and everything else stop reaching the tools. Live discovery and previews need a named identity (below).
2. **`PATH` is not consulted.** Tools are found in `/usr/local/bin`, `/usr/bin`, `/bin`, `/opt/homebrew/bin` and any directory in `ALZ_TOOL_DIRS` (colon-separated, absolute, not world-writable). Installed elsewhere (nvm, `~/.local/bin`)? Add the directory. Pulumi and CDK also need `node` reachable the same way.
3. **Absolute-path and unprofiled executables are refused** by `runAllowlistedProcess`.
4. **Output is capped at 1 MiB per stream.** This matches the previous effective limit (Node's implicit default); it is now explicit and enforced on what is returned.

### Giving a tool an identity

The default identity is `DISCOVERY`. Set variables with the `ALZ_DISCOVERY_` prefix; the runner strips it:

```sh
# AWS: a narrowly scoped, read-only identity, not your own credentials
export ALZ_DISCOVERY_AWS_ACCESS_KEY_ID=...
export ALZ_DISCOVERY_AWS_SECRET_ACCESS_KEY=...
export ALZ_DISCOVERY_AWS_SESSION_TOKEN=...
export ALZ_DISCOVERY_AWS_REGION=eu-west-1

# Azure: a config directory logged in as a dedicated identity
export ALZ_DISCOVERY_AZURE_CONFIG_DIR=/secure/path/az-discovery

# Terraform inputs
export ALZ_DISCOVERY_TF_VAR_aws_region=eu-west-1

# Proxy and CA settings use a separate channel, and a proxy host must be approved
export ALZ_NETWORK_HTTPS_PROXY=127.0.0.1:3128
export ALZ_APPROVED_HOSTS='*.corp.example.com'
export ALZ_TOOL_DIRS=/opt/tools/bin
```

A refused variable is reported by name in the tool result (`refusedEnvironment`), never by value, so a denial says what to fix.

The identity name is `[A-Z][A-Z0-9]{1,15}`. `DISCOVERY` is the only one existing consumers use. `STATE` is the state-reader identity. Only these two names are accepted, and a variable set for one is never delivered under the other. See `docs/identity-and-execution-contracts.md`.

## What this does not do

Be exact about the limits.

- **Environment minimization is not isolation.** A tool that runs project code (a Terraform provider or `external` data source, a Pulumi program, CDK synth, Ansible, Crossplane functions) runs with that tool's own privileges and whatever identity it was given. This change removes ambient authority from the child; it does not sandbox what the child does with its authority. The execution-permission gate for executable plans is in `docs/identity-and-execution-contracts.md`.
- **Network confinement.** The runner can refuse an unapproved endpoint *override*, but a child can still open connections to anywhere the host allows. Real confinement needs the container or egress layer.
- **Process count, memory and CPU.** Node's `spawnSync` cannot cap how many processes a child starts or how much it uses. The Docker runtime (`compose.yaml`) already sets `read_only`, a `tmpfs` for `/tmp`, `cap_drop: ALL` and `no-new-privileges`, but it sets **no** `pids_limit`, memory, CPU or network limit. Adding those is a deployment decision with real numbers; it is recommended and not done here.
- **Executables are trusted once found.** Resolution only controls *where* a binary comes from. It does not verify the binary's identity or version; version pinning belongs to qualification.
- **The caller's own `process.env`.** The runner protects its children. Code in the same Node process still holds its own environment.

## Not covered by this change

Child processes started **outside** `runAllowlistedProcess` are unchanged:

- `src/cli/real-private-build.ts` starts `terraform` itself, with the full inherited environment (`env: { ...process.env, ... }`). It is a trusted, human-invoked driver, so this is not an agent path, but it is exactly the pattern the destroy-preview driver must not copy. It should move onto the runner once identities are defined (build steps 2 and 4).
- `src/build/repository.ts` runs `git` for read-only repository evidence, and the `src/cli/*` launchers start the repository's own scripts with `node`/`tsx`. They run no cloud or IaC tool.

## Tests

`test/runner-hardening.test.ts` runs a real child (`node`) so behavior is observed, not assumed. It proves:
- a long list of unrelated credentials (AWS, Azure, GitHub, npm, Anthropic, Pulumi, Terraform tokens, `SSH_AUTH_SOCK`, `LD_PRELOAD`, `NODE_OPTIONS`) is **not** inherited, the child sees only the allowed variables, and **it cannot read a credentials file under the operator's `HOME`**;
- credentials arrive only through an explicit identity, only if the profile lists them, delivery is verified by fingerprint (so no test prints a secret), and identities do not bleed into each other;
- no profile can make `PATH`, `HOME`, loader or interpreter variables injectable;
- URL overrides name approved hosts only, including look-alike hosts;
- executable resolution refuses world-writable directories, traversal and a planted binary in the working directory;
- arguments are data (`; echo`, `$(id)`, backticks pass through literally);
- a runaway child is killed by the timeout and its output is capped on the bytes returned;
- secrets are redacted from output and diagnostics, and engine tools log no excerpts;
- every executable the adapters run has a profile, and `sh`, `bash`, `curl`, `sudo`, `node` and `python3` are refused.

The existing boundary pins (`test/destroy-preview-boundary.test.ts`, `test/tool-broker.test.ts`) still pass. One existing test, "debug context captures adapter process exit and sanitized output metadata", passed an absolute path to `node` as the "allowlisted" executable, which the hardened runner now correctly refuses. It was moved to the runner's test seam with its assertions unchanged.
