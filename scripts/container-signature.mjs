import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const repository = 'ghcr.io/realjkg/agent-private-landing-zone';
export const sourceRepository = 'https://github.com/realjkg/agent-private-landing-zone';
export const workflow = 'realjkg/agent-private-landing-zone/.github/workflows/container-release.yml@refs/heads/main';
export const signer = 'https://github.com/' + workflow;
export const issuer = 'https://token.actions.githubusercontent.com';
export const predicateType = 'https://slsa.dev/provenance/v1';
export const sbomType = 'https://cyclonedx.org/bom';
const digestPattern = /^[a-f0-9]{64}$/;
const buildType = sourceRepository + '/container-build/v1';

function validateArguments(image, source) {
  if (!image?.startsWith(repository + '@sha256:') || !digestPattern.test(image.slice(repository.length + 8)) ||
      !/^[a-f0-9]{40}$/.test(source)) throw new Error('IMAGE_ARGUMENT_INVALID');
}
function validateSubject(statement, image, type) {
  const digest = image.split('@sha256:')[1];
  if (!['https://in-toto.io/Statement/v0.1', 'https://in-toto.io/Statement/v1'].includes(statement?._type) ||
      statement.predicateType !== type || !Array.isArray(statement.subject) || statement.subject.length !== 1 ||
      statement.subject[0]?.name !== repository || statement.subject[0]?.digest?.sha256 !== digest)
    throw new Error('IMAGE_SUBJECT_MISMATCH');
}
export function baseMaterials(bases, platform) {
  const arch = platform.split('/')[1];
  return bases.bases.flatMap(b => [
    { uri: b.repository + ':' + b.image.split(':')[1], digest: { sha256: b.digest.slice(7) } },
    { uri: b.repository + '@' + b.digest + '#linux/' + arch, digest: { sha256: b.platforms[arch].slice(7) } },
  ]);
}
export function validateImageIndex(bytes, image, platform) {
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== image.split('@')[1])
    throw new Error('IMAGE_INDEX_DIGEST_MISMATCH');
  const index = JSON.parse(bytes.toString());
  if (index?.schemaVersion !== 2 || !['application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json'].includes(index.mediaType) || !Array.isArray(index.manifests))
    throw new Error('IMAGE_INDEX_INVALID');
  const candidates = index.manifests.filter(m => m?.platform?.os === 'linux' && m.platform.architecture === platform.split('/')[1]);
  if (candidates.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(candidates[0].digest))
    throw new Error('IMAGE_INDEX_PLATFORM_MISMATCH');
  return candidates[0].digest;
}
export function validateProvenance(statement, image, source, bases) {
  validateArguments(image, source);
  validateSubject(statement, image, predicateType);
  const p = statement.predicate;
  const definition = p?.buildDefinition;
  const external = definition?.externalParameters;
  const metadata = p?.runDetails?.metadata;
  if (p?.runDetails?.builder?.id !== signer || definition?.buildType !== buildType ||
      external?.sourceCommit !== source || external.repository !== sourceRepository || external.image !== image ||
      !['linux/amd64', 'linux/arm64'].includes(external.platform) ||
      definition.internalParameters?.workflow !== workflow ||
      !/^https:\/\/github\.com\/realjkg\/agent-private-landing-zone\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/.test(metadata?.invocationId ?? '') ||
      metadata?.toolVersions?.cosign !== 'v3.0.2' ||
      !['node', 'docker', 'buildx'].every(key => typeof metadata?.toolVersions?.[key] === 'string' &&
        metadata.toolVersions[key].length > 0 && metadata.toolVersions[key].length <= 512))
    throw new Error('IMAGE_PROVENANCE_MISMATCH');
  const encodedIndex = definition.internalParameters.imageIndex;
  if (typeof encodedIndex !== 'string' || encodedIndex.length > 131072 ||
      validateImageIndex(Buffer.from(encodedIndex, 'base64'), image, external.platform) !== external.nativeManifestDigest)
    throw new Error('IMAGE_INDEX_PROVENANCE_MISMATCH');
  const materials = baseMaterials(bases, external.platform);
  if (!Array.isArray(definition.resolvedDependencies) || definition.resolvedDependencies.length !== materials.length ||
      !materials.every(expected => definition.resolvedDependencies.filter(actual => actual?.uri === expected.uri &&
        actual.digest?.sha256 === expected.digest.sha256).length === 1))
    throw new Error('IMAGE_BASE_PROVENANCE_MISSING');
  return external.platform;
}
export function validateSbom(statement, image) {
  validateSubject(statement, image, sbomType);
  const p = statement.predicate;
  if (p?.bomFormat !== 'CycloneDX' || !['1.4', '1.5', '1.6'].includes(p.specVersion) ||
      !Array.isArray(p.components) || p.components.length === 0 ||
      !p.components.every(c => typeof c.name === 'string' && c.name.length > 0 && typeof c.version === 'string'))
    throw new Error('IMAGE_SBOM_INVALID');
}
function envelopes(text) {
  let parsed;
  try { const value = JSON.parse(text); parsed = Array.isArray(value) ? value : [value]; }
  catch { parsed = text.trim().split('\n').map(line => JSON.parse(line)); }
  return parsed.map(envelope => {
    if (envelope.payloadType !== 'application/vnd.in-toto+json' || typeof envelope.payload !== 'string')
      throw new Error('IMAGE_ATTESTATION_INVALID');
    return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  });
}
const cosign = args => execFileSync('cosign', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8388608 });
/** run is a trusted local test seam; only cosign-authenticated output may be parsed. */
export function verifyImage(image, source, bases, run = cosign) {
  validateArguments(image, source);
  const trust = ['--certificate-identity', signer, '--certificate-oidc-issuer', issuer];
  run(['verify', ...trust, image]);
  let platform;
  for (const statement of envelopes(run(['verify-attestation', ...trust, '--type', predicateType, image]))) {
    try { platform = validateProvenance(statement, image, source, bases); break; }
    catch { /* A different signed statement cannot satisfy this source. */ }
  }
  if (!platform) throw new Error('IMAGE_PROVENANCE_MISSING');
  let sbomValid = false;
  for (const statement of envelopes(run(['verify-attestation', ...trust, '--type', 'cyclonedx', image]))) {
    try { validateSbom(statement, image); sbomValid = true; break; }
    catch { /* Require the CycloneDX payload and exact signed subject. */ }
  }
  if (!sbomValid) throw new Error('IMAGE_SBOM_MISSING');
  return { image, sourceCommit: source, platform, signatureAndProvenanceVerified: true, productionReleaseApproved: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync } = await import('node:fs');
  console.log(JSON.stringify(verifyImage(process.argv[2], process.argv[3], JSON.parse(readFileSync('config/container-bases.json', 'utf8'))), null, 2));
}
