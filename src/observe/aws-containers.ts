/**
 * AWS stack containers: every resource type whose deletion tears down a CloudFormation stack or a provisioned product
 * (reviews 6412896598 B1 and 6432262110 B1; owner decision 6431744115). Deleting one deletes everything the stack holds,
 * IAM roles and other identities among it, and none of that is in the engine's state: a template body names types, not
 * ARNs; a template URL, a Serverless Application Repository application or a Service Catalog product's template is not in
 * the state at all. So the rule is by type, one anchored prefix check per family and nothing else, and the whole class is
 * CONTAINS_OTHERS: kept by the pilot owner, never proposed, never deleted directly or as a dependent, whoever created it.
 * The same table names the types whose attributes the blueprint scans for an identity's ARN (./blueprint.ts). It lives in the observe layer, below src/apply, so both the
 * blueprint and the cleanup classifier (src/apply/cleanup-proposal.ts) read it without widening the apply boundary (test/apply-boundary.test.ts).
 *
 * This is the one list. A family is a Terraform `aws_` type, the Cloud Control provider's `awscc_` type and the
 * CloudFormation type of the same object; a prefix that is a namespace (`aws_proton_`) keeps every type in it, the
 * fail-safe direction. The test table (test/apply-cleanup.test.ts) iterates this table, so an entry added here is always tested;
 * the test is only as complete as the table, and this table is not a completeness proof. Completeness comes from the reviewed
 * leaf allowlist (./aws-leaf-types.ts, delegated owner decision 6433391052): a type that is neither here nor on that list is
 * held for a person (TYPE_UNREVIEWED), never deleted. A family here carries a named reason instead of that generic one.
 */
export type AwsContainerFamily = {
  /** What the type is, in the words the proposal and the destroy-plan guard use. */
  what: string;
  /** Why deleting it deletes more than the state lists. */
  reason: string;
  /** Anchored type prefixes, case-exact (Terraform types are lowercase; CloudFormation types are case-exact). */
  prefixes: readonly string[];
};

export const AWS_CONTAINER_FAMILIES: readonly AwsContainerFamily[] = [
  {
    what: "a CloudFormation stack, stack set or stack instance",
    reason: "deleting it deletes everything its template holds, in this account or in every member account",
    prefixes: ["aws_cloudformation_stack", "awscc_cloudformation_stack", "AWS::CloudFormation::Stack"],
  },
  {
    what: "a Service Catalog provisioned product",
    reason: "it provisions a CloudFormation stack, which terminating the product deletes",
    prefixes: ["aws_servicecatalog_provisioned_product", "awscc_servicecatalog_cloud_formation_provisioned_product", "AWS::ServiceCatalog::CloudFormationProvisionedProduct"],
  },
  {
    what: "a Serverless Application Repository application",
    reason: "it is deployed as a CloudFormation stack (serverlessrepo-<name>), routinely with execution roles, which destroying it deletes",
    // `AWS::Serverless::Application` is the SAM form of the same deployment (a nested stack after the transform); `AWS::ServerlessRepo::` is kept as a fail-safe namespace.
    prefixes: ["aws_serverlessapplicationrepository_cloudformation_stack", "awscc_serverlessapplicationrepository_", "AWS::Serverless::Application", "AWS::ServerlessRepo::"],
  },
  {
    what: "a SageMaker project",
    reason: "deleting it terminates its Service Catalog provisioned product, and with it the stack",
    prefixes: ["aws_sagemaker_project", "awscc_sagemaker_project", "AWS::SageMaker::Project"],
  },
  {
    what: "a Proton environment or service",
    reason: "it is deployed from templates as CloudFormation stacks, which commonly create IAM roles (the whole Proton namespace is kept)",
    prefixes: ["aws_proton_", "awscc_proton_", "AWS::Proton::"],
  },
  {
    what: "an Elastic Beanstalk environment",
    reason: "it runs on a generated CloudFormation stack; kept as a fail-safe although that stack does not normally create IAM",
    prefixes: ["aws_elastic_beanstalk_environment", "awscc_elasticbeanstalk_environment", "AWS::ElasticBeanstalk::Environment"],
  },
  {
    what: "an SSM Quick Setup configuration",
    reason: "Quick Setup deploys its configurations as CloudFormation stack sets and stacks that create IAM roles and instance profiles, which deleting it deletes (the whole Quick Setup namespace is kept)",
    prefixes: ["aws_ssmquicksetup_", "awscc_ssmquicksetup_", "AWS::SSMQuickSetup::"],
  },
  {
    what: "a DataZone environment",
    reason: "it is provisioned as a CloudFormation stack that includes the environment's IAM user role, which deleting it tears down",
    prefixes: ["aws_datazone_environment", "awscc_datazone_environment", "AWS::DataZone::Environment"],
  },
  {
    what: "a Control Tower landing zone, control or baseline",
    reason: "decommissioning or disabling it deletes Control Tower's stack sets, the aws-controltower-* role stacks in member accounts among them (the whole Control Tower namespace is kept)",
    prefixes: ["aws_controltower_", "awscc_controltower_", "AWS::ControlTower::"],
  },
];

/** Every container prefix, in table order. */
export const AWS_CONTAINER_PREFIXES: readonly string[] = AWS_CONTAINER_FAMILIES.flatMap((family) => family.prefixes);

/** The family a type belongs to, or undefined for a type that is not a stack container. */
export const awsContainerFamilyOf = (type: string): AwsContainerFamily | undefined => AWS_CONTAINER_FAMILIES.find((family) => family.prefixes.some((prefix) => type.startsWith(prefix)));

/** Whether a type's deletion tears down a CloudFormation stack or a provisioned product. */
export const isAwsContainerType = (type: string): boolean => awsContainerFamilyOf(type) !== undefined;
