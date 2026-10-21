// Strict response checks shared by the operator-only live probe and offline tests.
export function checkMcpResponse(check, response) {
  if (check === 'credentialDenied') return response.status === 401 || response.status === 403;
  if (response.status !== 200) return false;
  try {
    const rpc = JSON.parse(response.body);
    if (rpc?.jsonrpc !== '2.0' || rpc.id !== 1 || rpc.error || !rpc.result) return false;
    const result = rpc.result;
    if (check === 'initialize') return result.protocolVersion === '2025-03-26' &&
      result.serverInfo?.name === 'sovereign-alz-readonly' && typeof result.capabilities?.tools === 'object';
    if (check === 'tools/list') return Array.isArray(result.tools) && result.tools.length === 2 &&
      ['alz.operations.list', 'alz.operations.invoke'].every(name => result.tools.filter(t => t?.name === name).length === 1);
    if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== 'text') return false;
    const payload = JSON.parse(result.content[0].text);
    if (check === 'readOnlyCatalog') return result.isError !== true && Array.isArray(payload) &&
      payload.length > 0 && payload.every(op => typeof op.id === 'string' && op.safety === 'READ_ONLY');
    if (check === 'mutationDenied') return result.isError === true && payload?.ok === false &&
      payload.operation === 'apply' && payload.error === 'OPERATIONS_READ_ONLY_DENIED';
  } catch { return false; }
  return false;
}
