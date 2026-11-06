import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler } from '../function/index.mjs';
const env = {
  BEDROCK_MODEL_ID: 'amazon.nova-micro-v1:0',
  BEDROCK_GUARDRAIL_ARN: 'arn:aws:bedrock:us-east-1:111111111111:guardrail/abc123',
  BEDROCK_GUARDRAIL_VERSION: '1',
};
const event = prompt => ({ httpMethod: 'POST', body: JSON.stringify({ prompt }) });

test('LangChain sends only the configured model, published guardrail and bounded token request', async () => {
  const requests = [], logs = [];
  const run = createHandler({ env, log: value => logs.push(value), send: async request => {
    requests.push(request); return { stopReason: 'end_turn', output: { message: { content: [{ text: 'Use cost allocation tags.' }] } } };
  } });
  const result = await run(event('Explain allocation.'), { awsRequestId: 'test-id' });
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body).answer, 'Use cost allocation tags.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].modelId, env.BEDROCK_MODEL_ID);
  assert.deepEqual(requests[0].guardrailConfig, { guardrailIdentifier: env.BEDROCK_GUARDRAIL_ARN, guardrailVersion: '1', trace: 'disabled' });
  assert.deepEqual(requests[0].inferenceConfig, { maxTokens: 256, temperature: 0 });
  assert.equal(logs.join().includes('allocation'), false);
});

test('guardrail intervention never returns blocked model output', async () => {
  const run = createHandler({ env, log: () => {}, send: async () => ({ stopReason: 'guardrail_intervened', output: { message: { content: [{ text: 'private content' }] } } }) });
  const result = await run(event('Test'));
  assert.equal(result.statusCode, 422);
  assert.equal(result.body.includes('private content'), false);
});

test('missing or draft guardrails refuse before invoking a model', async () => {
  for (const overrides of [{ BEDROCK_GUARDRAIL_VERSION: 'DRAFT' }, { BEDROCK_GUARDRAIL_ARN: '' }, { BEDROCK_MODEL_ID: '' }]) {
    const run = createHandler({ env: { ...env, ...overrides }, send: () => assert.fail('must not invoke') });
    assert.equal((await run(event('Test'))).statusCode, 503);
  }
});

test('invalid, oversized, encoded or model-override requests never reach Bedrock', async () => {
  const run = createHandler({ env, send: () => assert.fail('must not invoke') });
  const invalid = [event(''), event('x'.repeat(2049)), { httpMethod: 'POST', body: '{}' },
    { httpMethod: 'POST', body: '{' }, { httpMethod: 'POST', body: 'x'.repeat(12001) },
    { ...event('x'), isBase64Encoded: true }, { httpMethod: 'POST', body: JSON.stringify({ prompt: 'x', modelId: 'other' }) }];
  for (const input of invalid) assert.equal((await run(input)).statusCode, 400);
  assert.equal((await run({ ...event('x'), httpMethod: 'GET' })).statusCode, 405);
});

test('access denial, budget pause and timeouts fail closed without error or prompt disclosure', async () => {
  const logs = [];
  const run = createHandler({ env, log: value => logs.push(value), send: async () => { throw new Error('secret-provider-message'); } });
  for (let i = 0; i < 2; i++) {
    const result = await run(event('private-user-message'));
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.includes('secret-provider-message'), false);
  }
  assert.equal(logs.join().includes('private-user-message'), false);
  assert.equal(logs.join().includes('secret-provider-message'), false);
});
