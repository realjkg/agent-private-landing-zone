/**
 * The reviewed AWS leaf allowlist (delegated owner decision 6433391052, item 1; the design review that followed five review rounds
 * of PR #264). A pilot cleanup on AWS proposes a resource for deletion only when its type is listed here, by exact name: a leaf is a
 * type whose deletion removes that one object (and, for a setting, the setting on its parent) and deploys no CloudFormation stack,
 * provisioned product, project, environment or nested deployment that the engine's state does not describe. Every other
 * well-formed type a run created is excluded and listed (TYPE_UNREVIEWED, kept by the environment's owner, its type named): it is
 * never deleted, directly or as a dependent, the run's listed resources are still cleaned up, and the leftover check cannot report
 * COMPLETE while one remains. The identity prefix rule and the stack-container table (./aws-containers.ts) are checked first and
 * stay as defense in depth; the blueprint's fail-closed attribute scan (./blueprint.ts) is unchanged.
 *
 * This table is the closed default, not a deny list: a type missing here is held for a person, never deleted, so the list can be
 * short and grows only by review, one entry at a time, each with its reason and its basis. Matching is exact and case-exact
 * (Terraform types are lowercase; CloudFormation types are case-exact); there are no prefixes here, because a prefix would admit a
 * future type nobody reviewed. The table lives in the observe layer, below src/apply, beside the container table.
 *
 * Not seeded, on purpose: the EKS access entries and policy associations and the Verified Permissions types (round 3, N4; still the
 * owner's decision), `terraform_data` and `null_resource` (a destroy-time provisioner can do anything; round 3, N2, still the
 * owner's), and every type of the identity services (always PROTECTED_IDENTITY).
 */
export type AwsLeafBasis =
  /** The pilot's own journeys create it: the bootstrap project, the pilot fixtures and the synthetic journeys' stacks. */
  | "PILOT_JOURNEY"
  /** The owner declared it deletable when this run created it (decision 6431744115, item 3). */
  | "OWNER_DECISION"
  /** A common leaf, justified one by one in its reason. */
  | "COMMON_LEAF";

export type AwsLeafEntry = {
  /** What the object is. */
  what: string;
  /** Why deleting it removes that object alone: it deploys no stack, product, project, environment or nested deployment. */
  reason: string;
  basis: AwsLeafBasis;
  /** Exact type names: Terraform `aws_`, the Cloud Control provider's `awscc_`, and the CloudFormation type of the same object, where each exists. */
  types: readonly string[];
};

