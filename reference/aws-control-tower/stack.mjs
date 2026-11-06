import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ref = name => ({ Ref: name });
const sub = text => ({ 'Fn::Sub': text });
const attr = (name, key = 'Arn') => ({ 'Fn::GetAtt': [name, key] });
const iff = (condition, yes, no = ref('AWS::NoValue')) => ({ 'Fn::If': [condition, yes, no] });
const policy = Statement => ({ Version: '2012-10-17', Statement });
const allow = (Action, Resource, extra = {}) => ({ Effect: 'Allow', Action, Resource, ...extra });
const deny = (Action, Resource, extra = {}) => ({ Effect: 'Deny', Action, Resource, ...extra });
const serviceTrust = service => policy([allow('sts:AssumeRole', '*', { Principal: { Service: service } })].map(({ Resource, ...statement }) => statement));
const tagged = properties => ({ ...properties, Tags: [
  { Key: 'Environment', Value: 'DEV' }, { Key: 'Application', Value: ref('Name') },
  { Key: 'Owner', Value: ref('Owner') }, { Key: 'CostCenter', Value: ref('CostCenter') },
  { Key: 'ManagedBy', Value: 'alz-control-tower-reference' },
] });
const artifactObjects = sub('${ArtifactBucket.Arn}/${Name}/*');
const functionArn = sub('arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${Name}');
const modelArn = sub('arn:${AWS::Partition}:bedrock:${AWS::Region}::foundation-model/${BedrockModelId}');

