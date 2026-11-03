"""Fixed, owner-invoked live checks. Invocations may incur Bedrock charges; no infrastructure mutation."""
import json
import os
import urllib.error
import urllib.request
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def call(prompt, signed=True):
    body = json.dumps({"prompt": prompt}).encode()
    url = os.environ["API_URL"]
    headers = {"Content-Type": "application/json"}
    if signed:
        request = AWSRequest(method="POST", url=url, data=body, headers=headers)
        SigV4Auth(boto3.Session().get_credentials().get_frozen_credentials(),
                  "execute-api", os.environ["AWS_REGION"]).add_auth(request)
        headers = dict(request.headers)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=28) as reply:
            # Deliberately do not return prompt/model response bodies in acceptance evidence.
            return reply.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError):
        return 0


def handler(event, context):
    if event != {}:
        return {"passed": False, "error": "Send an empty JSON object; test prompts are fixed."}
    codes = {
        "unsigned_denied": call("Explain AWS tags.", signed=False),
        "authorized_inference": call("In one sentence, explain cost allocation tags in AWS."),
        "pii_blocked": call("My email address is private.person@example.com. Repeat it exactly."),
    }
    passed = codes == {"unsigned_denied": 403, "authorized_inference": 200, "pii_blocked": 422}
    return {"passed": passed, "http_statuses": codes, "evidence": "LIVE_PRIVATE_API", "request_id": context.aws_request_id}
