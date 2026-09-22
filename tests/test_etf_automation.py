import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import etf_automation as automation
import refresh_etf_pipeline as pipeline


def write_current(data, target="2026-09-22"):
    data.mkdir(parents=True, exist_ok=True)
    (data / "status.json").write_text(json.dumps({"targetDate": target, "overallStatus": "ok", "priceErrorCount": 0,
        "etfs": [{"latestDate": target, "sourceStatus": "live"} for _ in range(3)]}))
    (data / "automation-status.json").write_text(json.dumps({"targetDate": target, "runStatus": "ok", "warningCount": 0}))
    (data / "summary.json").write_text(json.dumps({"dataAsOf": target}))


class CalendarTests(unittest.TestCase):
    def test_disclosure_day_uses_korean_exchange_sessions_including_closures(self):
        cases = {"2026-09-22": "2026-09-22", "2026-09-19": "2026-09-18", "2026-09-20": "2026-09-18",
            "2026-09-24": "2026-09-23", "2026-12-31": "2026-12-30", "2027-01-01": "2026-12-30",
            "2025-01-27": "2025-01-24", "2025-06-03": "2025-06-02"}
        for date, expected in cases.items():
            with self.subTest(date=date):
                now = dt.datetime.fromisoformat(date + "T10:00:00+09:00")
                self.assertEqual(automation.disclosure_date(now), expected)

    def test_korean_date_can_differ_from_utc_date(self):
        self.assertEqual(automation.disclosure_date(dt.datetime.fromisoformat("2026-09-21T23:00:00+00:00")), "2026-09-22")

    def test_freshness_rejects_single_etf_lag_and_summary_date_only_refresh(self):
        with tempfile.TemporaryDirectory() as temporary:
            data = Path(temporary)
            write_current(data)
            automation.validate_current(data, "2026-09-22")
            with self.assertRaises(ValueError):
                automation.validate_current(data, "2026-09-23")
            status = json.loads((data / "status.json").read_text())
            status["etfs"][1]["latestDate"] = "2026-09-18"
            (data / "status.json").write_text(json.dumps(status))
            with self.assertRaises(ValueError):
                automation.validate_current(data, "2026-09-22")

    def test_deployment_rejects_a_target_that_became_stale_during_run(self):
        with mock.patch.object(automation, "disclosure_date", return_value="2026-09-23"), mock.patch.object(sys, "argv", ["etf_automation.py", "--target-date", "2026-09-22", "--require-current"]):
            with self.assertRaisesRegex(ValueError, "changed during"):
                automation.main()

    def test_current_but_unpublished_requires_delivery_and_current_published_is_noop(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_current(root / "data")
            for match, expected in [(True, "should_deploy=false"), (False, "should_deploy=true")]:
                output = root / "output"
                output.unlink(missing_ok=True)
                with mock.patch.object(automation, "ROOT", root), mock.patch.object(automation, "public_matches", return_value=match), mock.patch.object(sys, "argv", ["etf_automation.py", "--target-date", "2026-09-22", "--output", str(output)]):
                    self.assertEqual(automation.main(), 0)
                self.assertIn("should_collect=false", output.read_text())
                self.assertIn(expected, output.read_text())


class CandidateTests(unittest.TestCase):
    def run_scenario(self, successful):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "repo"
            write_current(root / "data", "2026-09-18")
            (root / "shared-platform/dist").mkdir(parents=True)
            (root / "shared-platform/dist/index.js").write_text("runtime")
            before = {p.name: p.read_bytes() for p in (root / "data").iterdir()}
            targets = []
            def execute(command, cwd, **kwargs):
                if command[0] == "npm":
                    self.assertTrue(successful)
                else:
                    targets.append(command[command.index("--target-date") + 1])
                    write_current(Path(cwd) / "data")
                    if not successful:
                        (Path(cwd) / "data/automation-status.json").write_text(json.dumps({"runStatus": "waiting_for_data", "targetDate": "2026-09-22"}))
                return mock.Mock(returncode=0)
            with mock.patch.object(pipeline, "ROOT", root), mock.patch.object(pipeline.subprocess, "run", side_effect=execute), mock.patch.object(sys, "argv", ["refresh_etf_pipeline.py", "--target-date", "2026-09-22", "--attempts", "2", "--retry-delay", "0", "--diagnostics-dir", str(Path(temporary) / "diagnostics")]):
                self.assertEqual(pipeline.main(), 0)
            if successful:
                automation.validate_current(root / "data", "2026-09-22")
                self.assertEqual(targets, ["2026-09-22"])
            else:
                self.assertEqual(targets, ["2026-09-22", "2026-09-22"])
                self.assertEqual(before, {p.name: p.read_bytes() for p in (root / "data").iterdir()})

    def test_waiting_retries_frozen_target_and_preserves_last_good_bytes(self):
        self.run_scenario(False)

    def test_only_validated_candidate_is_promoted(self):
        self.run_scenario(True)
