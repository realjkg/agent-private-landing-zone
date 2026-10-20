import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyImage } from './container-signature.mjs';

const digestRef = /^ghcr\.io\/realjkg\/agent-private-landing-zone@sha256:[a-f0-9]{64}$/;
export function validateRuntime(info, container, status, apparmor, image, seccompText) {
  const h = container.HostConfig, c = container.Config;
  if (info.OSType !== 'linux' || !['x86_64', 'aarch64', 'amd64', 'arm64'].includes(info.Architecture) ||
      !info.SecurityOptions?.some(x => /name=apparmor/.test(x)) ||
      !info.SecurityOptions?.some(x => /name=seccomp/.test(x))) throw new Error('HOST_CONFINEMENT_UNAVAILABLE');
  if (!digestRef.test(image) || c.Image !== image || !container.State?.Running ||
      c.User !== '1000:1000' || !h.ReadonlyRootfs || h.Privileged || h.NetworkMode !== 'none' ||
      !h.Init || h.PidMode || h.IpcMode === 'host' || h.UsernsMode === 'host' ||
      h.PidsLimit !== 128 || h.Memory !== 1073741824 || h.NanoCpus !== 2000000000 ||
      h.CapAdd?.length || !h.CapDrop?.some(x => x.toUpperCase() === 'ALL') || h.Devices?.length ||
      h.Binds?.some(x => /docker\.sock/.test(x))) throw new Error('RUNTIME_POLICY_MISMATCH');
  const opts = h.SecurityOpt ?? [];
  if (Object.keys(h.Tmpfs ?? {}).some(path => path !== '/tmp') ||
      h.DeviceRequests?.length || h.DeviceCgroupRules?.length || h.VolumesFrom?.length)
    throw new Error('RUNTIME_POLICY_MISMATCH');
  const tmp = h.Tmpfs?.['/tmp'] ?? '';
  if (!['noexec', 'nosuid', 'nodev', 'size=67108864'].every(x => tmp.split(',').includes(x)))
    throw new Error('TMPFS_POLICY_MISMATCH');
  if (!opts.includes('no-new-privileges:true') && !opts.includes('no-new-privileges'))
    throw new Error('NO_NEW_PRIVILEGES_REQUIRED');
  const sec = opts.find(x => x.startsWith('seccomp='))?.slice(8);
  // Docker retains normalized profile JSON in HostConfig, not its source pathname.
  if (!sec || JSON.stringify(JSON.parse(sec)) !== JSON.stringify(JSON.parse(seccompText)) ||
      container.AppArmorProfile !== 'alz-runtime' || !/^alz-runtime \(enforce\)\s*$/.test(apparmor) ||
      !/^Seccomp:\s+2\s*$/m.test(status) || !/^NoNewPrivs:\s+1\s*$/m.test(status))
    throw new Error('CONFINEMENT_NOT_ENFORCED');
  const mounts = container.Mounts ?? [];
  if (mounts.some(m => !['/app/.runs', '/run/alz-keys', '/tmp'].includes(m.Destination)) ||
      mounts.some(m => m.Destination === '/tmp' && m.Type !== 'tmpfs') ||
      !mounts.some(m => m.Destination === '/app/.runs' && m.Type === 'volume' && m.RW) ||
      !mounts.some(m => m.Destination === '/run/alz-keys' && m.Type === 'volume' && !m.RW))
    throw new Error('MOUNT_POLICY_MISMATCH');
}
export function inspectRuntime(name, image) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !digestRef.test(image))
    throw new Error('RUNTIME_ARGUMENT_INVALID');
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1048576 });
  const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
  const [container] = JSON.parse(docker(['inspect', name]));
  const read = path => docker(['exec', name, 'node', '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', path]);
  const sec = readFileSync('security/seccomp.json', 'utf8');
  validateRuntime(info, container, read('/proc/1/status'), read('/proc/1/attr/current'), image, sec);
  return { status: 'CONFINEMENT_OBSERVED', image, containerId: container.Id,
    architecture: info.Architecture, kernel: info.KernelVersion, docker: info.ServerVersion,
    seccompSha256: createHash('sha256').update(sec).digest('hex'),
    expectedApparmorSha256: createHash('sha256').update(readFileSync('security/alz-runtime.apparmor')).digest('hex'),
    apparmorProfile: container.AppArmorProfile, observedAt: new Date().toISOString(),
    productionReleaseApproved: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const verification = verifyImage(process.argv[3], process.argv[4], JSON.parse(readFileSync('config/container-bases.json', 'utf8')));
  console.log(JSON.stringify({ ...verification, ...inspectRuntime(process.argv[2], process.argv[3]) }, null, 2));
}
