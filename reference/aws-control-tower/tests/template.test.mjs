import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Validator } from '@cfworker/json-schema';
import { createTemplate } from '../stack.mjs';

const template = createTemplate();
const manifest = JSON.parse(readFileSync(new URL('./schemas/manifest.json', import.meta.url)));
const account = '111111111111', region = 'us-east-1';
const NO_VALUE = Symbol('no value');

function resolveTemplate(provider, pause = 'true') {
  const params = Object.fromEntries(Object.entries(template.Parameters).map(([k, v]) => [k, v.Default]));
  Object.assign(params, { ExpectedAccountId: account, Owner: 'platform-team', CostCenter: 'engineering', AlertEmail: 'owner@example.com',
    SourceProvider: provider, Repository: provider === 'CodeCommit' ? 'dev-code' : 'owner/dev-code', PauseInferenceOnBudget: pause,
    ConnectionArn: provider === 'CodeCommit' ? '' : `arn:aws:codeconnections:${region}:${account}:connection/12345678-1234-1234-1234-123456789012`,
    'AWS::Region': region, 'AWS::AccountId': account, 'AWS::Partition': 'aws', 'AWS::URLSuffix': 'amazonaws.com', 'AWS::NoValue': NO_VALUE });
  const refs = { Vpc: 'vpc-0123456789abcdef0', PrivateSubnetA: 'subnet-0123456789abcdef0', PrivateSubnetB: 'subnet-1123456789abcdef0',
    RuntimeGroup: 'sg-0123456789abcdef0', VerifierGroup: 'sg-1123456789abcdef0', ApiEndpointGroup: 'sg-2123456789abcdef0', BedrockEndpointGroup: 'sg-3123456789abcdef0',
    ApiEndpoint: 'vpce-0123456789abcdef0', BedrockEndpoint: 'vpce-1123456789abcdef0', PrivateApi: 'abcdefghij', ChatResource: 'abcdef', PrivateRoutes: 'rtb-0123456789abcdef0',
    ArtifactBucket: 'alz-reference-dev-artifacts', ArtifactKey: '12345678-1234-1234-1234-123456789012', InferencePausePolicy: `arn:aws:iam::${account}:policy/inference-pause`,
    AlertTopic: `arn:aws:sns:${region}:${account}:alerts`, Guardrail: 'abc123', Budget: 'alz-reference-dev-account',
  };
  function attribute(id, name) {
    assert.ok(template.Resources[id], 'unknown GetAtt resource ' + id);
    const schema = JSON.parse(readFileSync(new URL('./schemas/' + manifest.schemas[template.Resources[id].Type].file, import.meta.url)));
    assert.ok(schema.properties[name], `unknown attribute ${id}.${name}`);
    if (name === 'Version') return '1';
    if (name === 'RootResourceId') return 'abc123';
    if (name === 'GuardrailArn') return `arn:aws:bedrock:${region}:${account}:guardrail/abc123`;
    if (name === 'Arn') {
      const type = template.Resources[id].Type;
      if (type === 'AWS::S3::Bucket') return 'arn:aws:s3:::' + refs[id];
      if (type === 'AWS::KMS::Key') return `arn:aws:kms:${region}:${account}:key/${refs[id]}`;
      if (type === 'AWS::IAM::Role') return `arn:aws:iam::${account}:role/${id}`;
      if (type === 'AWS::Lambda::Function') return `arn:aws:lambda:${region}:${account}:function:${id}`;
      if (type === 'AWS::Logs::LogGroup') return `arn:aws:logs:${region}:${account}:log-group:/alz/${id}:*`;
      if (type === 'AWS::CodeBuild::Project') return `arn:aws:codebuild:${region}:${account}:project/${id}`;
    }
    throw Error('No synthetic attribute value for ' + id + '.' + name);
  }
  function readRef(name) {
    if (Object.hasOwn(params, name)) return params[name];
    if (Object.hasOwn(refs, name)) return refs[name];
    const resource = template.Resources[name];
    assert.ok(resource, 'unknown Ref ' + name);
    return resource.Properties.Name ? resolve(resource.Properties.Name) : name;
  }
  function resolve(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(resolve).filter(x => x !== NO_VALUE);
    if (value.Ref) return readRef(value.Ref);
    if (value['Fn::GetAtt']) return attribute(...value['Fn::GetAtt']);
    if (value['Fn::Equals']) return resolve(value['Fn::Equals'][0]) === resolve(value['Fn::Equals'][1]);
    if (value['Fn::Not']) return !resolve(value['Fn::Not'][0]);
    if (value['Fn::If']) { const [condition, yes, no] = value['Fn::If']; return resolve(resolve(template.Conditions[condition]) ? yes : no); }
    if (value['Fn::GetAZs'] !== undefined) return ['us-east-1a', 'us-east-1b'];
    if (value['Fn::Cidr']) return ['10.42.0.0/24', '10.42.1.0/24'];
    if (value['Fn::Select']) return resolve(value['Fn::Select'][1])[value['Fn::Select'][0]];
    if (value['Fn::Sub']) return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (_, key) => key.includes('.') ? attribute(...key.split('.')) : readRef(key));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)]).filter(([, item]) => item !== NO_VALUE));
  }
  for (const [name, definition] of Object.entries(template.Parameters)) {
    if (definition.AllowedPattern) assert.match(String(params[name]), new RegExp(definition.AllowedPattern), name);
  }
  const resources = {};
  for (const [name, resource] of Object.entries(template.Resources)) {
    if (resource.Condition && !resolve(template.Conditions[resource.Condition])) continue;
    resources[name] = { ...resource, Properties: resolve(resource.Properties) };
  }
  return { resources, resolve, params };
}

