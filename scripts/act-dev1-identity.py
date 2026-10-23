#!/usr/bin/env python3
"""ACT-DEV-1 four-role OIDC verifier. Read-only STS; no assumed credentials persist."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import time

ROLES = ("DISCOVERY", "STATE", "STATE_WRITE", "APPLY")
ARN = re.compile(r"^arn:aws:iam::([0-9]{12}):role/([A-Za-z0-9+=,.@_/-]+)$")
ACCOUNT = re.compile(r"^[0-9]{12}$")

class IdentityRefusal(ValueError):
    pass

def refuse(reason):
    raise IdentityRefusal(reason)

def decode_claims(token):
    parts = token.split(".")
    if len(parts) != 3:
        refuse("JWT_FORMAT_INVALID")
    try:
        body = parts[1] + "=" * (-len(parts[1]) % 4)
        claims = json.loads(base64.urlsafe_b64decode(body))
    except (ValueError, TypeError):
        refuse("JWT_CLAIMS_INVALID")
    if not isinstance(claims, dict):
        refuse("JWT_CLAIMS_INVALID")
    return claims

def require_file(path):
    if not isinstance(path, str) or not os.path.isabs(path):
        refuse("TOKEN_PATH_NOT_ABSOLUTE")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        refuse("TOKEN_FILE_INSECURE")
    if info.st_uid != os.geteuid():
        refuse("TOKEN_FILE_OWNER_MISMATCH")
    if info.st_size > 16384 or info.st_size < 20:
        refuse("TOKEN_FILE_SIZE_INVALID")
    return info

def validate(config, *, sts_factory=None, now=None, environment=None):
    if not isinstance(config, dict) or config.get("environment") != "DEV" or config.get("engine") != "TERRAFORM":
        refuse("PILOT_SCOPE_INVALID")
    account = config.get("accountId")
    if not isinstance(account, str) or not ACCOUNT.fullmatch(account) or account == config.get("managementAccountId"):
        refuse("TARGET_ACCOUNT_INVALID")
    if config.get("region") != "us-east-2":
        refuse("REGION_UNREVIEWED")
    issuer, audience = config.get("issuer"), config.get("audience")
    if not isinstance(issuer, str) or not issuer.startswith("https://") or not isinstance(audience, str) or not audience:
        refuse("ISSUER_AUDIENCE_INVALID")
    identities = config.get("identities")
    if not isinstance(identities, dict) or set(identities) != set(ROLES):
        refuse("FOUR_IDENTITIES_REQUIRED")
    names, subjects, paths, inodes = set(), set(), set(), set()
    t = time.time() if now is None else now
    results = {}
    for role in ROLES:
        item = identities[role]
        if not isinstance(item, dict) or set(item) != {"roleArn", "subject", "tokenFile"}:
            refuse("IDENTITY_FIELDS_INVALID")
        arn, subject, path = item["roleArn"], item["subject"], item["tokenFile"]
        match = ARN.fullmatch(arn) if isinstance(arn, str) else None
        if not match or match[1] != account or not isinstance(subject, str) or not subject:
            refuse("ROLE_SCOPE_MISMATCH")
        if any(x in names for x in (arn,)) or subject in subjects or path in paths:
            refuse("COLLAPSED_IDENTITY")
        names.add(arn); subjects.add(subject); paths.add(path)
        file_info = require_file(path)
        key = (file_info.st_dev, file_info.st_ino)
        if key in inodes:
            refuse("TOKEN_FILE_REUSED")
        inodes.add(key)
        token = Path(path).read_text(encoding="ascii").strip()
        claims = decode_claims(token)
        if claims.get("iss") != issuer or claims.get("sub") != subject:
            refuse("OIDC_SUBJECT_MISMATCH")
        aud = claims.get("aud")
        if (isinstance(aud, list) and audience not in aud) or (not isinstance(aud, list) and aud != audience):
            refuse("OIDC_AUDIENCE_MISMATCH")
        if not isinstance(claims.get("iat"), int) or not isinstance(claims.get("exp"), int) or not isinstance(claims.get("nbf", claims["iat"]), int):
            refuse("TOKEN_TIMESTAMPS_MISSING")
        if not (claims["iat"] <= t + 60 and claims.get("nbf", claims["iat"]) <= t + 60 < claims["exp"] and claims["exp"] - t >= 120):
            refuse("TOKEN_EXPIRED_OR_TOO_SHORT")
        if claims["exp"] - claims["iat"] > 3600:
            refuse("TOKEN_LIFETIME_TOO_LONG")
        if sts_factory is None:
            results[role] = {"status":"CLAIMS_INSPECTED_UNVERIFIED","roleArn":arn,"subject":subject,
                             "audience":audience,"expiresAt":claims["exp"]}
        else:
            sts = sts_factory(role)
            response = sts.assume_role_with_web_identity(
                RoleArn=arn, RoleSessionName="alz-dev1-"+role.lower().replace("_","-"),
                WebIdentityToken=token, DurationSeconds=900)
            assumed = response.get("AssumedRoleUser",{}).get("Arn","")
            expected = "arn:aws:sts::"+account+":assumed-role/"+match[2].split("/")[-1]+"/"
            if not assumed.startswith(expected):
                refuse("STS_ASSUMED_ROLE_MISMATCH")
            credentials = response.get("Credentials", {})
            if not credentials.get("SessionToken") or not credentials.get("AccessKeyId"):
                refuse("STS_CREDENTIALS_MISSING")
            results[role]={"status":"STS_VERIFIED","roleArn":arn,"assumedRoleArn":assumed,
                           "subject":subject,"audience":audience,"expiresAt":claims["exp"]}
    return {"kind":"ACT_DEV1_OIDC_EVIDENCE","schemaVersion":1,"accountId":account,"region":config["region"],
            "mode":"READ_ONLY","verified":sts_factory is not None,"roles":results,
            "rawTokensStored":False,"infrastructureAct":"DISABLED",
            "note":"Successful STS calls attest role assumption, not IAM/SCP/RCP effective permissions."}


def export_bindings(config, report):
    """An operator sources only verified role/path references, never raw bearer tokens."""
    if not report.get("verified") or any(x.get("status")!="STS_VERIFIED" for x in report.get("roles",{}).values()):
        refuse("STS_EVIDENCE_REQUIRED_FOR_EXPORT")
    lines=["unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SHARED_CREDENTIALS_FILE AWS_CONFIG_FILE"]
    for name in ROLES:
        role=config["identities"][name]
        for variable,value in (("AWS_ROLE_ARN",role["roleArn"]),
                               ("AWS_WEB_IDENTITY_TOKEN_FILE",role["tokenFile"]),
                               ("AWS_REGION",config["region"])):
            lines.append("export ALZ_"+name+"_"+variable+"="+shlex.quote(value))
    return "\\n".join(lines)+"\\n"

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Local 0600 JSON with role ARNs, observed subjects and absolute token paths")
    parser.add_argument("--output",required=True)
    parser.add_argument("--env-output",help="Shell exports of STS-verified paths/roles only (0600); never contains tokens")
    parser.add_argument("--inspect-only",action="store_true",help="Check token claims without STS (NOT authenticated evidence)")
    a=parser.parse_args()
    try:
        if not a.inspect_only and any(os.environ.get(k) for k in ("AWS_PROFILE","AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_SHARED_CREDENTIALS_FILE")):
            refuse("AMBIENT_AWS_CREDENTIALS_FORBIDDEN")
        config=json.loads(Path(a.config).read_text())
        if a.inspect_only:
            factory=None
        else:
            import boto3
            from botocore import UNSIGNED
            from botocore.config import Config
            # AssumeRoleWithWebIdentity is an unsigned STS operation. No local profile is used.
            factory=lambda role: boto3.client("sts",region_name="us-east-2",config=Config(signature_version=UNSIGNED))
        report=validate(config,sts_factory=factory)
        target=Path(a.output)
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(report,indent=2)+"\n")
        os.chmod(target,0o600)
        print("ACT-DEV-1 identity:", "STS_VERIFIED" if report["verified"] else "CLAIMS_ONLY_UNVERIFIED",
              "| four roles | no token material retained")
        return 0 if report["verified"] else 2
    except (IdentityRefusal,OSError,ValueError) as error:
        print("ACT-DEV-1 identity BLOCKED:",type(error).__name__ if not isinstance(error,IdentityRefusal) else str(error),file=sys.stderr)
        return 2
if __name__=="__main__":
    raise SystemExit(main())
