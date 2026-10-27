# DISCOVERY, both engines: control-plane metadata only (owner decision 2026-10-27, issue #39 comment 6440801434, item 2).
# The allow and deny lists live in discovery-policy.json so a test can read them exactly. The deny is an inline policy on the
# role, so it holds whatever discovery_managed_policy_arns names. A data read is lifted only by an entry in
# discovery_data_read_exceptions, which names the denied actions, the exact resources and the purpose.
locals {
  discovery_policy = jsondecode(file("${path.module}/discovery-policy.json"))
  discovery_allow  = sort(distinct(flatten([for group in values(local.discovery_policy.allow) : group.actions])))
  discovery_deny   = sort(distinct(flatten([for group in values(local.discovery_policy.deny) : group.actions])))

  # Each lifted action, with the union of the resources every exception names for it.
  excepted_actions = sort(distinct(flatten([for e in var.discovery_data_read_exceptions : e.actions])))
  excepted_resources = {
    for action in local.excepted_actions : action => sort(distinct(flatten([
      for e in var.discovery_data_read_exceptions : e.resources if contains(e.actions, action)
    ])))
  }
  unknown_exception_actions = setsubtract(toset(local.excepted_actions), toset(local.discovery_deny))

  discovery_scope_policy = jsonencode({ Version = "2012-10-17", Statement = concat(
    [{ Sid = "ControlPlaneMetadataReads", Effect = "Allow", Action = local.discovery_allow, Resource = "*" }],
    [{ Sid = "DenyDataPlaneAndSecretReads", Effect = "Deny", Action = setsubtract(local.discovery_deny, local.excepted_actions), Resource = "*" }],
    # A lifted action stays denied everywhere except the resources its exceptions name.
    [for i, action in local.excepted_actions : { Sid = "DenyDataReadOutsideException${i}", Effect = "Deny", Action = action, NotResource = local.excepted_resources[action] }],
    [for i, e in var.discovery_data_read_exceptions : { Sid = "DataReadException${i}", Effect = "Allow", Action = e.actions, Resource = e.resources }],
  ) })
}

resource "aws_iam_role_policy" "discovery_scope" {
  name   = "act-pilot-discovery-scope"
  role   = aws_iam_role.identity["DISCOVERY"].name
  policy = local.discovery_scope_policy

  lifecycle {
    precondition {
      condition     = length(local.unknown_exception_actions) == 0
      error_message = "discovery_data_read_exceptions may only lift actions that discovery-policy.json denies. Not denied: ${join(", ", sort(tolist(local.unknown_exception_actions)))}."
    }
  }
}

# ReadOnlyAccess allows data reads (object contents, items, log events, parameter values). The inline deny above still
# blocks the listed ones, but the managed policy is broader than control-plane metadata: plan shows this warning.
check "discovery_managed_policy_scope" {
  assert {
    condition     = !anytrue([for arn in var.discovery_managed_policy_arns : can(regex("^arn:aws[a-z-]*:iam::aws:policy/ReadOnlyAccess$", arn))])
    error_message = "DISCOVERY has ReadOnlyAccess, which allows data reads beyond control-plane metadata. The inline deny still applies; prefer ViewOnlyAccess plus a scoped policy whose scope and purpose are recorded."
  }
}
