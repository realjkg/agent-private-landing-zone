// Explicit operator invocation only. Never part of offline PR qualification.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { checkMcpResponse } from './container-mcp-checks.mjs';

const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath || process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch))
  throw new Error('LINUX_TARGET_AND_CONFIG_REQUIRED');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const endpoint = new URL(config.endpoint);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp')
  throw new Error('PRIVATE_TLS_ENDPOINT_REQUIRED');
const privateIp = ip => {
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
  }
  return ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip);
};
const addresses = await lookup(endpoint.hostname, { all: true });
if (!addresses.length || addresses.some(a => !privateIp(a.address))) throw new Error('PRIVATE_ROUTE_REQUIRED');
if (!/^[a-f0-9]{40}$/.test(config.sourceCommit) || config.sourceCommit !== process.env.ALZ_SOURCE_COMMIT ||
    !/^ghcr\.io\/realjkg\/agent-private-landing-zone@sha256:[a-f0-9]{64}$/.test(config.image) ||
    typeof config.targetHardwareId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(config.targetHardwareId))
  throw new Error('TARGET_BINDING_REQUIRED');
const results = [];
const readToken = path => {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 8192) throw new Error('PRIVATE_TOKEN_FILE_REQUIRED');
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[A-Za-z0-9._-]{16,8192}$/.test(token)) throw new Error('TOKEN_FORMAT_INVALID');
  return token;
};
async function request(token, method, params = {}) {
  // Pin the validated address while preserving normal TLS hostname validation.
  // Redirects are never followed, and DNS cannot rebind between check and call.
  return new Promise((resolve, reject) => {
    const address = addresses[0];
    const req = httpsRequest(endpoint, { method: 'POST', rejectUnauthorized: true, signal: AbortSignal.timeout(15000),
      family: address.family,
      lookup: (_host, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) { req.destroy(new Error('RESPONSE_LIMIT')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, body: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') });
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
  });
}
try {
  const valid = readToken(config.tokens.valid);
  for (const method of ['initialize', 'tools/list']) {
    const r = await request(valid, method);
    results.push({ check: method, passed: checkMcpResponse(method, r), status: r.status, responseSha256: r.sha256 });
  }
  const catalog = await request(valid, 'tools/call', { name: 'alz.operations.list', arguments: {} });
  results.push({ check: 'readOnlyCatalog', passed: checkMcpResponse('readOnlyCatalog', catalog), status: catalog.status, responseSha256: catalog.sha256 });
  for (const kind of ['expired', 'wrongIssuer', 'wrongAudience', 'wrongTenant', 'wrongStage', 'revoked', 'insufficientScope']) {
    const r = await request(readToken(config.tokens[kind]), 'tools/list');
    results.push({ check: kind, passed: checkMcpResponse('credentialDenied', r), status: r.status, responseSha256: r.sha256 });
  }
  const forged = valid.slice(0, valid.lastIndexOf('.') + 1) + 'A'.repeat(342);
  const rejected = await request(forged, 'tools/list');
  results.push({ check: 'forgedSignature', passed: rejected.status === 401, status: rejected.status, responseSha256: rejected.sha256 });
  const mutation = await request(valid, 'tools/call', { name: 'alz.operations.invoke', arguments: { operation: 'apply' } });
  results.push({ check: 'mutationDenied', passed: checkMcpResponse('mutationDenied', mutation),
    status: mutation.status, responseSha256: mutation.sha256 });
} finally {
  const report = { schemaVersion: 1, mode: 'LIVE_PRIVATE_MCP', sourceCommit: config.sourceCommit, image: config.image,
    targetHardwareId: config.targetHardwareId, platform: process.platform, architecture: process.arch,
    observedAt: new Date().toISOString(), results, passed: results.length === 12 && results.every(r => r.passed),
    studioHarnessCertified: false, productionReleaseApproved: false };
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  if (!report.passed) process.exitCode = 1;
}