/** Deterministic administrator-owned foundation; no custom resources or automatic cloud calls. */
export function createTemplate() {
  const R = {};
  const add = (name, Type, Properties, other = {}) => { R[name] = { Type, Properties, ...other }; };
  const role = (name, service, statements, other = {}) => add(name, 'AWS::IAM::Role', tagged({
    AssumeRolePolicyDocument: serviceTrust(service),
    Policies: [{ PolicyName: 'reference-scope', PolicyDocument: policy(statements) }],
  }), other);
  const logs = (name, suffix) => add(name, 'AWS::Logs::LogGroup', {
    LogGroupName: sub('/alz/${Name}/' + suffix), RetentionInDays: 30,
  }, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  const logAccess = name => allow(['logs:CreateLogStream', 'logs:PutLogEvents'], sub('${' + name + '.Arn}:*'));
  const eniAccess = allow(['ec2:CreateNetworkInterface', 'ec2:DescribeNetworkInterfaces', 'ec2:DescribeSubnets',
    'ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses', 'ec2:UnassignPrivateIpAddresses'], '*');
  // Explicit deny applies only to code running inside Lambda, not Lambda's service ENI provisioning.
  const denyCodeEni = deny(['ec2:CreateNetworkInterface', 'ec2:DeleteNetworkInterface', 'ec2:AssignPrivateIpAddresses',
    'ec2:UnassignPrivateIpAddresses'], '*', { Condition: { Null: { 'lambda:SourceFunctionArn': 'false' } } });

  add('Vpc', 'AWS::EC2::VPC', tagged({ CidrBlock: ref('VpcCidr'), EnableDnsSupport: true, EnableDnsHostnames: true }));
  add('PrivateSubnetA', 'AWS::EC2::Subnet', tagged({ VpcId: ref('Vpc'), CidrBlock: { 'Fn::Select': [0, { 'Fn::Cidr': [ref('VpcCidr'), 2, 8] }] },
    AvailabilityZone: { 'Fn::Select': [0, { 'Fn::GetAZs': '' }] }, MapPublicIpOnLaunch: false }));
  add('PrivateSubnetB', 'AWS::EC2::Subnet', tagged({ VpcId: ref('Vpc'), CidrBlock: { 'Fn::Select': [1, { 'Fn::Cidr': [ref('VpcCidr'), 2, 8] }] },
    AvailabilityZone: { 'Fn::Select': [1, { 'Fn::GetAZs': '' }] }, MapPublicIpOnLaunch: false }));
  add('PrivateRoutes', 'AWS::EC2::RouteTable', tagged({ VpcId: ref('Vpc') }));
  for (const letter of ['A', 'B']) add('RouteAssociation' + letter, 'AWS::EC2::SubnetRouteTableAssociation', {
    SubnetId: ref('PrivateSubnet' + letter), RouteTableId: ref('PrivateRoutes'),
  });
  // No IGW, NAT, public IP or internet route. Endpoint return traffic is stateful.
  const noUsefulEgress = [{ IpProtocol: '-1', CidrIp: '127.0.0.1/32', Description: 'No initiated outbound connections' }];
  add('BedrockEndpointGroup', 'AWS::EC2::SecurityGroup', tagged({ VpcId: ref('Vpc'), GroupDescription: 'Bedrock endpoint ingress only', SecurityGroupEgress: noUsefulEgress }));
  add('ApiEndpointGroup', 'AWS::EC2::SecurityGroup', tagged({ VpcId: ref('Vpc'), GroupDescription: 'Private API endpoint ingress only', SecurityGroupEgress: noUsefulEgress }));
  add('RuntimeGroup', 'AWS::EC2::SecurityGroup', tagged({ VpcId: ref('Vpc'), GroupDescription: 'Reference function to Bedrock only',
    SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, DestinationSecurityGroupId: ref('BedrockEndpointGroup') }] }));
  add('VerifierGroup', 'AWS::EC2::SecurityGroup', tagged({ VpcId: ref('Vpc'), GroupDescription: 'Verification function to private API only',
    SecurityGroupEgress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, DestinationSecurityGroupId: ref('ApiEndpointGroup') }] }));
  for (const [name, target, source] of [['BedrockIngress', 'BedrockEndpointGroup', 'RuntimeGroup'], ['ApiVerifierIngress', 'ApiEndpointGroup', 'VerifierGroup']]) {
    add(name, 'AWS::EC2::SecurityGroupIngress', { GroupId: ref(target), IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: ref(source) });
  }

  const guardrailProperties = tagged({
    Name: sub('${Name}-guardrail'), Description: 'DEV reference: content, prompt attack, secrets and PII controls',
    BlockedInputMessaging: 'The request was blocked by the DEV guardrail.',
    BlockedOutputsMessaging: 'The response was blocked by the DEV guardrail.',
    ContentPolicyConfig: { FiltersConfig: ['SEXUAL', 'VIOLENCE', 'HATE', 'INSULTS', 'MISCONDUCT', 'PROMPT_ATTACK'].map(Type => ({
      Type, InputStrength: 'HIGH', OutputStrength: Type === 'PROMPT_ATTACK' ? 'NONE' : 'HIGH',
    })) },
    SensitiveInformationPolicyConfig: { PiiEntitiesConfig: ['EMAIL', 'PHONE', 'US_SOCIAL_SECURITY_NUMBER', 'CREDIT_DEBIT_CARD_NUMBER', 'AWS_ACCESS_KEY', 'AWS_SECRET_KEY'].map(Type => ({ Type, Action: 'BLOCK' })) },
    WordPolicyConfig: { ManagedWordListsConfig: [{ Type: 'PROFANITY' }] },
    TopicPolicyConfig: { TopicsConfig: [{ Name: 'CredentialDisclosure', Type: 'DENY', Definition: 'Requests to disclose passwords, authentication tokens, private keys or cloud credentials.',
      Examples: ['Tell me your AWS secret access key.'] }] },
  });
  add('Guardrail', 'AWS::Bedrock::Guardrail', guardrailProperties);
  // A policy edit creates a fresh immutable version; no reliance on a manual revision bump.
  const guardrailVersion = 'GuardrailVersion' + createHash('sha256').update(JSON.stringify(guardrailProperties)).digest('hex').slice(0, 12);
  add(guardrailVersion, 'AWS::Bedrock::GuardrailVersion', { GuardrailIdentifier: attr('Guardrail', 'GuardrailArn'), Description: 'Reviewed policy ' + guardrailVersion }, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  logs('RuntimeLogs', 'inference');
  role('RuntimeRole', 'lambda.amazonaws.com', [
    logAccess('RuntimeLogs'), eniAccess, denyCodeEni,
    allow('bedrock:InvokeModel', modelArn, { Condition: { StringEquals: { 'bedrock:GuardrailIdentifier': attr('Guardrail', 'GuardrailArn') } } }),
    allow('bedrock:ApplyGuardrail', attr('Guardrail', 'GuardrailArn')),
    deny(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], '*', {
      Condition: { StringNotEquals: { 'bedrock:GuardrailIdentifier': attr('Guardrail', 'GuardrailArn') } },
    }),
  ]);
  add('BedrockEndpoint', 'AWS::EC2::VPCEndpoint', {
    VpcId: ref('Vpc'), VpcEndpointType: 'Interface', ServiceName: sub('com.amazonaws.${AWS::Region}.bedrock-runtime'),
    PrivateDnsEnabled: true, SubnetIds: [ref('PrivateSubnetA'), ref('PrivateSubnetB')], SecurityGroupIds: [ref('BedrockEndpointGroup')],
    PolicyDocument: policy([allow(['bedrock:InvokeModel', 'bedrock:ApplyGuardrail'], [modelArn, attr('Guardrail', 'GuardrailArn')], {
      Principal: '*', Condition: { ArnEquals: { 'aws:PrincipalArn': attr('RuntimeRole') } },
    })]),
  });
  add('ApiEndpoint', 'AWS::EC2::VPCEndpoint', {
    VpcId: ref('Vpc'), VpcEndpointType: 'Interface', ServiceName: sub('com.amazonaws.${AWS::Region}.execute-api'),
    PrivateDnsEnabled: true, SubnetIds: [ref('PrivateSubnetA'), ref('PrivateSubnetB')], SecurityGroupIds: [ref('ApiEndpointGroup')],
    PolicyDocument: policy([allow('execute-api:Invoke', sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:*'), { Principal: '*' })]),
  });
  add('Runtime', 'AWS::Lambda::Function', tagged({
    FunctionName: ref('Name'), Runtime: 'nodejs24.x', Handler: 'index.handler', Architectures: ['arm64'], MemorySize: 512,
    Timeout: 25, ReservedConcurrentExecutions: 2, Role: attr('RuntimeRole'),
    VpcConfig: { SubnetIds: [ref('PrivateSubnetA'), ref('PrivateSubnetB')], SecurityGroupIds: [ref('RuntimeGroup')] },
    LoggingConfig: { LogGroup: ref('RuntimeLogs'), LogFormat: 'JSON' },
    Environment: { Variables: { BEDROCK_MODEL_ID: ref('BedrockModelId'), BEDROCK_GUARDRAIL_ARN: attr('Guardrail', 'GuardrailArn'),
      BEDROCK_GUARDRAIL_VERSION: attr(guardrailVersion, 'Version'), LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' } },
    // Foundation never pretends the source repository has already been deployed.
    Code: { ZipFile: 'exports.handler = async () => ({statusCode:503,headers:{"content-type":"application/json"},body:JSON.stringify({error:"Approve the first reference application deployment in CodePipeline."})});' },
  }));
  add('PrivateApi', 'AWS::ApiGateway::RestApi', tagged({
    Name: sub('${Name}-private'), EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: [ref('ApiEndpoint')] },
    Policy: policy([
      allow('execute-api:Invoke', 'execute-api:/*', { Principal: '*' }),
      deny('execute-api:Invoke', 'execute-api:/*', { Principal: '*', Condition: { StringNotEquals: { 'aws:SourceVpce': ref('ApiEndpoint') } } }),
    ]),
  }));
  add('ChatResource', 'AWS::ApiGateway::Resource', { RestApiId: ref('PrivateApi'), ParentId: attr('PrivateApi', 'RootResourceId'), PathPart: 'chat' });
  add('ChatMethod', 'AWS::ApiGateway::Method', {
    RestApiId: ref('PrivateApi'), ResourceId: ref('ChatResource'), HttpMethod: 'POST', AuthorizationType: 'AWS_IAM',
    Integration: { Type: 'AWS_PROXY', IntegrationHttpMethod: 'POST', TimeoutInMillis: 26000,
      Uri: sub('arn:${AWS::Partition}:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${Runtime.Arn}/invocations') },
  });
  add('ApiInvoke', 'AWS::Lambda::Permission', { Action: 'lambda:InvokeFunction', FunctionName: ref('Runtime'), Principal: 'apigateway.amazonaws.com',
    SourceAccount: ref('AWS::AccountId'), SourceArn: sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${PrivateApi}/dev/POST/chat') });
  const deployment = 'ApiDeployment' + createHash('sha256').update(JSON.stringify(R.ChatMethod)).digest('hex').slice(0, 12);
  add(deployment, 'AWS::ApiGateway::Deployment', { RestApiId: ref('PrivateApi') }, { DependsOn: ['ChatMethod'] });
  add('ApiStage', 'AWS::ApiGateway::Stage', tagged({ RestApiId: ref('PrivateApi'), DeploymentId: ref(deployment), StageName: 'dev',
    MethodSettings: [{ ResourcePath: '/*', HttpMethod: '*', ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2, DataTraceEnabled: false, MetricsEnabled: true }] }));

  // A fixed, IAM-authenticated smoke client makes the private API testable from an operator's AWS CLI without a public ingress.
  logs('VerifierLogs', 'verification');
  role('VerifierRole', 'lambda.amazonaws.com', [logAccess('VerifierLogs'), eniAccess, denyCodeEni,
    allow('execute-api:Invoke', sub('arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${PrivateApi}/dev/POST/chat'))]);
  add('Verifier', 'AWS::Lambda::Function', tagged({
    FunctionName: sub('${Name}-verify'), Runtime: 'python3.13', Handler: 'index.handler', Role: attr('VerifierRole'), MemorySize: 128, Timeout: 70, ReservedConcurrentExecutions: 1,
    VpcConfig: { SubnetIds: [ref('PrivateSubnetA'), ref('PrivateSubnetB')], SecurityGroupIds: [ref('VerifierGroup')] },
    LoggingConfig: { LogGroup: ref('VerifierLogs'), LogFormat: 'JSON' },
    Environment: { Variables: { API_URL: sub('https://${PrivateApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/dev/chat') } },
    Code: { ZipFile: readFileSync(new URL('./verify-private-api.py', import.meta.url), 'utf8') },
  }));

  add('AlertTopic', 'AWS::SNS::Topic', tagged({ DisplayName: sub('${Name} DEV operational alerts'), Subscription: [{ Protocol: 'email', Endpoint: ref('AlertEmail') }] }));
  add('AlertTopicPolicy', 'AWS::SNS::TopicPolicy', { Topics: [ref('AlertTopic')], PolicyDocument: policy([
    allow('sns:Publish', ref('AlertTopic'), { Principal: { Service: 'cloudwatch.amazonaws.com' }, Condition: { StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') }, ArnLike: { 'aws:SourceArn': sub('arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:${Name}-*') } } }),
  ]) });
  for (const metric of ['Errors', 'Throttles']) add(metric + 'Alarm', 'AWS::CloudWatch::Alarm', {
    AlarmName: sub('${Name}-' + metric.toLowerCase()), Namespace: 'AWS/Lambda', MetricName: metric, Statistic: 'Sum', Period: 300, EvaluationPeriods: 1,
    Threshold: 1, ComparisonOperator: 'GreaterThanOrEqualToThreshold', TreatMissingData: 'notBreaching',
    Dimensions: [{ Name: 'FunctionName', Value: ref('Runtime') }], AlarmActions: [ref('AlertTopic')],
  });
  add('Budget', 'AWS::Budgets::Budget', {
    Budget: { BudgetName: sub('${Name}-account'), BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: ref('MonthlyBudgetUsd'), Unit: 'USD' } },
    NotificationsWithSubscribers: [['ACTUAL', 80], ['ACTUAL', 100], ['FORECASTED', 100]].map(([NotificationType, Threshold]) => ({
      Notification: { ComparisonOperator: 'GREATER_THAN', NotificationType, Threshold, ThresholdType: 'PERCENTAGE' },
      Subscribers: [{ SubscriptionType: 'EMAIL', Address: ref('AlertEmail') }],
    })),
    ResourceTags: [
      { Key: 'Environment', Value: 'DEV' }, { Key: 'Application', Value: ref('Name') },
      { Key: 'Owner', Value: ref('Owner') }, { Key: 'CostCenter', Value: ref('CostCenter') },
    ],
  });
  add('InferencePausePolicy', 'AWS::IAM::ManagedPolicy', { Description: 'DEV budget action: deny inference only; does not stop existing infrastructure charges',
    PolicyDocument: policy([deny(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], '*')]) }, { Condition: 'PauseOnBudget' });
  role('BudgetActionRole', 'budgets.amazonaws.com', [allow(['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], attr('RuntimeRole'), {
    Condition: { ArnEquals: { 'iam:PolicyARN': ref('InferencePausePolicy') } },
  })], { Condition: 'PauseOnBudget' });
  R.BudgetActionRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition = { StringEquals: { 'aws:SourceAccount': ref('AWS::AccountId') } };
  add('BudgetAction', 'AWS::Budgets::BudgetsAction', {
    BudgetName: ref('Budget'), ActionType: 'APPLY_IAM_POLICY', ApprovalModel: 'AUTOMATIC', NotificationType: 'ACTUAL',
    ActionThreshold: { Type: 'PERCENTAGE', Value: 100 }, ExecutionRoleArn: attr('BudgetActionRole'),
    Definition: { IamActionDefinition: { PolicyArn: ref('InferencePausePolicy'), Roles: [ref('RuntimeRole')] } },
    Subscribers: [{ Type: 'EMAIL', Address: ref('AlertEmail') }],
  }, { Condition: 'PauseOnBudget' });

  add('ArtifactKey', 'AWS::KMS::Key', { Description: 'DEV pipeline artifacts', EnableKeyRotation: true,
    KeyPolicy: policy([allow('kms:*', '*', { Principal: { AWS: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:root') } })]),
  }, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  add('ArtifactBucket', 'AWS::S3::Bucket', tagged({
    VersioningConfiguration: { Status: 'Enabled' }, OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ BucketKeyEnabled: true, ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: attr('ArtifactKey') } }] },
    LifecycleConfiguration: { Rules: [{ Id: 'retention', Status: 'Enabled', ExpirationInDays: 30, NoncurrentVersionExpiration: { NoncurrentDays: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }] },
  }), { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  add('ArtifactBucketPolicy', 'AWS::S3::BucketPolicy', { Bucket: ref('ArtifactBucket'), PolicyDocument: policy([
    deny('s3:*', [attr('ArtifactBucket'), sub('${ArtifactBucket.Arn}/*')], { Principal: '*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
  ]) }, { DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
  const artifactRead = [allow(['s3:GetBucketVersioning', 's3:GetBucketLocation'], attr('ArtifactBucket')),
    allow(['s3:GetObject', 's3:GetObjectVersion'], artifactObjects), allow('kms:Decrypt', attr('ArtifactKey'))];
  const artifactWrite = [allow('s3:PutObject', artifactObjects), allow(['kms:Encrypt', 'kms:GenerateDataKey'], attr('ArtifactKey'))];
  logs('BuildLogs', 'build'); logs('DeployLogs', 'deploy');
  role('BuildRole', 'codebuild.amazonaws.com', [...artifactRead, ...artifactWrite, logAccess('BuildLogs')]);
  role('DeployRole', 'codebuild.amazonaws.com', [...artifactRead, logAccess('DeployLogs'),
    allow(['lambda:UpdateFunctionCode', 'lambda:GetFunctionConfiguration'], functionArn)]);
  const project = (name, suffix, roleName, logName, BuildSpec) => add(name, 'AWS::CodeBuild::Project', tagged({
    Name: sub('${Name}-' + suffix), ServiceRole: attr(roleName), TimeoutInMinutes: 10, QueuedTimeoutInMinutes: 10,
    ConcurrentBuildLimit: 1, EncryptionKey: attr('ArtifactKey'), Source: { Type: 'CODEPIPELINE', BuildSpec: JSON.stringify(BuildSpec) },
    Artifacts: { Type: 'CODEPIPELINE' },
    Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'aws/codebuild/standard:8.0', PrivilegedMode: false,
      EnvironmentVariables: [{ Name: 'FUNCTION_NAME', Value: ref('Name'), Type: 'PLAINTEXT' }] },
    LogsConfig: { CloudWatchLogs: { Status: 'ENABLED', GroupName: ref(logName) } },
  }));
  project('BuildProject', 'build', 'BuildRole', 'BuildLogs', {
    version: '0.2', phases: {
      install: { 'runtime-versions': { nodejs: 24 }, commands: ['cd reference/aws-control-tower/function && npm ci --omit=dev --ignore-scripts --no-audit --no-fund'] },
      build: { commands: ['cd reference/aws-control-tower/function && npm test && zip -qr function.zip index.mjs package.json package-lock.json node_modules && sha256sum function.zip > function.zip.sha256 && cat function.zip.sha256'] },
    }, artifacts: { 'base-directory': 'reference/aws-control-tower/function', files: ['function.zip', 'function.zip.sha256'] },
  });
  // No repository-controlled buildspec or script is executed with the deployment role.
  project('DeployProject', 'deploy', 'DeployRole', 'DeployLogs', {
    version: '0.2', phases: { build: { commands: [
      'sha256sum --check function.zip.sha256',
      'REVISION=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --query RevisionId --output text)',
      'aws lambda update-function-code --function-name "$FUNCTION_NAME" --revision-id "$REVISION" --zip-file fileb://function.zip --publish --query Version --output text',
      'aws lambda wait function-updated-v2 --function-name "$FUNCTION_NAME"',
    ] } },
  });
  role('PipelineRole', 'codepipeline.amazonaws.com', [...artifactRead, ...artifactWrite,
    allow(['codebuild:StartBuild', 'codebuild:BatchGetBuilds'], [attr('BuildProject'), attr('DeployProject')]),
    iff('ConnectionSource', allow(['codeconnections:UseConnection', 'codestar-connections:UseConnection'], ref('ConnectionArn')),
      allow(['codecommit:GetBranch', 'codecommit:GetCommit', 'codecommit:GetRepository', 'codecommit:UploadArchive', 'codecommit:GetUploadArchiveStatus', 'codecommit:CancelUploadArchive'], sub('arn:${AWS::Partition}:codecommit:${AWS::Region}:${AWS::AccountId}:${Repository}'))),
  ]);
  const action = (Name, Category, Provider, rest) => ({ Name, ActionTypeId: { Category, Owner: 'AWS', Provider, Version: '1' }, RunOrder: 1, ...rest });
  add('Pipeline', 'AWS::CodePipeline::Pipeline', tagged({
    Name: ref('Name'), RoleArn: attr('PipelineRole'), PipelineType: 'V2', ExecutionMode: 'QUEUED', RestartExecutionOnUpdate: false,
    ArtifactStore: { Type: 'S3', Location: ref('ArtifactBucket'), EncryptionKey: { Type: 'KMS', Id: attr('ArtifactKey') } },
    Stages: [
      { Name: 'Source', Actions: [iff('ConnectionSource',
        action('Repository', 'Source', 'CodeStarSourceConnection', { Configuration: { ConnectionArn: ref('ConnectionArn'), FullRepositoryId: ref('Repository'), BranchName: ref('Branch'), DetectChanges: 'true', OutputArtifactFormat: 'CODE_ZIP' }, OutputArtifacts: [{ Name: 'Source' }] }),
        action('Repository', 'Source', 'CodeCommit', { Configuration: { RepositoryName: ref('Repository'), BranchName: ref('Branch'), PollForSourceChanges: 'false' }, OutputArtifacts: [{ Name: 'Source' }] }))] },
      { Name: 'Build', Actions: [action('TestAndPackage', 'Build', 'CodeBuild', { Configuration: { ProjectName: ref('BuildProject') }, InputArtifacts: [{ Name: 'Source' }], OutputArtifacts: [{ Name: 'Package' }] })] },
      { Name: 'Review', Actions: [action('ApproveDevRelease', 'Approval', 'Manual', { Configuration: { CustomData: 'Review source revision, test result and function.zip SHA-256. This deploy updates the DEV function code only.' }, TimeoutInMinutes: 1440 })] },
      { Name: 'Deploy', Actions: [action('UpdateDevFunction', 'Build', 'CodeBuild', { Configuration: { ProjectName: ref('DeployProject') }, InputArtifacts: [{ Name: 'Package' }] })] },
    ],
  }), { DependsOn: ['ArtifactBucketPolicy', 'Runtime'] });
  role('SourceEventRole', 'events.amazonaws.com', [allow('codepipeline:StartPipelineExecution', sub('arn:${AWS::Partition}:codepipeline:${AWS::Region}:${AWS::AccountId}:${Name}'))], { Condition: 'CodeCommitSource' });
  add('SourceEvent', 'AWS::Events::Rule', {
    EventPattern: { source: ['aws.codecommit'], 'detail-type': ['CodeCommit Repository State Change'], resources: [sub('arn:${AWS::Partition}:codecommit:${AWS::Region}:${AWS::AccountId}:${Repository}')],
      detail: { event: ['referenceCreated', 'referenceUpdated'], referenceType: ['branch'], referenceName: [ref('Branch')] } },
    State: 'ENABLED', Targets: [{ Id: 'Pipeline', Arn: sub('arn:${AWS::Partition}:codepipeline:${AWS::Region}:${AWS::AccountId}:${Name}'), RoleArn: attr('SourceEventRole') }],
  }, { Condition: 'CodeCommitSource' });

  return {
    AWSTemplateFormatVersion: '2010-09-09', Description: 'DEV Control Tower reference workload: private LangChain/Bedrock, FinOps and approved repository delivery. Existing organization and controls are retained.',
    Metadata: { 'alz:evidence': 'REFERENCE_TEMPLATE_NOT_LIVE_QUALIFIED', 'alz:control-tower': 'Run preflight.py against the existing governed member account before creating a change set.' },
    Parameters: {
      Name: { Type: 'String', Default: 'alz-reference-dev', AllowedPattern: '^[a-z][a-z0-9-]{2,24}$' },
      ExpectedAccountId: { Type: 'String', AllowedPattern: '^[0-9]{12}$', Description: 'Dedicated Control Tower DEV member account verified by preflight.' },
      Environment: { Type: 'String', Default: 'DEV', AllowedValues: ['DEV'] },
      Owner: { Type: 'String', MinLength: 1, MaxLength: 80 }, CostCenter: { Type: 'String', MinLength: 1, MaxLength: 80 },
      AlertEmail: { Type: 'String', AllowedPattern: '^[^ @]+@[^ @]+\\.[^ @]+$' },
      MonthlyBudgetUsd: { Type: 'Number', Default: 100, MinValue: 1, MaxValue: 10000 },
      PauseInferenceOnBudget: { Type: 'String', Default: 'true', AllowedValues: ['true', 'false'], Description: 'At 100% actual account budget, attach an inference-deny policy to this workload only. Billing is delayed; this is not a hard spend cap.' },
      VpcCidr: { Type: 'String', Default: '10.42.0.0/16', AllowedPattern: '^10\\.[0-9]{1,3}\\.0\\.0/16$', Description: 'Unused private /16; creates a separate VPC, never replaces Control Tower networks.' },
      BedrockModelId: { Type: 'String', Default: 'amazon.nova-micro-v1:0', AllowedPattern: '^[a-z0-9][a-z0-9.:-]{1,100}$', Description: 'Region-local foundation model with on-demand Converse support. Verify account availability; inference profiles are not admitted.' },
      SourceProvider: { Type: 'String', Default: 'GitHub', AllowedValues: ['GitHub', 'GitLab', 'CodeCommit'] },
      ConnectionArn: { Type: 'String', Default: '', AllowedPattern: '^$|^arn:aws:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[a-z0-9-]+$', Description: 'GitHub/GitLab: existing AVAILABLE connection in this account and region; complete provider consent in AWS first.' },
      Repository: { Type: 'String', Default: 'realjkg/agent-private-landing-zone', AllowedPattern: '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$', Description: 'GitHub/GitLab full repository path, or existing CodeCommit repository name.' },
      Branch: { Type: 'String', Default: 'main', AllowedPattern: '^[A-Za-z0-9_./-]+$' },
    },
    Rules: {
      CorrectAccount: { Assertions: [{ Assert: { 'Fn::Equals': [ref('ExpectedAccountId'), ref('AWS::AccountId')] }, AssertDescription: 'Use the dedicated DEV account verified by preflight.' }] },
      ConnectionRequired: { RuleCondition: { 'Fn::Not': [{ 'Fn::Equals': [ref('SourceProvider'), 'CodeCommit'] }] }, Assertions: [{ Assert: { 'Fn::Not': [{ 'Fn::Equals': [ref('ConnectionArn'), ''] }] }, AssertDescription: 'GitHub and GitLab need an AVAILABLE CodeConnections connection.' }] },
    },
    Conditions: { ConnectionSource: { 'Fn::Not': [{ 'Fn::Equals': [ref('SourceProvider'), 'CodeCommit'] }] }, CodeCommitSource: { 'Fn::Equals': [ref('SourceProvider'), 'CodeCommit'] }, PauseOnBudget: { 'Fn::Equals': [ref('PauseInferenceOnBudget'), 'true'] } },
    Resources: R,
    Outputs: {
      PrivateApiUrl: { Value: sub('https://${PrivateApi}.execute-api.${AWS::Region}.${AWS::URLSuffix}/dev/chat') },
      VerificationFunction: { Value: ref('Verifier'), Description: 'Invoke with {} after approving the first pipeline run; it tests authorized, denied and guardrail-blocked requests.' },
      FunctionName: { Value: ref('Runtime') }, PipelineName: { Value: ref('Pipeline') }, ArtifactBucketName: { Value: ref('ArtifactBucket') },
      GuardrailArn: { Value: attr('Guardrail', 'GuardrailArn') }, GuardrailVersion: { Value: attr(guardrailVersion, 'Version') },
      RuntimeRoleArn: { Value: attr('RuntimeRole') }, BudgetName: { Value: ref('Budget') }, VpcId: { Value: ref('Vpc') },
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = JSON.stringify(createTemplate()) + '\n';
  if (Buffer.byteLength(text) > 51200) throw new Error('Template exceeds direct CloudFormation upload limit.');
  writeFileSync(new URL('./template.json', import.meta.url), text);
  console.log('Generated reference template; no AWS calls.');
}