export const AWS_LEAF_TYPES: readonly AwsLeafEntry[] = [
  // The pilot's own journeys.
  {
    what: "an S3 bucket",
    reason: "a storage bucket holds objects only; deleting it deploys or deletes no other resource (CloudFormation refuses a non-empty bucket)",
    basis: "PILOT_JOURNEY",
    types: ["aws_s3_bucket", "awscc_s3_bucket", "AWS::S3::Bucket"],
  },
  {
    what: "a setting of an S3 bucket (versioning, encryption, public access block, ownership controls, lifecycle)",
    reason: "a configuration on its bucket; deleting it resets that one setting",
    basis: "PILOT_JOURNEY",
    types: ["aws_s3_bucket_versioning", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_public_access_block", "aws_s3_bucket_ownership_controls", "aws_s3_bucket_lifecycle_configuration"],
  },
  {
    what: "a CloudWatch Logs log group",
    reason: "holds log events only; deleting it removes them and nothing else",
    basis: "PILOT_JOURNEY",
    types: ["aws_cloudwatch_log_group", "awscc_logs_log_group", "AWS::Logs::LogGroup"],
  },
  {
    what: "an SQS queue",
    reason: "holds messages only; deleting it removes the queue and nothing else",
    basis: "PILOT_JOURNEY",
    types: ["aws_sqs_queue", "awscc_sqs_queue", "AWS::SQS::Queue"],
  },
  {
    what: "an SNS topic",
    reason: "a topic and its subscriptions; deleting it deploys or deletes no other resource",
    basis: "PILOT_JOURNEY",
    types: ["aws_sns_topic", "awscc_sns_topic", "AWS::SNS::Topic"],
  },
  {
    what: "an SSM parameter",
    reason: "one stored value; deleting it removes that value only",
    basis: "PILOT_JOURNEY",
    types: ["aws_ssm_parameter", "awscc_ssm_parameter", "AWS::SSM::Parameter"],
  },
  {
    what: "a DynamoDB table",
    reason: "holds items only; deleting it removes the table and its data (a material risk the proposal names), nothing else",
    basis: "PILOT_JOURNEY",
    types: ["aws_dynamodb_table", "awscc_dynamodb_table", "AWS::DynamoDB::Table"],
  },
  {
    what: "a KMS key",
    reason: "deleting it schedules that key's deletion (a material risk the proposal names); it deploys nothing",
    basis: "PILOT_JOURNEY",
    types: ["aws_kms_key", "awscc_kms_key", "AWS::KMS::Key"],
  },
  {
    what: "a Lambda function",
    reason: "one function and its versions; its execution role is an IAM object outside this entry, kept by the identity rule",
    basis: "PILOT_JOURNEY",
    types: ["aws_lambda_function", "awscc_lambda_function", "AWS::Lambda::Function"],
  },
  {
    what: "a CloudWatch metric alarm",
    reason: "one alarm definition; deleting it removes the alarm and nothing else",
    basis: "PILOT_JOURNEY",
    types: ["aws_cloudwatch_metric_alarm", "awscc_cloudwatch_alarm", "AWS::CloudWatch::Alarm"],
  },
  {
    what: "an AWS Budgets budget",
    reason: "one budget definition and its notifications; deleting it removes no resource it watches",
    basis: "PILOT_JOURNEY",
    types: ["aws_budgets_budget", "AWS::Budgets::Budget"],
  },
  {
    what: "the CDK metadata record",
    reason: "the CDK's own analytics row in a stack; it creates no AWS resource at all",
    basis: "PILOT_JOURNEY",
    types: ["AWS::CDK::Metadata"],
  },
  // The owner's decision 6431744115, item 3: authorization-adjacent objects outside the identity services, deletable when the run created them.
  {
    what: "an Organizations policy (a service control policy), its attachment, or a delegated administrator",
    reason: "a policy document and where it is attached; deleting it detaches or removes that policy and deploys nothing (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_organizations_policy", "aws_organizations_policy_attachment", "aws_organizations_delegated_administrator", "awscc_organizations_policy", "AWS::Organizations::Policy"],
  },
  {
    what: "a Lake Formation permission",
    reason: "one grant on a data catalog object; deleting it revokes that grant only (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_lakeformation_permissions", "awscc_lakeformation_principal_permissions", "AWS::LakeFormation::Permissions", "AWS::LakeFormation::PrincipalPermissions"],
  },
  {
    what: "a KMS grant",
    reason: "one grant on a key; deleting it retires that grant only (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_kms_grant"],
  },
  {
    what: "a resource-based policy on a bucket, a queue or a Lambda function",
    reason: "a policy on its resource; deleting it removes that policy only (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_s3_bucket_policy", "awscc_s3_bucket_policy", "AWS::S3::BucketPolicy", "aws_sqs_queue_policy", "AWS::SQS::QueuePolicy", "aws_lambda_permission", "awscc_lambda_permission", "AWS::Lambda::Permission"],
  },
  {
    what: "an IAM Roles Anywhere trust anchor or profile",
    reason: "a trust anchor or profile record; deleting it stops that path to a role's credentials and deletes no role (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_rolesanywhere_trust_anchor", "aws_rolesanywhere_profile", "awscc_rolesanywhere_trust_anchor", "awscc_rolesanywhere_profile", "AWS::RolesAnywhere::TrustAnchor", "AWS::RolesAnywhere::Profile"],
  },
  {
    what: "an RDS or Redshift role association",
    reason: "the link between a database and a role; deleting it removes the link, never the role or the database (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_rds_cluster_role_association", "aws_db_instance_role_association", "aws_redshift_cluster_iam_roles"],
  },
  {
    what: "a Cognito user pool user",
    reason: "one application user in a pool; deleting it removes that user only (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_cognito_user", "awscc_cognito_user_pool_user", "AWS::Cognito::UserPoolUser"],
  },
  // Common leaves, each with a material-risk note already in the proposal (src/apply/cleanup-proposal.ts, MATERIAL_RISKS).
  {
    what: "a Secrets Manager secret",
    reason: "one secret; deleting it schedules that secret's deletion (a material risk the proposal names) and deploys nothing",
    basis: "COMMON_LEAF",
    types: ["aws_secretsmanager_secret", "awscc_secretsmanager_secret", "AWS::SecretsManager::Secret"],
  },
  {
    what: "an RDS database instance or cluster",
    reason: "one database; deleting it removes that database and its data (a material risk the proposal names), and AWS refuses to delete a cluster that still has instances",
    basis: "COMMON_LEAF",
    types: ["aws_db_instance", "aws_rds_cluster", "awscc_rds_db_instance", "awscc_rds_db_cluster", "AWS::RDS::DBInstance", "AWS::RDS::DBCluster"],
  },
  {
    what: "an EFS file system or an EBS volume",
    reason: "one storage volume; deleting it removes that volume and its data (a material risk the proposal names), nothing else",
    basis: "COMMON_LEAF",
    types: ["aws_efs_file_system", "awscc_efs_file_system", "AWS::EFS::FileSystem", "aws_ebs_volume", "awscc_ec2_volume", "AWS::EC2::Volume"],
  },
  {
    what: "a KMS alias",
    reason: "a name for a key; deleting it removes the name, never the key",
    basis: "COMMON_LEAF",
    types: ["aws_kms_alias", "awscc_kms_alias", "AWS::KMS::Alias"],
  },
];

/** Every allowlisted type, in table order. */
export const AWS_LEAF_TYPE_NAMES: readonly string[] = AWS_LEAF_TYPES.flatMap((entry) => entry.types);
const LEAF_SET: ReadonlySet<string> = new Set(AWS_LEAF_TYPE_NAMES);

/** The entry a type belongs to, by exact name, or undefined for a type nobody has reviewed. */
export const awsLeafEntryOf = (type: string): AwsLeafEntry | undefined => LEAF_SET.has(type) ? AWS_LEAF_TYPES.find((entry) => entry.types.includes(type)) : undefined;

/** Whether a type is on the reviewed leaf allowlist (exact, case-exact). */
export const isAwsLeafType = (type: string): boolean => LEAF_SET.has(type);

/**
 * A well-formed resource type: a Terraform type (`<provider>_<name>`, lowercase) or a CloudFormation type (`Org::Service::Resource`,
 * `Custom::Name`, or a four-part module type). Anything else in a type field is not a type the cleanup can name, and fails closed.
 */
export const isWellFormedResourceType = (type: string): boolean => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(type) || /^[A-Za-z][A-Za-z0-9]*(?:::[A-Za-z0-9]+){1,3}$/.test(type);
