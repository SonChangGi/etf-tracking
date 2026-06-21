import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_DIR = ROOT / ".github" / "workflows"
MUTABLE_ACTION_TAG = re.compile(r"uses:\s*[^#\n]*@v\d+\b")
PINNED_ACTION_SHA = re.compile(r"uses:\s*actions/[A-Za-z0-9_.-]+@[0-9a-f]{40}(?:\s+#\s+v\d+)?\b")


class ActionsPinningTest(unittest.TestCase):
    def test_github_actions_are_pinned_to_full_commit_shas(self):
        workflows = sorted(WORKFLOW_DIR.glob("*.yml")) + sorted(WORKFLOW_DIR.glob("*.yaml"))
        self.assertTrue(workflows, "expected at least one workflow to validate")
        offenders = []
        for workflow in workflows:
            for line_number, line in enumerate(workflow.read_text(encoding="utf-8").splitlines(), 1):
                if "uses:" not in line or "actions/" not in line:
                    continue
                if MUTABLE_ACTION_TAG.search(line) or not PINNED_ACTION_SHA.search(line):
                    offenders.append(f"{workflow.relative_to(ROOT)}:{line_number}: {line.strip()}")
        self.assertEqual([], offenders, "GitHub Actions uses must be pinned to immutable full SHAs")


if __name__ == "__main__":
    unittest.main()
