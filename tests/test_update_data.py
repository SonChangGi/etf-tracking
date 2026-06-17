import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("update_data", ROOT / "scripts" / "update_data.py")
update_data = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = update_data
SPEC.loader.exec_module(update_data)


class UpdateDataTests(unittest.TestCase):
    def test_ticker_normalization(self):
        self.assertEqual(update_data.normalize_ticker("MU US EQUITY", "Micron"), "MU")
        self.assertEqual(update_data.normalize_ticker("285A JP EQUITY", "Kioxia"), "285A.T")
        self.assertEqual(update_data.normalize_ticker("700 HK EQUITY", "Tencent"), "0700.HK")
        self.assertIsNone(update_data.normalize_ticker("NQU6 INDEX", "NASDAQ 100 E-MINI INDEX SEPT 2026"))
        self.assertIsNone(update_data.normalize_ticker("SPCX US Equity", "Space Exploration Technologies Corp"))

    def test_parse_time_page_extracts_holdings_and_dates(self):
        html = (ROOT / "tests" / "fixtures" / "time-2.html").read_text(encoding="utf-8")
        parsed = update_data.parse_time_page(html, update_data.ETFS[0], requested_date="2026-06-17")
        self.assertEqual(parsed["asOfDate"], "2026-06-17")
        self.assertEqual(parsed["listingDate"], "2022-05-11")
        self.assertEqual(parsed["navAsOfDate"], "2026-06-16")
        self.assertEqual(parsed["sourceStatus"], "live")
        self.assertEqual(parsed["top10"][0]["ticker"], "MU")
        self.assertAlmostEqual(parsed["top10"][0]["weightPercent"], 6.73)

    def test_parse_samsung_payload_extracts_pdf_rows_without_cash(self):
        payload = json.loads((ROOT / "tests" / "fixtures" / "samsung-2ETFQ1.json").read_text(encoding="utf-8"))
        parsed = update_data.parse_samsung_payload(payload, update_data.ETFS[2], requested_date="2026-06-17")
        self.assertEqual(parsed["asOfDate"], "2026-06-17")
        self.assertEqual(parsed["listingDate"], "2025-02-25")
        self.assertEqual(parsed["sourceStatus"], "live")
        self.assertEqual(parsed["top10"][0]["ticker"], None)
        self.assertEqual(parsed["top10"][1]["ticker"], "AMD")

    def test_decomposition_classifies_residual_buy_and_entries(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        previous = {
            "date": "2026-06-16",
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 10.0},
            ],
        }
        current = {
            "date": "2026-06-17",
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 12.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 9.5},
                {"rank": 3, "ticker": "CCC", "name": "Gamma", "weightPercent": 3.0},
            ],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        by_ticker = {row.get("ticker"): row for row in rows}
        self.assertEqual(summary["returnCoverageStatus"], "ok")
        self.assertEqual(by_ticker["AAA"]["classification"], "likely_buy")
        self.assertEqual(by_ticker["CCC"]["classification"], "new_entry")
        self.assertTrue(any(signal["type"] == "top10_entry" for signal in signals))

    def test_low_return_coverage_forces_mixed_signal(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        previous = {
            "date": "2026-06-16",
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 2, "ticker": "MISSING", "name": "Missing", "weightPercent": 20.0},
            ],
        }
        current = {
            "date": "2026-06-17",
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 12.0},
                {"rank": 2, "ticker": "MISSING", "name": "Missing", "weightPercent": 19.0},
            ],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        self.assertEqual(summary["returnCoverageStatus"], "low")
        alpha = next(row for row in rows if row.get("ticker") == "AAA")
        self.assertEqual(alpha["classification"], "mixed")

    def test_history_merge_is_idempotent(self):
        existing = {cfg.id: [] for cfg in update_data.ETFS}
        snap = {"date": "2026-06-17", "top10": [{"ticker": "AAA", "weightPercent": 1}]}
        once = update_data.merge_history(existing, {update_data.ETFS[0].id: [snap]})
        twice = update_data.merge_history(once, {update_data.ETFS[0].id: [snap]})
        self.assertEqual(len(twice[update_data.ETFS[0].id]), 1)

    def test_collect_fixture_snapshots_for_all_etfs(self):
        class Args:
            fixture_dir = ROOT / "tests" / "fixtures"
            target_date = "2026-06-17"
            backfill_all = False
            backfill_days = 1
            include_empty = False
            provider_delay = 0
        snapshots, diagnostics = update_data.collect_snapshots(Args)
        self.assertEqual(set(snapshots), {cfg.id for cfg in update_data.ETFS})
        self.assertEqual(set(diagnostics), {cfg.id for cfg in update_data.ETFS})
        self.assertTrue(all(items and items[0]["top10"] for items in snapshots.values()))
        self.assertTrue(all(items and items[0]["hasTop10"] for items in diagnostics.values()))

    def test_automation_status_records_waiting_without_failure_email_policy(self):
        status = update_data.build_failure_status("2026-06-17T00:00:00+00:00", "2026-06-17", "provider timeout")
        automation = update_data.build_automation_status(
            status,
            "2026-06-17T00:00:00+00:00",
            "2026-06-17",
            run_status="soft_failed",
            error="provider timeout",
        )
        self.assertEqual(automation["runStatus"], "soft_failed")
        self.assertGreaterEqual(automation["warningCount"], 3)
        self.assertIn("Expected provider/price delays", automation["notificationPolicy"]["scheduledWorkflow"])
        self.assertEqual(automation["error"], "provider timeout")

    def test_stale_same_close_does_not_count_as_return_coverage(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        value, meta = provider.return_between("STALE", "2026-06-16", "2026-06-17")
        self.assertIsNone(value)
        self.assertEqual(meta["reason"], "stale_close")

        previous = {
            "date": "2026-06-16",
            "priceBasisDate": "2026-06-16",
            "top10": [{"rank": 1, "ticker": "STALE", "name": "Stale", "weightPercent": 10.0}],
        }
        current = {
            "date": "2026-06-17",
            "priceBasisDate": "2026-06-17",
            "top10": [{"rank": 1, "ticker": "STALE", "name": "Stale", "weightPercent": 10.5}],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        self.assertEqual(summary["returnCoverage"], 0)
        self.assertEqual(summary["returnCoverageStatus"], "low")
        self.assertEqual(rows[0]["classification"], "insufficient_data")

    def test_status_waits_when_target_fetch_failed_despite_old_live_snapshot(self):
        history = {cfg.id: [] for cfg in update_data.ETFS}
        history[update_data.ETFS[0].id] = [{
            "date": "2026-06-16",
            "sourceStatus": "live",
            "sourceWarning": "",
            "analysisSummary": {"returnCoverageStatus": "ok", "returnCoverage": 1.0},
            "top10": [{"ticker": "AAA", "weightPercent": 1}],
        }]
        diagnostics = {cfg.id: [] for cfg in update_data.ETFS}
        diagnostics[update_data.ETFS[0].id] = [{
            "targetDate": "2026-06-17",
            "date": "2026-06-17",
            "sourceStatus": "error",
            "sourceWarning": "provider failed",
            "hasTop10": False,
        }]
        status = update_data.build_status(history, "2026-06-17T00:00:00+00:00", update_data.PriceProvider(no_live=True), "2026-06-17", diagnostics)
        self.assertEqual(status["overallStatus"], "waiting_for_prior_close")
        first = status["etfs"][0]
        self.assertEqual(first["targetFetchStatus"], "error")
        self.assertEqual(first["latestDate"], "2026-06-16")

    def test_workflow_contains_exact_retry_crons(self):
        workflow = (ROOT / ".github" / "workflows" / "update-data.yml").read_text(encoding="utf-8")
        for cron in ["5 23 * * 0-5", "30 0 * * 1-6", "0 2 * * 1-6", "0 4 * * 1-6"]:
            self.assertIn(cron, workflow)
        self.assertIn("--soft-fail", workflow)
        self.assertIn("strict_validation", workflow)
        self.assertIn("continue-on-error", workflow)
        self.assertIn("safe_to_commit", workflow)
        self.assertFalse((ROOT / ".github" / "workflows" / "deploy-pages.yml").exists())


if __name__ == "__main__":
    unittest.main()
