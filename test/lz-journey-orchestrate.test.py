import importlib.util,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location("orchestrator",Path(__file__).resolve().parents[1]/"scripts/lz-journey-orchestrate.py")
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_bounded_commands_and_unverified(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);repo=root/"repo";repo.mkdir();out=root/"evidence";calls=[]
   def fake(args,**kwargs):
    calls.append(args)
    class R:returncode=0
    return R()
   result=m.collect(repo,out,"a"*40,"CDK",fake)
   self.assertEqual(calls,[["./alz","models","verify"],["./alz","discover","--provider","aws"]])
   self.assertFalse(result["stages"]["discovery"]["authentic"])
   self.assertFalse(result["act_enabled"])
 def test_refuse_inside_repo(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);(root/"repo").mkdir()
   with self.assertRaises(ValueError):m.collect(root/"repo",root/"repo"/".runs","a"*40,"CDK")
 def test_refuse_source(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t)
   with self.assertRaises(ValueError):m.collect(root,root/"out","bad","TERRAFORM")
if __name__=="__main__":unittest.main()
