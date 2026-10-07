package agent_landing_zone.security

default decision := {
  "allow": false,
  "reasons": ["No security policy rule matched."],
  "obligations": [],
}

data_destination_allowed if {
  input.destination != "EXTERNAL_MODEL"
  input.destination != "EXTERNAL_STORAGE"
}

data_destination_allowed if {
  input.destination == "EXTERNAL_MODEL"
  input.handling.externalModelAllowed == true
}

data_destination_allowed if {
  input.destination == "EXTERNAL_STORAGE"
  input.handling.externalStorageAllowed == true
}

decision := {
  "allow": false,
  "reasons": ["Secret material cannot enter model, storage, or operator-output policy flows."],
  "obligations": ["Replace secret value with an opaque secret reference and metadata."],
} if {
  input.kind == "DATA_HANDLING"
  input.containsSecretMaterial == true
}

decision := {
  "allow": false,
  "reasons": ["Data classification policy does not permit external-model processing."],
  "obligations": [],
} if {
  input.kind == "DATA_HANDLING"
  input.containsSecretMaterial == false
  input.destination == "EXTERNAL_MODEL"
  input.handling.externalModelAllowed == false
}

decision := {
  "allow": false,
  "reasons": ["Data classification policy does not permit external storage."],
  "obligations": [],
} if {
  input.kind == "DATA_HANDLING"
  input.containsSecretMaterial == false
  input.destination == "EXTERNAL_STORAGE"
  input.handling.externalStorageAllowed == false
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": ["Preserve classification and provenance metadata."],
} if {
  input.kind == "DATA_HANDLING"
  input.containsSecretMaterial == false
  data_destination_allowed
}

normalized_host := lower(trim_space(input.destination.host)) if {
  input.kind == "EGRESS"
}

loopback_destination if {
  input.kind == "EGRESS"
  input.destination.scheme == "local"
}

loopback_destination if {
  normalized_host == "localhost"
}

loopback_destination if {
  normalized_host == "127.0.0.1"
}

loopback_destination if {
  normalized_host == "::1"
}

allowed_host if {
  input.kind == "EGRESS"
  some candidate in input.allowedHosts
  lower(trim_space(candidate)) == normalized_host
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "EGRESS"
  loopback_destination
}

decision := {
  "allow": false,
  "reasons": ["Destination is not on the explicit egress allowlist."],
  "obligations": [],
} if {
  input.kind == "EGRESS"
  not loopback_destination
  not allowed_host
}

decision := {
  "allow": false,
  "reasons": ["Restricted data cannot use external egress in the baseline policy."],
  "obligations": [],
} if {
  input.kind == "EGRESS"
  not loopback_destination
  allowed_host
  input.classification == "RESTRICTED"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "EGRESS"
  not loopback_destination
  allowed_host
  input.classification != "RESTRICTED"
}

allowed_capability(capability) if {
  input.compromiseState == "NORMAL"
}

allowed_capability(capability) if {
  input.compromiseState == "VERIFIED"
}

allowed_capability(capability) if {
  input.compromiseState == "SUSPECTED"
  capability == "EVIDENCE_READ"
}

allowed_capability(capability) if {
  input.compromiseState == "SUSPECTED"
  capability == "EVIDENCE_WRITE"
}

allowed_capability(capability) if {
  input.compromiseState == "SUSPECTED"
  capability == "VALIDATE"
}

allowed_capability(capability) if {
  input.compromiseState == "CONTAINED"
  capability == "EVIDENCE_READ"
}

allowed_capability(capability) if {
  input.compromiseState == "CONTAINED"
  capability == "VALIDATE"
}

allowed_capability(capability) if {
  input.compromiseState == "RECOVERY"
  capability == "EVIDENCE_READ"
}

allowed_capability(capability) if {
  input.compromiseState == "RECOVERY"
  capability == "EVIDENCE_WRITE"
}

allowed_capability(capability) if {
  input.compromiseState == "RECOVERY"
  capability == "CLOUD_READ"
}

allowed_capability(capability) if {
  input.compromiseState == "RECOVERY"
  capability == "VALIDATE"
}

denied_capabilities := [capability |
  some capability in input.requested
  not allowed_capability(capability)
] if {
  input.kind == "CAPABILITY"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "CAPABILITY"
  count(denied_capabilities) == 0
}

decision := {
  "allow": false,
  "reasons": [sprintf("Compromise state denies capabilities: %s.", [concat(", ", denied_capabilities)])],
  "obligations": ["Re-establish a VERIFIED state before restoring denied capabilities."],
} if {
  input.kind == "CAPABILITY"
  count(denied_capabilities) > 0
}

decision := {
  "allow": false,
  "reasons": ["Scheduled automation is suspended while compromise is suspected or contained."],
  "obligations": ["Preserve evidence and require explicit recovery-state transition."],
} if {
  input.kind == "AUTOMATION"
  input.compromiseState == "SUSPECTED"
}

decision := {
  "allow": false,
  "reasons": ["Scheduled automation is suspended while compromise is suspected or contained."],
  "obligations": ["Preserve evidence and require explicit recovery-state transition."],
} if {
  input.kind == "AUTOMATION"
  input.compromiseState == "CONTAINED"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "AUTOMATION"
  input.compromiseState != "SUSPECTED"
  input.compromiseState != "CONTAINED"
}
