"""Synthetic verifier checks: no credentials, network, or inference."""
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import signal
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import urllib.error


spec = importlib.util.spec_from_file_location(
    "verifier", Path(__file__).resolve().parents[1] / "verify-private-api.py"
)
verifier = importlib.util.module_from_spec(spec)
with patch.dict("sys.modules", {
    "boto3": MagicMock(),
    "botocore": MagicMock(),
    "botocore.auth": MagicMock(),
    "botocore.awsrequest": MagicMock(),
}):
    spec.loader.exec_module(verifier)


class VerifierTests(unittest.TestCase):
    def test_trickling_headers_cannot_exceed_the_wall_clock_deadline(self):
        class SlowHeaders(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    self.wfile.write(b"HTTP/1.1 200 OK\r\nX-Slow: ")
                    for _ in range(40):
                        self.wfile.write(b"x")
                        self.wfile.flush()
                        time.sleep(0.02)
                    self.wfile.write(b"\r\nContent-Length: 0\r\n\r\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), SlowHeaders)
        worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        worker.start()
        previous_handler = signal.getsignal(signal.SIGALRM)
        try:
            with patch.dict("os.environ", {"API_URL": f"http://127.0.0.1:{server.server_port}/chat"}):
                started = time.monotonic()
                self.assertEqual(verifier.call("synthetic", started + 0.15, signed=False), 0)
                self.assertLess(time.monotonic() - started, 0.5)
            self.assertEqual(signal.getsignal(signal.SIGALRM), previous_handler)
            self.assertEqual(signal.getitimer(signal.ITIMER_REAL)[0], 0)
        finally:
            server.shutdown()
            server.server_close()
            worker.join()

    def run_checks(self, budget_ms, statuses=None):
        elapsed = [0]
        timeouts = []
        context = SimpleNamespace(
            aws_request_id="synthetic-request",
            get_remaining_time_in_millis=lambda: budget_ms - elapsed[0] * 1000,
        )

        def urlopen(request, timeout):
            timeouts.append(timeout)
            if statuses is None:
                elapsed[0] += timeout
                raise TimeoutError()
            elapsed[0] += 1
            status = statuses[len(timeouts) - 1]
            if status != 200:
                raise urllib.error.HTTPError(request.full_url, status, "synthetic", {}, None)
            reply = MagicMock()
            reply.__enter__.return_value.status = status
            return reply

        with patch.dict("os.environ", {"API_URL": "https://synthetic.invalid/chat", "AWS_REGION": "us-east-1"}), \
                patch.object(verifier.time, "monotonic", side_effect=lambda: elapsed[0]), \
                patch.object(verifier.urllib.request, "urlopen", side_effect=urlopen):
            report = verifier.handler({}, context)
        return report, timeouts, elapsed[0]

    def test_timeouts_share_the_remaining_lambda_budget(self):
        report, timeouts, elapsed = self.run_checks(70000)
        self.assertEqual(timeouts, [28, 28, 9])
        self.assertEqual(elapsed, 65)
        self.assertFalse(report["passed"])
        self.assertEqual(report["http_statuses"], {
            "unsigned_denied": 0, "authorized_inference": 0, "pii_blocked": 0,
        })
        self.assertEqual(report["request_id"], "synthetic-request")

    def test_exhausted_budget_skips_remaining_calls_and_returns_evidence(self):
        report, timeouts, elapsed = self.run_checks(15000)
        self.assertEqual(timeouts, [10])
        self.assertEqual(elapsed, 10)
        self.assertFalse(report["passed"])
        self.assertEqual(len(report["http_statuses"]), 3)

    def test_no_http_calls_when_only_report_reserve_remains(self):
        report, timeouts, _ = self.run_checks(4000)
        self.assertEqual(timeouts, [])
        self.assertFalse(report["passed"])

    def test_successful_checks_preserve_evidence_without_response_bodies(self):
        report, timeouts, _ = self.run_checks(70000, [403, 200, 422])
        self.assertTrue(report["passed"])
        self.assertEqual(timeouts, [28, 28, 28])
        self.assertEqual(set(report), {"passed", "http_statuses", "evidence", "request_id"})

    def test_invalid_event_makes_no_http_calls(self):
        with patch.object(verifier.urllib.request, "urlopen") as urlopen:
            self.assertFalse(verifier.handler({"prompt": "not accepted"}, None)["passed"])
            urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