test('the committed template is reproducible and fits direct CloudFormation upload', () => {
  const generated = JSON.stringify(template) + '\n';
  assert.equal(readFileSync(new URL('../template.json', import.meta.url), 'utf8'), generated);
  assert.ok(Buffer.byteLength(generated) < 51200);
});

for (const provider of ['GitHub', 'GitLab', 'CodeCommit']) for (const pause of ['true', 'false']) {
  test(`${provider}, budget pause ${pause}: resolved properties match official AWS resource schemas`, () => {
    const { resources } = resolveTemplate(provider, pause);
    for (const [name, resource] of Object.entries(resources)) {
      const entry = manifest.schemas[resource.Type];
      const data = readFileSync(new URL('./schemas/' + entry.file, import.meta.url));
      assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, 'schema integrity');
      // AWS includes Python's absolute-end anchor in a few schema patterns. Translate
      // it to an equivalent JS assertion without relaxing trailing-newline rejection.
      const schema = JSON.parse(data, (key, value) => key === 'pattern'
        ? value.replaceAll('\\Z', '(?![\\s\\S])').replaceAll('\\ ', ' ').replace('(?i).*<script>.*</script>.*',
          '.*<[sS][cC][rR][iI][pP][tT]>.*</[sS][cC][rR][iI][pP][tT]>.*') : value);
      const result = new Validator(schema, '7', false).validate(resource.Properties);
      assert.equal(result.valid, true, name + ': ' + JSON.stringify(result.errors));
    }
  });
}

test('no resource dependency cycle, unknown reference or missing explicit dependency', () => {
  const resources = template.Resources;
  const graph = new Map();
  for (const [name, resource] of Object.entries(resources)) {
    const deps = new Set(resource.DependsOn ?? []);
    JSON.stringify(resource, (key, value) => {
      if (key === 'Ref' && resources[value]) deps.add(value);
      if (key === 'Fn::GetAtt') deps.add(value[0]);
      if (key === 'Fn::Sub') for (const match of value.matchAll(/\$\{([^}.]+)(?:\.[^}]+)?\}/g)) if (resources[match[1]]) deps.add(match[1]);
      return value;
    });
    graph.set(name, deps);
  }
  const visited = new Set(), active = new Set();
  function visit(name) {
    assert.ok(resources[name], 'missing dependency ' + name);
    assert.ok(!active.has(name), 'resource cycle at ' + name);
    if (visited.has(name)) return;
    active.add(name); for (const dep of graph.get(name)) visit(dep); active.delete(name); visited.add(name);
  }
  for (const name of graph.keys()) visit(name);
});

