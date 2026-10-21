// Human-invoked production CLI wrapper. Does not install profiles or apply IaC.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyImage } from './container-signature.mjs';
import { inspectRuntime } from './container-preflight.mjs';

export function validateCommand(args) {
  const command = args.length ? args : ['help'];
  if (command.length !== 1 || !['help', '--help', '-h', 'plugins', 'sbom', 'prompts', 'prompt-guide'].includes(command[0]))
    throw new Error('CONFINED_COMMAND_DENIED');
  return command;
}
export function runContainer(image, source, args) {
  const command = validateCommand(args);
  const verification = verifyImage(image, source, JSON.parse(readFileSync('config/container-bases.json', 'utf8')));
  const env = { ...process.env, ALZ_IMAGE: image };
  const docker = (argv, options = {}) => execFileSync('docker', argv, {
    env, encoding: 'utf8', timeout: 30000, maxBuffer: 1048576, ...options
  });
  let id;
  try {
    // Idle Node process permits inspection before any operator operation runs.
    id = docker(['compose', '-f', 'compose.production.yaml', 'run', '-d', '--no-deps',
      '--entrypoint', 'node', 'alz', '-e', 'setInterval(()=>{},1000)']).trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('CONTAINER_ID_INVALID');
    const report = inspectRuntime(id, image);
    const arch = ['arm64', 'aarch64'].includes(report.architecture) ? 'arm64' : 'amd64';
    if (verification.platform !== 'linux/' + arch) throw new Error('IMAGE_PLATFORM_MISMATCH');
    process.stdout.write(JSON.stringify(report) + '\n');
    docker(['exec', id, 'node', 'dist/cli/operator.js', ...command],
      { stdio: 'inherit', timeout: 120000 });
  } finally {
    if (id && /^[a-f0-9]{64}$/.test(id)) docker(['rm', '-f', id]);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runContainer(process.argv[2], process.argv[3], process.argv.slice(4));
}
