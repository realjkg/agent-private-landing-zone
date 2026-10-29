# Local tool dependencies: adapter vs installed executable

The ALZ runtime and its IaC adapters are TypeScript. A plug-in marked `IMPLEMENTED` means the adapter and its qualification contract are in the repository. It does **not** mean the executable is installed or reachable on the host. The plug-in catalog's tested version is a compatibility target rather than a discovered installed version.

`./alz doctor` reports three independent layers:
1. **Security preflight** — security defaults and allowed capabilities.
2. **Plug-in compatibility** — adapter code and catalog's tested versions.
3. **Toolbox self-check** — actual executable availability through the governed runner's `approvedToolDirs`, not merely through the shell's `PATH`.

The npm dependency layer is maintained by the committed lockfile and `./alz bootstrap` (`npm ci`). A successful bootstrap with zero vulnerabilities does not imply optional binaries have been installed.

## Minimal AWS Terraform / CDK local workflow (macOS)

From `~/Documents/agent-private-landing-zone`:

```bash
git status --short
./alz deps
./alz doctor
npm run check
npm test
```

`./alz deps` offers an interactive checksum-verified pinned **Terraform 1.16.4** installer. Ollama is for optional private-model inference and is not required for deterministic AWS plan/execute. It does not install every build adapter's executable. AWS CLI and AWS CDK are separate prerequisites for the corresponding AWS workflows, and the reported Mac already has them.

The pinned installer stores Terraform under `$HOME/.alz/tools/terraform/1.16.4/terraform`. Governed tool execution deliberately ignores arbitrary shell PATH. If this binary is present and passed `./alz deps` verification but `./alz doctor` cannot see it, choose an explicitly approved directory:

```bash
export ALZ_TOOL_DIRS="$HOME/.alz/tools/terraform/1.16.4"
./alz doctor
```

### Updating a pinned tool, and what "rollback" means

When `config/tool-pins.json` names a newer version than the one `./alz deps` installed before (for example, the app installed Terraform 1.15.0 and the pin now says 1.16.4), the check says so and `./alz deps` offers **Update to the tested versions**. Everything is a numbered menu choice:

1. The update installs the new pinned version through the same installer as a first install. It downloads into a private file, checks the SHA-256 against the pin, unpacks into a `<version>.partial-<pid>` folder, and renames it into place.
2. The new copy must then report the pinned version. A copy that fails this check is removed again, so the next run downloads a fresh one.
3. The earlier version is not touched during any of this. Only after the new version passes its check does `./alz deps` ask whether to remove the earlier one. The default answer is to keep it.

If the update fails at any step (download, checksum, unpack, missing program or version check), the earlier version is byte-for-byte unchanged and still runs, and `./alz deps` says so. Commands that need the tool stay blocked, because this version of the app uses only the pinned version.

**Rollback** therefore means one thing here. The pin, not the person, chooses the active version, and there is no switch to make this app use an earlier tool version. You go back by running an earlier version of the app, whose own pin names the earlier tool version. If you kept that version, the earlier app finds it in `~/.alz/tools` and uses it without a download. If you removed it, the earlier app offers to install it again. An interrupted install or update leaves at most a `.partial-<pid>` folder and a file in `~/.alz/tmp`. Neither is ever treated as an installed version, and the next run installs normally. Each step is written to the private diagnostic log in `~/.alz/logs`, which holds no paths, URLs or secrets.

You may append other reviewed absolute executable directories, separated by colons. Never add writable shared directories, `.`, or arbitrary downloaded binaries. ALZ checks the directory and executable permission bits. `ALZ_TOOL_DIRS` only changes which **approved executables** the runner can locate; it does not enable cloud read, project execution, preview write or ACT permissions.

Other executables are optional and should be installed only if the selected blueprint uses their engine:
- OpenTofu: `tofu`
- Bicep: `bicep`
- Ansible: `ansible-playbook`
- Crossplane: `crossplane`
- Pulumi: `pulumi` (already detected on the reported Mac)
- CDK: `cdk` (already detected)
- CloudFormation: uses `aws` (already detected)
- Azure: `az` (already detected)

## Version reporting

A difference between an installed CLI version and a catalog's tested version is reported as a **compatibility difference**, not a missing install. For CDK the catalog documents both an AWS CDK CLI and an `aws-cdk-lib` library release; only the CLI is discoverable by `cdk --version`. It is incorrect to infer the library version from that command. Azure CLI `az version` emits JSON, so toolbox extracts the `azure-cli` field instead of displaying `{`.

If a program is found but fails under the governed runner, the toolbox now shows the first bounded error. Do not weaken the sandbox or pass ambient AWS credentials to make a version check pass.

## Release boundary

An installed binary and passing TypeScript build prove local readiness only. Real AWS execution still requires the owner-committed pilot contract with its `authorize` entry, verified discovery and identity, sealed environment-specific artifact, approved blueprint, qualified engine and actual cloud-side verification. The hosted studio.presidio.ai MCP harness can reuse its native agents, skills and connectors; it does not require duplicate local credentials or an extra IaC engine.
