import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMcpResponse } from '../scripts/container-mcp-checks.mjs';
const response = (result: unknown) => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) });
const content = (value: unknown, isError = false) => ({ isError, content: [{ type: 'text', text: JSON.stringify(value) }] });
test('live probe accepts exact protocol discovery and strictly read-only catalog evidence', () => {
  assert.equal(checkMcpResponse('initialize', response({ protocolVersion: '2025-03-26', serverInfo: { name: 'sovereign-alz-readonly' }, capabilities: { tools: {} } })), true);
  assert.equal(checkMcpResponse('tools/list', response({ tools: [{ name: 'alz.operations.list' }, { name: 'alz.operations.invoke' }] })), true);
  assert.equal(checkMcpResponse('readOnlyCatalog', response(content([{ id: 'health', safety: 'READ_ONLY' }]))), true);
  assert.equal(checkMcpResponse('readOnlyCatalog', response(content([{ id: 'apply', safety: 'HANDOFF' }]))), false);
  assert.equal(checkMcpResponse('readOnlyCatalog', response(content([]))), false);
  assert.equal(checkMcpResponse('tools/list', response({ tools: [{ name: 'apply' }] })), false);
  assert.equal(checkMcpResponse('initialize', response({})), false);
});
test('live probe cannot count an error string, wrong request, success or HTTP failure as mutation denial', () => {
  const denied = { ok: false, operation: 'apply', error: 'OPERATIONS_READ_ONLY_DENIED' };
  assert.equal(checkMcpResponse('mutationDenied', response(content(denied, true))), true);
  for (const r of [response(content(denied)), response(content({ ...denied, ok: true }, true)),
    response(content({ ...denied, operation: 'health' }, true)), { status: 500, body: 'OPERATIONS_READ_ONLY_DENIED' },
    { status: 200, body: 'OPERATIONS_READ_ONLY_DENIED' },
    { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 99, result: content(denied, true) }) }])
    assert.equal(checkMcpResponse('mutationDenied', r), false);
});
test('live credential negatives require authentication denial, not transport or generic RPC errors', () => {
  assert.equal(checkMcpResponse('credentialDenied', { status: 401, body: '' }), true);
  assert.equal(checkMcpResponse('credentialDenied', { status: 403, body: '' }), true);
  for (const status of [200, 302, 404, 500]) assert.equal(checkMcpResponse('credentialDenied', { status, body: '' }), false);
});
