import subprocess
import sys
import unittest


class ActionsPinningTest(unittest.TestCase):
    def test_github_owned_actions_are_sha_pinned(self):
        result = subprocess.run(
            [sys.executable, "scripts/verify_actions_pinning.py"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("pinned", result.stdout)


if __name__ == "__main__":
    unittest.main()