test('private endpoints, IAM auth and runtime policy require the designated Bedrock guardrail', () => {
  const { resources: r } = resolveTemplate('GitHub');
  assert.deepEqual(r.PrivateApi.Properties.EndpointConfiguration.Types, ['PRIVATE']);
  assert.equal(r.ChatMethod.Properties.AuthorizationType, 'AWS_IAM');
  assert.equal(Object.values(r).some(x => ['AWS::EC2::NatGateway', 'AWS::EC2::InternetGateway', 'AWS::Lambda::Url'].includes(x.Type)), false);
  const policies = r.RuntimeRole.Properties.Policies[0].PolicyDocument.Statement;
  const required = policies.find(x => x.Effect === 'Deny' && x.Condition?.StringNotEquals?.['bedrock:GuardrailIdentifier']);
  assert.ok(required);
  assert.ok(required.Action.includes('bedrock:InvokeModelWithResponseStream'));
  const invoke = policies.find(x => x.Effect === 'Allow' && x.Action === 'bedrock:InvokeModel');
  assert.equal(invoke.Condition.StringEquals['bedrock:GuardrailIdentifier'], required.Condition.StringNotEquals['bedrock:GuardrailIdentifier']);
  assert.equal(r.Runtime.Properties.ReservedConcurrentExecutions, 2);
  assert.match(policies.find(x => x.Action?.includes?.('logs:PutLogEvents')).Resource, /:log-group:.*:\*$/);
});

test('all sources use build then human approval then code-only deployment with separate roles', () => {
  for (const source of ['GitHub', 'GitLab', 'CodeCommit']) {
    const { resources: r } = resolveTemplate(source);
    assert.deepEqual(r.Pipeline.Properties.Stages.map(s => s.Name), ['Source', 'Build', 'Review', 'Deploy']);
    assert.equal(r.Pipeline.Properties.Stages[2].Actions[0].ActionTypeId.Category, 'Approval');
    assert.equal(r.Pipeline.Properties.ExecutionMode, 'QUEUED');
    const buildPolicy = JSON.stringify(r.BuildRole.Properties.Policies);
    assert.doesNotMatch(buildPolicy, /lambda:|iam:|cloudformation:|bedrock:/);
    const deploy = r.DeployRole.Properties.Policies[0].PolicyDocument.Statement;
    const mutate = deploy.find(s => s.Action?.includes?.('lambda:UpdateFunctionCode'));
    assert.match(mutate.Resource, /:function:alz-reference-dev$/);
    assert.doesNotMatch(JSON.stringify(deploy), /UpdateFunctionConfiguration|PassRole|iam:\*|cloudformation:/);
    const buildspec = r.DeployProject.Properties.Source.BuildSpec;
    assert.match(buildspec, /sha256sum --check/);
    assert.match(buildspec, /--revision-id/);
    assert.doesNotMatch(buildspec, /npm|buildspec.yml|bash .*sh|sh .*sh/);
    assert.equal(r.Pipeline.Properties.Stages[0].Actions[0].ActionTypeId.Provider, source === 'CodeCommit' ? 'CodeCommit' : 'CodeStarSourceConnection');
    assert.equal(Boolean(r.SourceEvent), source === 'CodeCommit');
  }
});

test('budget enforcement attaches only an inference-deny policy to the runtime role', () => {
  const { resources: r } = resolveTemplate('GitHub');
  const policy = r.BudgetActionRole.Properties.Policies[0].PolicyDocument.Statement[0];
  assert.match(policy.Resource, /:role\/RuntimeRole$/);
  assert.equal(policy.Condition.ArnEquals['iam:PolicyARN'], r.BudgetAction.Properties.Definition.IamActionDefinition.PolicyArn);
  assert.equal(r.BudgetAction.Properties.ApprovalModel, 'AUTOMATIC');
  assert.ok(r.Budget.Properties.ResourceTags.some(tag => tag.Key === 'CostCenter'));
  assert.deepEqual(r.InferencePausePolicy.Properties.PolicyDocument.Statement[0].Action, ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
  assert.equal(resolveTemplate('GitHub', 'false').resources.BudgetAction, undefined);
  assert.equal(r.ArtifactBucket.DeletionPolicy, 'Retain');
  assert.equal(r.ArtifactBucketPolicy.DeletionPolicy, 'Retain');
});
