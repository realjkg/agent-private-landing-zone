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
 * An attachment or setting that modifies another resource is a leaf only together with its parent: it is deleted only when its
 * parent is deleted in the same proposal, else held (the `parent` field and `awsParentIdOf`; design review 6434540427, B3).
 *
 * Not seeded, on purpose: the EKS access entries and policy associations and the Verified Permissions types (round 3, N4; still the
 * owner's decision), `terraform_data` and `null_resource` (a destroy-time provisioner can do anything; round 3, N2, still the
 * owner's), Organizations delegated administrators and Lake Formation permissions (not on the owner's list; a delegated
 * administrator has organization-wide effects and a Lake Formation grant may have existed before the run; design review
 * 6434540427, B1), the Redshift cluster IAM role set (it manages the cluster's whole role set; N5), and every type of the identity
 * services (always PROTECTED_IDENTITY).
 */
export type AwsLeafBasis =
  /** The pilot's own journeys create it: the bootstrap project, the pilot fixtures and the synthetic journeys' stacks. */
  | "PILOT_JOURNEY"
  /** The owner declared it deletable when this run created it (decision 6431744115, item 3), and nothing more than that list. */
  | "OWNER_DECISION"
  /** A common leaf, justified one by one in its reason. */
  | "COMMON_LEAF";

/**
 * How an attachment or setting names the resource it modifies, read from its own identifier in the state (design review 6434540427, B3):
 * SAME (the identifier is the parent's, as for an S3 bucket's settings and policy or an SQS queue's policy), BEFORE_FIRST_COLON or
 * BEFORE_FIRST_COMMA (`<parent>:<child>`, `<parent>,<role>`), AFTER_LAST_COLON (`<target>:<parent>`), or NOT_IN_STATE (the parent is not
 * in the identifier at all, so it can never be shown to be deleted and the entry is always held).
 */
export type AwsParentKey = "SAME" | "BEFORE_FIRST_COLON" | "BEFORE_FIRST_COMMA" | "AFTER_LAST_COLON" | "NOT_IN_STATE";

export type AwsLeafEntry = {
  /** What the object is. */
  what: string;
  /** Why deleting it removes that object alone: it deploys no stack, product, project, environment or nested deployment. */
  reason: string;
  basis: AwsLeafBasis;
  /**
   * The object holds data that deleting it destroys (or makes unreadable). Every type of such an entry carries a material-risk note in
   * the proposal (src/apply/cleanup-proposal.ts, MATERIAL_RISKS); a test fails when one is missing.
   */
  dataBearing?: true;
  /**
   * For an attachment or setting that modifies another resource (a bucket's settings and policy, a queue's policy, a function's
   * permission, a key's grant, a database's role association, a policy's attachment): the parent's types and how the parent's
   * identifier is read from this one's. Such a type is deleted only when its parent is deleted in the same proposal; otherwise it is
   * held for a person (TYPE_UNREVIEWED), because for these types a planned "create" can overwrite what the parent already had, so it
   * does not prove the run introduced it, and deleting it would change a resource the cleanup keeps.
   */
  parent?: { types: readonly string[]; key: AwsParentKey };
  /**
   * A further condition on the object itself, judged from the identifiers the state recorded (never fetched): why this one object is
   * not the kind the entry admits, or undefined when it is. An object that fails it is held as TYPE_UNREVIEWED with that reason.
   */
  condition?: (entry: LeafObject) => string | undefined;
  /** Exact type names: Terraform `aws_`, the Cloud Control provider's `awscc_`, and the CloudFormation type of the same object, where each exists. */
  types: readonly string[];
};

/** What the cleanup knows of one object: its type and the identifiers the state recorded. */
export type LeafObject = { type: string; id: string | null; arn: string | null };

/**
 * An Organizations policy's ARN names its kind: `arn:aws:organizations::<management account>:policy/o-<org>/<kind>/p-<id>`, where the
 * kind is `service_control_policy`, `resource_control_policy`, `tag_policy`, `backup_policy`, `aiservices_opt_out_policy`,
 * `chatbot_policy`, `declarative_policy_ec2` and so on. UNVERIFIED against a live organization: the format is AWS's documented one.
 */
const ORGANIZATIONS_POLICY_ARN = /^arn:aws(?:-[a-z]+)*:organizations::[0-9]{12}:policy\/o-[a-z0-9]{10,32}\/([a-z0-9_]{1,64})\/(p-[0-9a-zA-Z_]{8,128})$/;
const SERVICE_CONTROL_POLICY = "service_control_policy";

/**
 * The owner's decision 6440801434, item 3: an Organizations policy is a leaf only when it is a service control policy, read from the
 * policy ARN the state recorded. A missing or unreadable ARN, an ARN whose policy id is not the recorded id, or any other kind is held,
 * each with its own reason; other kinds need their own authorization and tests. The CloudFormation physical id of a policy is its id
 * alone, so a CDK-created policy is always held.
 */
export function serviceControlPolicyProblem(entry: LeafObject): string | undefined {
  const held = "; only service control policies are on the reviewed allowlist (owner decision 6440801434, item 3), so it is left in place for the environment's owner to delete or keep by hand";
  if (entry.arn === null) return "it is an Organizations policy whose kind cannot be read: the state records no policy ARN" + held;
  const parsed = ORGANIZATIONS_POLICY_ARN.exec(entry.arn);
  if (parsed === null) return "it is an Organizations policy whose kind cannot be read: its recorded ARN is not an Organizations policy ARN" + held;
  if (entry.id !== null && entry.id !== parsed[2]) return "it is an Organizations policy whose recorded id does not match the policy its ARN names, so its kind cannot be trusted" + held;
  if (parsed[1] !== SERVICE_CONTROL_POLICY) return "it is an Organizations policy of kind " + parsed[1]!.toUpperCase() + ", not a service control policy" + held;
  return undefined;
}

const BUCKETS = ["aws_s3_bucket", "awscc_s3_bucket", "AWS::S3::Bucket"] as const;

export const AWS_LEAF_TYPES: readonly AwsLeafEntry[] = [
  // The pilot's own journeys.
  {
    what: "an S3 bucket",
    reason: "a storage bucket holds objects only; deleting it deploys or deletes no other resource (CloudFormation refuses a non-empty bucket)",
    basis: "PILOT_JOURNEY", dataBearing: true,
    types: ["aws_s3_bucket", "awscc_s3_bucket", "AWS::S3::Bucket"],
  },
  {
    what: "a setting of an S3 bucket (versioning, encryption, public access block, ownership controls, lifecycle)",
    reason: "a configuration on its bucket; deleted only with the bucket, because on a bucket the cleanup keeps it would remove a control the bucket's owner relies on",
    basis: "PILOT_JOURNEY",
    parent: { types: BUCKETS, key: "SAME" },
    types: ["aws_s3_bucket_versioning", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_public_access_block", "aws_s3_bucket_ownership_controls", "aws_s3_bucket_lifecycle_configuration"],
  },
  {
    what: "a CloudWatch Logs log group",
    reason: "holds log events only; deleting it removes them and nothing else",
    basis: "PILOT_JOURNEY", dataBearing: true,
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
    reason: "holds items only; deleting it removes the table, its replicas and its data (a material risk the proposal names), nothing else",
    basis: "PILOT_JOURNEY", dataBearing: true,
    types: ["aws_dynamodb_table", "awscc_dynamodb_table", "AWS::DynamoDB::Table"],
  },
  {
    what: "a KMS key",
    reason: "deleting it schedules that key's deletion (a material risk the proposal names); it deploys nothing",
    basis: "PILOT_JOURNEY", dataBearing: true,
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
  // The owner's decision 6431744115, item 3, exactly: SCPs and their attachments, KMS grants, S3/SQS/Lambda resource policies, Roles Anywhere,
  // RDS role associations and Cognito users. Not seeded (design review 6434540427): delegated administrators and Lake Formation permissions
  // (not on the owner's list), and the Redshift cluster IAM role set (it manages the cluster's whole role set, not one association).
  {
    what: "an Organizations service control policy",
    reason: "a policy document; deleting it detaches and removes that policy and deploys nothing (owner: deletable when run-created, service control policies only, decision 6440801434 item 3)",
    basis: "OWNER_DECISION",
    condition: serviceControlPolicyProblem,
    types: ["aws_organizations_policy", "awscc_organizations_policy", "AWS::Organizations::Policy"],
  },
  {
    what: "the attachment of an Organizations service control policy",
    reason: "where a policy is attached; deleted only with its policy, a run-created service control policy this proposal deletes, never alone from a target that keeps other policies (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    parent: { types: ["aws_organizations_policy"], key: "AFTER_LAST_COLON" },
    types: ["aws_organizations_policy_attachment"],
  },
  {
    what: "a KMS grant",
    reason: "one grant on a key; deleted only with its key (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    parent: { types: ["aws_kms_key"], key: "BEFORE_FIRST_COLON" },
    types: ["aws_kms_grant"],
  },
  {
    what: "an S3 bucket policy",
    reason: "a policy on its bucket; deleted only with the bucket, because creating one overwrites the policy a bucket had and deleting it can remove deny statements (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    parent: { types: BUCKETS, key: "SAME" },
    types: ["aws_s3_bucket_policy", "awscc_s3_bucket_policy", "AWS::S3::BucketPolicy"],
  },
  {
    what: "an SQS queue policy",
    reason: "a policy on its queue; deleted only with the queue, because creating one overwrites the policy a queue had (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    parent: { types: ["aws_sqs_queue", "awscc_sqs_queue", "AWS::SQS::Queue"], key: "SAME" },
    types: ["aws_sqs_queue_policy", "AWS::SQS::QueuePolicy"],
  },
  {
    what: "a Lambda permission",
    reason: "a statement in its function's resource policy; the state does not name the function in its identifier, so it is always held for a person until it can be shown to go with its function (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    parent: { types: ["aws_lambda_function", "awscc_lambda_function", "AWS::Lambda::Function"], key: "NOT_IN_STATE" },
    types: ["aws_lambda_permission", "awscc_lambda_permission", "AWS::Lambda::Permission"],
  },
  {
    what: "an IAM Roles Anywhere trust anchor or profile",
    reason: "a trust anchor or profile record; deleting it stops that path to a role's credentials and deletes no role (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_rolesanywhere_trust_anchor", "aws_rolesanywhere_profile", "awscc_rolesanywhere_trust_anchor", "awscc_rolesanywhere_profile", "AWS::RolesAnywhere::TrustAnchor", "AWS::RolesAnywhere::Profile"],
  },
  {
    what: "an RDS cluster role association",
    reason: "the link between a cluster and a role; deleted only with the cluster, never the role (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    parent: { types: ["aws_rds_cluster"], key: "BEFORE_FIRST_COMMA" },
    types: ["aws_rds_cluster_role_association"],
  },
  {
    what: "an RDS database instance role association",
    reason: "the link between a database instance and a role; deleted only with the instance, never the role (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    parent: { types: ["aws_db_instance"], key: "BEFORE_FIRST_COMMA" },
    types: ["aws_db_instance_role_association"],
  },
  {
    what: "a Cognito user pool user",
    reason: "one application user in a pool; deleting it removes that user only (owner: deletable when run-created)",
    basis: "OWNER_DECISION",
    types: ["aws_cognito_user", "awscc_cognito_user_pool_user", "AWS::Cognito::UserPoolUser"],
  },
  // Common leaves; each data-bearing one carries a material-risk note in the proposal (src/apply/cleanup-proposal.ts, MATERIAL_RISKS), which a test enforces.
  {
    what: "a Secrets Manager secret",
    reason: "one secret; deleting it schedules that secret's deletion (a material risk the proposal names) and deploys nothing",
    basis: "COMMON_LEAF", dataBearing: true,
    types: ["aws_secretsmanager_secret", "awscc_secretsmanager_secret", "AWS::SecretsManager::Secret"],
  },
  {
    what: "an RDS database instance or cluster",
    reason: "one database; deleting it removes that database and its data (a material risk the proposal names), and AWS refuses to delete a cluster that still has instances",
    basis: "COMMON_LEAF", dataBearing: true,
    types: ["aws_db_instance", "aws_rds_cluster", "awscc_rds_db_instance", "awscc_rds_db_cluster", "AWS::RDS::DBInstance", "AWS::RDS::DBCluster"],
  },
  {
    what: "an EFS file system or an EBS volume",
    reason: "one storage volume; deleting it removes that volume and its data (a material risk the proposal names), nothing else",
    basis: "COMMON_LEAF", dataBearing: true,
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

/**
 * The identifier of the parent an attachment or setting modifies, read from its own identifier, or undefined when it cannot be read
 * (NOT_IN_STATE, no identifier, or no separator): the one rule for every entry with a `parent` (design review 6434540427, B3).
 */
export function awsParentIdOf(key: AwsParentKey, id: string | null): string | undefined {
  if (id === null || id === "" || key === "NOT_IN_STATE") return undefined;
  if (key === "SAME") return id;
  const at = key === "BEFORE_FIRST_COLON" ? id.indexOf(":") : key === "BEFORE_FIRST_COMMA" ? id.indexOf(",") : id.lastIndexOf(":");
  if (at <= 0 || at >= id.length - 1) return undefined;
  return key === "AFTER_LAST_COLON" ? id.slice(at + 1) : id.slice(0, at);
}

/** Why this object fails its allowlist entry's condition, or undefined (no condition, the condition holds, or the type is not allowlisted). */
export const awsLeafConditionProblem = (entry: LeafObject): string | undefined => awsLeafEntryOf(entry.type)?.condition?.(entry);

/** Whether a type is on the reviewed leaf allowlist (exact, case-exact). */
export const isAwsLeafType = (type: string): boolean => LEAF_SET.has(type);

/**
 * A well-formed resource type: a Terraform type (`<provider>_<name>`, lowercase) or a CloudFormation type (`Org::Service::Resource`,
 * `Custom::Name`, or a four-part module type). Anything else in a type field is not a type the cleanup can name, and fails closed.
 */
export const isWellFormedResourceType = (type: string): boolean => /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(type) || /^[A-Za-z][A-Za-z0-9]*(?:::[A-Za-z0-9]+){1,3}$/.test(type);
