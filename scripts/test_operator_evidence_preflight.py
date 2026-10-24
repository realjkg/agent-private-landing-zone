import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import importlib.util

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("operator-evidence-preflight.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PreflightTests(unittest.TestCase):
    @patch.object(module, "installed_models", return_value=(list(module.BASELINE), {"status": "PASS"}))
    @patch.object(module.shutil, "which", return_value="/bin/tool")
    def test_local_ready(self, *_):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "alz").write_text("")
            (root / "package.json").write_text("{}")
            self.assertEqual(module.evaluate(root, "local", None, None, [])["decision"], "READY_FOR_QUALIFICATION")

    @patch.object(module, "installed_models", return_value=([], {"status": "FAIL"}))
    @patch.object(module.shutil, "which", return_value=None)
    def test_missing_prerequisites_block(self, *_):
        self.assertEqual(module.evaluate(Path("/missing"), "local", None, None, [])["decision"], "BLOCKED")

    @patch.object(module, "installed_models", return_value=(list(module.BASELINE), {"status": "PASS"}))
    @patch.object(module.shutil, "which", return_value="/bin/tool")
    def test_aws_requires_profile_and_region(self, *_):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "alz").write_text("")
            (root / "package.json").write_text("{}")
            self.assertEqual(module.evaluate(root, "aws", None, None, [])["checks"]["aws_identity"]["status"], "FAIL")

if __name__ == "__main__":
    unittest.main()
