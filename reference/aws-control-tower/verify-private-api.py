"""Fixed, owner-invoked live checks. Invocations may incur Bedrock charges; no infrastructure mutation."""
import json
import os
import signal
import time
import urllib.error
import urllib.request
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


def deadline_expired(signum, frame):
    raise TimeoutError("Verifier request deadline exceeded.")


def call(prompt, deadline, signed=True):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return 0
    previous_handler = signal.signal(signal.SIGALRM, deadline_expired)
    signal.setitimer(signal.ITIMER_REAL, min(28, remaining))
    try:
        body = json.dumps({"prompt": prompt}).encode()
        url = os.environ["API_URL"]
        headers = {"Content-Type": "application/json"}
        if signed:
            request = AWSRequest(method="POST", url=url, data=body, headers=headers)
            SigV4Auth(boto3.Session().get_credentials().get_frozen_credentials(),
                      "execute-api", os.environ["AWS_REGION"]).add_auth(request)
            headers = dict(request.headers)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return 0
        with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers), timeout=min(28, remaining)) as reply:
            # Deliberately do not return prompt/model response bodies in acceptance evidence.
            return reply.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError):
        return 0
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def handler(event, context):
    if event != {}:
        return {"passed": False, "error": "Send an empty JSON object; test prompts are fixed."}
    deadline = time.monotonic() + max(0, context.get_remaining_time_in_millis() / 1000 - 5)
    codes = {
        "unsigned_denied": call("Explain AWS tags.", deadline, signed=False),
        "authorized_inference": call("In one sentence, explain cost allocation tags in AWS.", deadline),
        "pii_blocked": call("My email address is private.person@example.com. Repeat it exactly.", deadline),
    }
    passed = codes == {"unsigned_denied": 403, "authorized_inference": 200, "pii_blocked": 422}
    return {"passed": passed, "http_statuses": codes, "evidence": "LIVE_PRIVATE_API", "request_id": context.aws_request_id}
