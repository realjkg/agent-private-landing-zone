package agent_landing_zone.security

default decision := {
  "allow": false,
  "reasons": ["No security policy rule matched."],
  "obligations": [],
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": ["Preserve classification and provenance metadata."],
} if {
  input.kind == "DATA_HANDLING"
  not input.containsSecretMaterial
  input.destination != "EXTERNAL_MODEL"
  input.destination != "EXTERNAL_STORAGE"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": ["Preserve classification and provenance metadata."],
} if {
  input.kind == "DATA_HANDLING"
  not input.containsSecretMaterial
  input.destination == "EXTERNAL_MODEL"
  input.handling.externalModelAllowed == true
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": ["Preserve classification and provenance metadata."],
} if {
  input.kind == "DATA_HANDLING"
  not input.containsSecretMaterial
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

loopback_host if {
  input.destination.host == "localhost"
}

loopback_host if {
  input.destination.host == "127.0.0.1"
}

loopback_host if {
  input.destination.host == "::1"
}

allowed_host if {
  input.destination.host == input.allowedHosts[_]
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "EGRESS"
  loopback_host
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "EGRESS"
  input.classification != "RESTRICTED"
  allowed_host
}

decision := {
  "allow": false,
  "reasons": ["Restricted data cannot use external egress in the baseline policy."],
  "obligations": [],
} if {
  input.kind == "EGRESS"
  input.classification == "RESTRICTED"
  not loopback_host
}

normal_or_verified if {
  input.compromiseState == "NORMAL"
}

normal_or_verified if {
  input.compromiseState == "VERIFIED"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "CAPABILITY"
  normal_or_verified
}

safe_suspected_capability(capability) if {
  capability == "EVIDENCE_READ"
}

safe_suspected_capability(capability) if {
  capability == "EVIDENCE_WRITE"
}

safe_suspected_capability(capability) if {
  capability == "VALIDATE"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "CAPABILITY"
  input.compromiseState == "SUSPECTED"
  every capability in input.requested {
    safe_suspected_capability(capability)
  }
}

safe_contained_capability(capability) if {
  capability == "EVIDENCE_READ"
}

safe_contained_capability(capability) if {
  capability == "VALIDATE"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "CAPABILITY"
  input.compromiseState == "CONTAINED"
  every capability in input.requested {
    safe_contained_capability(capability)
  }
}

safe_recovery_capability(capability) if {
  capability == "EVIDENCE_READ"
}

safe_recovery_capability(capability) if {
  capability == "EVIDENCE_WRITE"
}

safe_recovery_capability(capability) if {
  capability == "CLOUD_READ"
}

safe_recovery_capability(capability) if {
  capability == "VALIDATE"
}

decision := {
  "allow": true,
  "reasons": [],
  "obligations": [],
} if {
  input.kind == "CAPABILITY"
  input.compromiseState == "RECOVERY"
  every capability in input.requested {
    safe_recovery_capability(capability)
  }
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
