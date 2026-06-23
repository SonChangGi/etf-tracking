import importlib.util
import json
import re
import sys
import tempfile
import unittest
from unittest import mock
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

    def test_time_nav_date_is_not_future_for_historical_request(self):
        html = (ROOT / "tests" / "fixtures" / "time-2.html").read_text(encoding="utf-8")
        historical_html = html.replace('value="2026-06-17"', 'value="2026-06-10"', 1)
        parsed = update_data.parse_time_page(historical_html, update_data.ETFS[0], requested_date="2026-06-10")
        self.assertEqual(parsed["asOfDate"], "2026-06-10")
        self.assertIsNone(parsed["navAsOfDate"])
        self.assertEqual(parsed["priceBasisDate"], "2026-06-09")

    def test_time_requested_date_mismatch_is_stale(self):
        html = (ROOT / "tests" / "fixtures" / "time-2.html").read_text(encoding="utf-8")
        parsed = update_data.parse_time_page(html, update_data.ETFS[0], requested_date="2026-06-10")
        self.assertEqual(parsed["asOfDate"], "2026-06-17")
        self.assertEqual(parsed["sourceStatus"], "stale")
        self.assertIn("Requested 2026-06-10", parsed["sourceWarning"])

    def test_parse_samsung_payload_extracts_pdf_rows_without_cash(self):
        payload = json.loads((ROOT / "tests" / "fixtures" / "samsung-2ETFQ1.json").read_text(encoding="utf-8"))
        parsed = update_data.parse_samsung_payload(payload, update_data.ETFS[2], requested_date="2026-06-17")
        self.assertEqual(parsed["asOfDate"], "2026-06-17")
        self.assertEqual(parsed["listingDate"], "2025-02-25")
        self.assertEqual(parsed["sourceStatus"], "live")
        self.assertEqual(parsed["top10"][0]["ticker"], None)
        self.assertEqual(parsed["top10"][0]["priceTrackingMethod"], "provider_valuation_krw")
        self.assertTrue(parsed["top10"][0]["isPriceTracked"])
        self.assertEqual(parsed["top10"][1]["ticker"], "AMD")

    def test_snapshot_history_preserves_full_holdings_not_only_top10(self):
        raw = {
            "asOfDate": "2026-06-17",
            "queryDate": "2026-06-17",
            "sourceStatus": "live",
            "sourceConfidence": "high",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 11, "ticker": "CCC", "name": "Gamma", "weightPercent": 2.0},
            ],
            "top10": [{"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0}],
            "totalHoldings": 2,
        }
        snap = update_data.snapshot_for_history(raw)
        self.assertEqual(len(snap["holdings"]), 2)
        self.assertEqual(snap["holdings"][1]["rank"], 11)

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
        self.assertEqual(by_ticker["AAA"]["actionLabel"], "매수 가능성")
        self.assertEqual(by_ticker["CCC"]["classification"], "new_entry")
        self.assertTrue(any(signal["type"] == "top10_entry" for signal in signals))
        self.assertEqual(summary["returnCoverageUniverse"], "top10_fallback")
        self.assertFalse(summary["fullHoldingsAvailable"])
        self.assertFalse(summary["previousFullHoldingsAvailable"])

    def test_decomposition_uses_full_holdings_for_top10_entry_and_exit(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        previous = {
            "date": "2026-06-16",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 10.0},
                {"rank": 11, "ticker": "CCC", "name": "Gamma", "weightPercent": 2.0},
            ],
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 10.0},
            ],
        }
        current = {
            "date": "2026-06-17",
            "holdings": [
                {"rank": 1, "ticker": "BBB", "name": "Beta", "weightPercent": 9.5},
                {"rank": 2, "ticker": "CCC", "name": "Gamma", "weightPercent": 3.0},
                {"rank": 11, "ticker": "AAA", "name": "Alpha", "weightPercent": 8.0},
            ],
            "top10": [
                {"rank": 1, "ticker": "BBB", "name": "Beta", "weightPercent": 9.5},
                {"rank": 2, "ticker": "CCC", "name": "Gamma", "weightPercent": 3.0},
            ],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        by_ticker = {row.get("ticker"): row for row in rows}
        self.assertEqual(summary["returnCoverageUniverse"], "full_holdings")
        self.assertAlmostEqual(summary["validReturnWeightPercent"], 22.0)
        self.assertAlmostEqual(summary["totalReturnWeightPercent"], 22.0)
        self.assertEqual(by_ticker["AAA"]["actualWeightPercent"], 8.0)
        self.assertEqual(by_ticker["AAA"]["rank"], 11)
        self.assertEqual(by_ticker["AAA"]["membershipChange"], "top10_exit")
        self.assertNotEqual(by_ticker["AAA"]["classification"], "fund_exit")
        self.assertEqual(by_ticker["CCC"]["previousWeightPercent"], 2.0)
        self.assertEqual(by_ticker["CCC"]["previousRank"], 11)
        self.assertEqual(by_ticker["CCC"]["membershipChange"], "top10_entry")
        self.assertNotEqual(by_ticker["CCC"]["classification"], "new_entry")
        self.assertTrue(any(signal["type"] == "top10_exit" and signal["ticker"] == "AAA" for signal in signals))
        self.assertTrue(any(signal["type"] == "top10_entry" and signal["ticker"] == "CCC" for signal in signals))

    def test_non_top10_holding_uses_external_price_in_full_benchmark(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        previous = {
            "date": "2026-06-16",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 12, "ticker": "DDD", "name": "Delta", "weightPercent": 10.0},
            ],
            "top10": [{"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0}],
        }
        current = {
            "date": "2026-06-17",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 12, "ticker": "DDD", "name": "Delta", "weightPercent": 10.0},
            ],
            "top10": [{"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0}],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        self.assertAlmostEqual(summary["benchmarkReturn"], 0.55)
        self.assertEqual(summary["returnCoverageUniverse"], "full_holdings")

    def test_provider_valuation_return_prevents_false_missing_close(self):
        provider = update_data.PriceProvider(no_live=True)
        previous = {
            "date": "2026-06-16",
            "priceBasisDate": "2026-06-16",
            "holdings": [{"rank": 1, "ticker": "NOQUOTE", "name": "No Quote", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0}],
            "top10": [{"rank": 1, "ticker": "NOQUOTE", "name": "No Quote", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0}],
        }
        current = {
            "date": "2026-06-17",
            "priceBasisDate": "2026-06-17",
            "holdings": [{"rank": 1, "ticker": "NOQUOTE", "name": "No Quote", "shares": 10, "marketValueKrw": 1100, "weightPercent": 10.0}],
            "top10": [{"rank": 1, "ticker": "NOQUOTE", "name": "No Quote", "shares": 10, "marketValueKrw": 1100, "weightPercent": 10.0}],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        self.assertEqual(summary["returnCoverageStatus"], "ok")
        self.assertAlmostEqual(rows[0]["securityReturn"], 0.1)
        self.assertEqual(rows[0]["priceSource"], "provider_valuation_krw")
        self.assertNotEqual(rows[0]["classification"], "insufficient_data")

    def test_provider_valuation_krw_is_preferred_for_weight_attribution(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        previous = {
            "date": "2026-06-16",
            "priceBasisDate": "2026-06-16",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0},
            ],
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0},
            ],
        }
        current = {
            "date": "2026-06-17",
            "priceBasisDate": "2026-06-17",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "shares": 10, "marketValueKrw": 1100, "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0},
            ],
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "shares": 10, "marketValueKrw": 1100, "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "shares": 10, "marketValueKrw": 1000, "weightPercent": 10.0},
            ],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        by_ticker = {row.get("ticker"): row for row in rows}
        self.assertAlmostEqual(by_ticker["AAA"]["securityReturn"], 0.1)
        self.assertEqual(by_ticker["AAA"]["priceSource"], "provider_valuation_krw")
        self.assertEqual(by_ticker["AAA"]["priceSourceType"], "etf_provider_unit_value_krw")
        self.assertAlmostEqual(summary["benchmarkReturn"], 0.05)

    def test_no_trade_weight_formula_is_exact_against_priced_benchmark(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        previous = {
            "date": "2026-06-16",
            "priceBasisDate": "2026-06-16",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 90.0},
            ],
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 10.0},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 90.0},
            ],
        }
        benchmark_return = 0.01
        predicted_alpha = 10.0 * (1 + 0.10) / (1 + benchmark_return)
        current = {
            "date": "2026-06-17",
            "priceBasisDate": "2026-06-17",
            "holdings": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": predicted_alpha},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 100.0 - predicted_alpha},
            ],
            "top10": [
                {"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": predicted_alpha},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 100.0 - predicted_alpha},
            ],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        alpha = next(row for row in rows if row.get("ticker") == "AAA")
        self.assertAlmostEqual(summary["benchmarkReturn"], benchmark_return)
        self.assertAlmostEqual(alpha["predictedWeightPercent"], predicted_alpha)
        self.assertAlmostEqual(alpha["deltaResidualPercentPoint"], 0.0)
        self.assertEqual(alpha["classification"], "price_aligned")
        self.assertEqual(alpha["residualBand"], "price_aligned")
        self.assertFalse(any(signal["type"] in {"likely_buy", "likely_sell"} for signal in signals))

    def test_mid_sized_residual_is_watch_not_fully_price_explained_or_sell(self):
        fixture_dir = ROOT / "tests" / "fixtures"
        provider = update_data.PriceProvider(fixture_dir=fixture_dir)
        previous = {
            "date": "2026-06-16",
            "priceBasisDate": "2026-06-16",
            "holdings": [
                {"rank": 1, "ticker": "SNDK", "name": "Sandisk", "weightPercent": 3.75},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 96.25},
            ],
            "top10": [
                {"rank": 1, "ticker": "SNDK", "name": "Sandisk", "weightPercent": 3.75},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 96.25},
            ],
        }
        sndk_return = (91 / 90) - 1
        benchmark_return = 3.75 * sndk_return / 100
        predicted_sndk = 3.75 * (1 + sndk_return) / (1 + benchmark_return)
        current_sndk = predicted_sndk - 0.26
        current = {
            "date": "2026-06-17",
            "priceBasisDate": "2026-06-17",
            "holdings": [
                {"rank": 1, "ticker": "SNDK", "name": "Sandisk", "weightPercent": current_sndk},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 100.0 - current_sndk},
            ],
            "top10": [
                {"rank": 1, "ticker": "SNDK", "name": "Sandisk", "weightPercent": current_sndk},
                {"rank": 2, "ticker": "BBB", "name": "Beta", "weightPercent": 100.0 - current_sndk},
            ],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        sndk = next(row for row in rows if row.get("ticker") == "SNDK")
        self.assertAlmostEqual(summary["benchmarkReturn"], benchmark_return)
        self.assertAlmostEqual(sndk["deltaResidualPercentPoint"], -0.26)
        self.assertGreater(abs(sndk["deltaResidualPercentPoint"]), sndk["priceAlignedTolerancePercentPoint"])
        self.assertLess(abs(sndk["deltaResidualPercentPoint"]), sndk["residualActionTolerancePercentPoint"])
        self.assertEqual(sndk["classification"], "residual_watch")
        self.assertEqual(sndk["actionEstimate"], "weak_sell_watch")
        self.assertEqual(sndk["actionLabel"], "약한 매도·축소 관찰")
        self.assertIn("추정 임계치에는 미달", sndk["actionExplanation"])
        self.assertNotEqual(sndk["classification"], "likely_sell")
        self.assertFalse(any(signal["type"] == "likely_sell" and signal["ticker"] == "SNDK" for signal in signals))
        self.assertTrue(any(signal["type"] == "residual_watch" and signal["actionLabel"] == "약한 매도·축소 관찰" for signal in signals))

    def test_usd_external_close_is_fx_adjusted_to_krw_return(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture_dir = Path(temp)
            (fixture_dir / "prices.json").write_text(json.dumps({
                "closes": {
                    "AAA": {"2026-06-16": 100, "2026-06-17": 110},
                    "USDKRW": {"2026-06-16": 1300, "2026-06-17": 1430},
                }
            }), encoding="utf-8")
            provider = update_data.PriceProvider(fixture_dir=fixture_dir)
            value, meta = provider.return_between_krw("AAA", "2026-06-16", "2026-06-17")
        self.assertAlmostEqual(value, 0.21)
        self.assertEqual(meta["sourceType"], "external_close_fx_adjusted_krw")
        self.assertEqual(meta["currency"], "USD")
        self.assertTrue(meta["fxApplied"])
        self.assertAlmostEqual(meta["localCurrencyReturn"], 0.10)
        self.assertAlmostEqual(meta["fxReturn"], 0.10)

    def test_missing_fx_keeps_usd_return_but_marks_low_confidence_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            fixture_dir = Path(temp)
            (fixture_dir / "prices.json").write_text(json.dumps({
                "closes": {
                    "AAA": {"2026-06-16": 100, "2026-06-17": 110}
                }
            }), encoding="utf-8")
            provider = update_data.PriceProvider(fixture_dir=fixture_dir)
            value, meta = provider.return_between_krw("AAA", "2026-06-16", "2026-06-17")
        self.assertAlmostEqual(value, 0.10)
        self.assertEqual(meta["sourceType"], "external_close_local_currency")
        self.assertTrue(meta["fxRequired"])
        self.assertFalse(meta["fxApplied"])

    def test_decomposition_exports_code_raw_and_resolved_date_basis_for_ui_join(self):
        provider = update_data.PriceProvider(no_live=True)
        previous = {
            "date": "2026-06-16",
            "priceBasisDate": "2026-06-15",
            "holdings": [{"rank": 11, "codeRaw": "SPCX US EQUITY", "ticker": None, "name": "Space Exploration Technologies Corp", "shares": 2, "marketValueKrw": 1000, "weightPercent": 2.0}],
            "top10": [],
        }
        current = {
            "date": "2026-06-17",
            "priceBasisDate": "2026-06-16",
            "holdings": [{"rank": 10, "codeRaw": "SPCX US EQUITY", "ticker": None, "name": "Space Exploration Technologies Corp", "shares": 2, "marketValueKrw": 1200, "weightPercent": 3.0}],
            "top10": [{"rank": 10, "codeRaw": "SPCX US EQUITY", "ticker": None, "name": "Space Exploration Technologies Corp", "shares": 2, "marketValueKrw": 1200, "weightPercent": 3.0}],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        self.assertEqual(rows[0]["codeRaw"], "SPCX US EQUITY")
        self.assertEqual(rows[0]["membershipChange"], "top10_entry")
        self.assertEqual(rows[0]["priceReturnStartDate"], "2026-06-15")
        self.assertEqual(rows[0]["priceReturnEndDate"], "2026-06-16")
        self.assertEqual(summary["dateBasis"]["previousPriceBasisDate"], "2026-06-15")
        self.assertEqual(summary["dateBasis"]["currentPriceBasisDate"], "2026-06-16")

    def test_stooq_csv_parser_and_symbol_candidates(self):
        csv_text = "Date,Open,High,Low,Close,Volume\n2026-06-16,1,2,1,10.5,100\n2026-06-17,1,2,1,11.0,110\n"
        self.assertEqual(update_data.parse_stooq_csv(csv_text), {"2026-06-16": 10.5, "2026-06-17": 11.0})
        self.assertIn("aapl.us", update_data.stooq_symbol_candidates("AAPL"))
        self.assertIn("285a.jp", update_data.stooq_symbol_candidates("285A.T"))

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
        snap = {"date": "2026-06-17", "sourceStatus": "live", "top10": [{"ticker": "AAA", "weightPercent": 1}]}
        once = update_data.merge_history(existing, {update_data.ETFS[0].id: [snap]})
        twice = update_data.merge_history(once, {update_data.ETFS[0].id: [snap]})
        self.assertEqual(len(twice[update_data.ETFS[0].id]), 1)

    def test_stale_snapshot_does_not_overwrite_live_history(self):
        config_id = update_data.ETFS[0].id
        existing = {cfg.id: [] for cfg in update_data.ETFS}
        existing[config_id] = [{
            "date": "2026-06-17",
            "queryDate": "2026-06-17",
            "sourceStatus": "live",
            "top10": [{"ticker": "LIVE", "weightPercent": 1.0}],
        }]
        stale = {
            "date": "2026-06-17",
            "sourceStatus": "stale",
            "top10": [{"ticker": "STALE", "weightPercent": 99.0}],
        }
        merged = update_data.merge_history(existing, {config_id: [stale]})
        self.assertEqual(merged[config_id][0]["top10"][0]["ticker"], "LIVE")

    def test_merge_drops_existing_live_snapshot_when_query_date_mismatches(self):
        config_id = update_data.ETFS[0].id
        existing = {cfg.id: [] for cfg in update_data.ETFS}
        existing[config_id] = [{
            "date": "2026-06-17",
            "queryDate": "2026-06-10",
            "sourceStatus": "live",
            "top10": [{"ticker": "BAD", "weightPercent": 99.0}],
        }]
        merged = update_data.merge_history(existing, {config_id: []})
        self.assertEqual(merged[config_id], [])

    def test_collect_rejects_fixture_when_provider_date_mismatches_target(self):
        class Args:
            fixture_dir = ROOT / "tests" / "fixtures"
            target_date = "2026-06-10"
            backfill_all = False
            backfill_days = 1
            backfill_start_date = None
            refresh_existing = True
            include_empty = False
            provider_delay = 0

        snapshots, diagnostics = update_data.collect_snapshots(Args)
        first_id = update_data.ETFS[0].id
        self.assertEqual(snapshots[first_id], [])
        self.assertEqual(diagnostics[first_id][0]["sourceStatus"], "stale")
        self.assertEqual(diagnostics[first_id][0]["dateMismatch"]["targetDate"], "2026-06-10")

    def test_bounded_backfill_start_date_and_target_priority(self):
        config = update_data.ETFS[0]
        dates = update_data.dates_to_fetch(
            config,
            "2026-06-17",
            backfill_all=False,
            backfill_days=1,
            backfill_start_date="2026-06-01",
        )
        self.assertEqual(dates[0], "2026-06-01")
        self.assertEqual(dates[-1], "2026-06-17")
        prioritized = update_data.prioritized_fetch_dates(dates, "2026-06-17")
        self.assertEqual(prioritized[0], "2026-06-17")
        self.assertEqual(prioritized[1], "2026-06-01")

    def test_bounded_backfill_respects_listing_date(self):
        config = update_data.ETFS[2]
        dates = update_data.dates_to_fetch(
            config,
            "2025-03-03",
            backfill_all=False,
            backfill_days=1,
            backfill_start_date="2025-01-01",
        )
        self.assertEqual(dates[0], "2025-02-25")

    def test_collect_fixture_snapshots_for_all_etfs(self):
        class Args:
            fixture_dir = ROOT / "tests" / "fixtures"
            target_date = "2026-06-17"
            backfill_all = False
            backfill_days = 1
            backfill_start_date = None
            refresh_existing = False
            include_empty = False
            provider_delay = 0
        snapshots, diagnostics = update_data.collect_snapshots(Args)
        self.assertEqual(set(snapshots), {cfg.id for cfg in update_data.ETFS})
        self.assertEqual(set(diagnostics), {cfg.id for cfg in update_data.ETFS})
        self.assertTrue(all(items and items[0]["top10"] for items in snapshots.values()))
        self.assertTrue(all(items and items[0]["hasTop10"] for items in diagnostics.values()))

    def test_collect_skips_existing_usable_snapshots_by_default(self):
        class Args:
            fixture_dir = ROOT / "tests" / "fixtures"
            target_date = "2026-06-17"
            backfill_all = False
            backfill_days = 1
            backfill_start_date = None
            refresh_existing = False
            include_empty = False
            provider_delay = 0

        existing = {cfg.id: [] for cfg in update_data.ETFS}
        existing[update_data.ETFS[0].id] = [{
            "date": "2026-06-17",
            "queryDate": "2026-06-17",
            "sourceStatus": "live",
            "sourceConfidence": "high",
            "top10": [{"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 1.0}],
            "holdings": [{"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 1.0}],
        }]
        snapshots, diagnostics = update_data.collect_snapshots(Args, existing)
        first_id = update_data.ETFS[0].id
        self.assertEqual(snapshots[first_id], [])
        self.assertEqual(diagnostics[first_id][0]["sourceStatus"], "cached_live")
        self.assertTrue(diagnostics[first_id][0]["skippedFetch"])
        self.assertEqual(diagnostics[first_id][0]["top10Count"], 1)

    def test_collect_skips_compact_existing_snapshot_without_query_date(self):
        class Args:
            fixture_dir = ROOT / "tests" / "fixtures"
            target_date = "2026-06-17"
            backfill_all = False
            backfill_days = 1
            backfill_start_date = None
            refresh_existing = False
            include_empty = False
            provider_delay = 0

        existing = {cfg.id: [] for cfg in update_data.ETFS}
        existing[update_data.ETFS[0].id] = [{
            "date": "2026-06-17",
            "sourceStatus": "live",
            "top10": [{"rank": 1, "ticker": "AAA", "weightPercent": 1.0}],
            "holdings": [{"rank": 1, "ticker": "AAA", "weightPercent": 1.0}],
        }]
        self.assertTrue(update_data.snapshot_has_usable_data(existing[update_data.ETFS[0].id][0], "2026-06-17"))
        snapshots, diagnostics = update_data.collect_snapshots(Args, existing)
        first_id = update_data.ETFS[0].id
        self.assertEqual(snapshots[first_id], [])
        self.assertEqual(diagnostics[first_id][0]["sourceStatus"], "cached_live")
        self.assertTrue(diagnostics[first_id][0]["skippedFetch"])

    def test_collect_refetches_existing_live_snapshot_when_query_date_mismatches(self):
        class Args:
            fixture_dir = ROOT / "tests" / "fixtures"
            target_date = "2026-06-17"
            backfill_all = False
            backfill_days = 1
            backfill_start_date = None
            refresh_existing = False
            include_empty = False
            provider_delay = 0

        existing = {cfg.id: [] for cfg in update_data.ETFS}
        existing[update_data.ETFS[0].id] = [{
            "date": "2026-06-17",
            "queryDate": "2026-06-10",
            "sourceStatus": "live",
            "sourceConfidence": "high",
            "top10": [{"rank": 1, "ticker": "BAD", "name": "Bad", "weightPercent": 99.0}],
            "holdings": [{"rank": 1, "ticker": "BAD", "name": "Bad", "weightPercent": 99.0}],
        }]
        snapshots, diagnostics = update_data.collect_snapshots(Args, existing)
        first_id = update_data.ETFS[0].id
        self.assertTrue(snapshots[first_id])
        self.assertEqual(snapshots[first_id][0]["queryDate"], "2026-06-17")
        self.assertFalse(diagnostics[first_id][0].get("skippedFetch", False))

    def test_refresh_existing_refetches_usable_snapshots(self):
        class Args:
            fixture_dir = ROOT / "tests" / "fixtures"
            target_date = "2026-06-17"
            backfill_all = False
            backfill_days = 1
            backfill_start_date = None
            refresh_existing = True
            include_empty = False
            provider_delay = 0

        existing = {cfg.id: [] for cfg in update_data.ETFS}
        existing[update_data.ETFS[0].id] = [{
            "date": "2026-06-17",
            "sourceStatus": "live",
            "top10": [{"rank": 1, "ticker": "OLD", "name": "Old", "weightPercent": 1.0}],
        }]
        snapshots, diagnostics = update_data.collect_snapshots(Args, existing)
        first_id = update_data.ETFS[0].id
        self.assertTrue(snapshots[first_id])
        self.assertEqual(diagnostics[first_id][0]["sourceStatus"], "live")
        self.assertFalse(diagnostics[first_id][0].get("skippedFetch", False))

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
        self.assertIn("Expected provider/price delays", automation["notificationPolicy"]["workflowDispatch"])
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

    def test_price_diagnostics_are_snapshotted_per_summary(self):
        provider = update_data.PriceProvider(no_live=True)
        previous = {
            "date": "2026-06-16",
            "priceBasisDate": "2026-06-16",
            "top10": [{"rank": 1, "ticker": "MISSING", "name": "Missing", "weightPercent": 10.0}],
        }
        current = {
            "date": "2026-06-17",
            "priceBasisDate": "2026-06-17",
            "top10": [{"rank": 1, "ticker": "MISSING", "name": "Missing", "weightPercent": 10.0}],
        }
        rows, signals, summary = update_data.compute_pair_decomposition(previous, current, provider)
        provider.diagnostics["LATER"] = [{"reason": "later_failure"}]
        provider.errors["LATER"] = "later_failure"
        self.assertIn("MISSING", summary["priceDiagnostics"])
        self.assertNotIn("LATER", summary["priceDiagnostics"])
        self.assertNotIn("LATER", summary["priceErrors"])

    def test_public_snapshot_strips_large_internal_diagnostics(self):
        snap = {
            "date": "2026-06-17",
            "queryDate": "2026-06-17",
            "navAsOfDate": "2026-06-16",
            "sourceConfidence": "high",
            "sourceWarning": "",
            "totalHoldings": 20,
            "fetchedAt": "2026-06-17T00:00:00+00:00",
            "holdings": [{
                "rank": 11,
                "ticker": "AAA",
                "sourceFields": {"raw": "large"},
                "shares": 10,
                "marketValueKrw": 1000,
                "weightPercent": 1.0,
                "priceTrackingMethod": "external_ticker",
            }],
            "top10": [{
                "rank": 1,
                "ticker": "AAA",
                "sourceFields": {"raw": "large"},
                "weightPercent": 1.0,
                "priceTrackingMethod": "external_ticker",
            }],
            "decomposition": [{
                "ticker": "AAA",
                "deltaResidualPercentPoint": 0.1,
                "priceSource": "provider_valuation_krw",
                "priceMeta": {"attempts": [{"large": True}]},
            }],
            "signals": [{"ticker": "AAA", "type": "residual_watch"}],
            "analysisSummary": {
                "returnCoverage": 1.0,
                "returnCoverageStatus": "ok",
                "priceErrors": {"AAA": "missing_close"},
                "priceDiagnostics": {"AAA": [{"huge": True}]},
            },
        }
        public = update_data.public_snapshot(snap)
        self.assertNotIn("queryDate", public)
        self.assertNotIn("navAsOfDate", public)
        self.assertNotIn("sourceConfidence", public)
        self.assertNotIn("sourceWarning", public)
        self.assertNotIn("totalHoldings", public)
        self.assertNotIn("fetchedAt", public)
        self.assertNotIn("sourceFields", public["holdings"][0])
        self.assertNotIn("sourceFields", public["top10"][0])
        self.assertEqual(set(public["holdings"][0]), {"rank", "ticker", "shares", "marketValueKrw", "weightPercent"})
        self.assertEqual(public["holdings"][0]["rank"], 11)
        self.assertEqual(public["holdings"][0]["shares"], 10)
        self.assertNotIn("priceTrackingMethod", public["holdings"][0])
        self.assertEqual(public["top10"][0]["priceTrackingMethod"], "external_ticker")
        self.assertNotIn("priceMeta", public["decomposition"][0])
        self.assertEqual(public["decomposition"][0]["priceSource"], "provider_valuation_krw")
        self.assertEqual(public["analysisSummary"]["returnCoverage"], 1.0)
        self.assertNotIn("priceDiagnostics", public["analysisSummary"])
        self.assertNotIn("priceErrors", public["analysisSummary"])

    def test_stored_snapshot_preserves_replay_metadata_without_heavy_internals(self):
        snap = {
            "date": "2026-06-17",
            "queryDate": "2026-06-17",
            "navAsOfDate": "2026-06-16",
            "sourceConfidence": "high",
            "sourceWarning": "",
            "totalHoldings": 20,
            "fetchedAt": "2026-06-17T00:00:00+00:00",
            "holdings": [{
                "rank": 11,
                "ticker": "AAA",
                "name": "Alpha",
                "codeRaw": "AAA US EQUITY",
                "sourceFields": {"raw": "large"},
                "shares": 10,
                "marketValueKrw": 1000,
                "weightPercent": 1.0,
                "priceTrackingMethod": "external_ticker",
            }],
            "top10": [{
                "rank": 1,
                "ticker": "AAA",
                "name": "Alpha",
                "codeRaw": "AAA US EQUITY",
                "sourceFields": {"raw": "large"},
                "weightPercent": 1.0,
                "priceTrackingMethod": "external_ticker",
            }],
            "decomposition": [{
                "ticker": "AAA",
                "deltaResidualPercentPoint": 0.1,
                "priceSource": "provider_valuation_krw",
                "priceMeta": {"attempts": [{"large": True}]},
            }],
            "analysisSummary": {
                "returnCoverage": 1.0,
                "returnCoverageStatus": "ok",
                "priceErrors": {"AAA": "missing_close"},
                "priceDiagnostics": {"AAA": [{"huge": True}]},
            },
        }
        stored = update_data.stored_snapshot(snap)
        self.assertEqual(stored["queryDate"], "2026-06-17")
        self.assertEqual(stored["navAsOfDate"], "2026-06-16")
        self.assertEqual(stored["sourceConfidence"], "high")
        self.assertEqual(stored["totalHoldings"], 20)
        self.assertEqual(stored["holdings"][0]["name"], "Alpha")
        self.assertEqual(stored["holdings"][0]["codeRaw"], "AAA US EQUITY")
        self.assertEqual(stored["holdings"][0]["priceTrackingMethod"], "external_ticker")
        self.assertNotIn("sourceFields", stored["holdings"][0])
        self.assertNotIn("priceMeta", stored["decomposition"][0])
        self.assertNotIn("priceDiagnostics", stored["analysisSummary"])
        self.assertNotIn("priceErrors", stored["analysisSummary"])

    def test_history_outputs_are_manifest_plus_per_etf_files(self):
        with tempfile.TemporaryDirectory() as temp:
            output_dir = Path(temp)
            history = {cfg.id: [] for cfg in update_data.ETFS}
            history[update_data.ETFS[0].id] = [{
                "date": update_data.ETFS[0].listing_date,
                "queryDate": update_data.ETFS[0].listing_date,
                "sourceStatus": "live",
                "sourceConfidence": "high",
                "top10": [{"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 1.0}],
                "holdings": [{"rank": 1, "ticker": "AAA", "name": "Alpha", "weightPercent": 1.0}],
                "decomposition": [],
                "signals": [],
                "analysisSummary": {"returnCoverage": 1.0, "returnCoverageStatus": "ok"},
            }]
            manifest = update_data.write_history_outputs(output_dir, history, "2026-06-17T00:00:00+00:00")
            manifest_on_disk = json.loads((output_dir / "history.json").read_text(encoding="utf-8"))
            per_etf = json.loads((output_dir / "history" / f"{update_data.ETFS[0].id}.json").read_text(encoding="utf-8"))
            loaded = update_data.load_history(output_dir)
        self.assertIsInstance(manifest["etfs"], list)
        self.assertIsInstance(manifest_on_disk["etfs"], list)
        self.assertEqual(manifest_on_disk["etfs"][0]["historyUrl"], f"data/history/{update_data.ETFS[0].id}.json")
        self.assertNotIn("history", manifest_on_disk["etfs"][0])
        self.assertEqual(per_etf["history"][0]["queryDate"], update_data.ETFS[0].listing_date)
        self.assertEqual(loaded[update_data.ETFS[0].id][0]["queryDate"], update_data.ETFS[0].listing_date)

    def test_write_json_can_compact_large_public_payloads(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "payload.json"
            update_data.write_json(path, {"outer": [{"name": "Alpha", "weight": 1.23}]}, compact=True)
            body = path.read_text(encoding="utf-8")
        self.assertEqual(body, '{"outer":[{"name":"Alpha","weight":1.23}]}\n')

    def test_collect_snapshots_stops_provider_loop_on_rate_limit(self):
        class Args:
            fixture_dir = None
            target_date = "2026-06-17"
            backfill_all = False
            backfill_days = 3
            backfill_start_date = None
            refresh_existing = True
            include_empty = False
            provider_delay = 0

        calls = []

        def fake_fetch(config, target):
            calls.append((config.id, target))
            raise update_data.urllib.error.HTTPError("url", 429, "Too Many Requests", hdrs=None, fp=None)

        with mock.patch.object(update_data, "fetch_snapshot", side_effect=fake_fetch), mock.patch.object(update_data.time, "sleep"):
            snapshots, diagnostics = update_data.collect_snapshots(Args, {cfg.id: [] for cfg in update_data.ETFS})

        self.assertEqual(snapshots[update_data.ETFS[0].id], [])
        self.assertEqual(diagnostics[update_data.ETFS[0].id][0]["sourceStatus"], "rate_limited")
        self.assertEqual(len([call for call in calls if call[0] == update_data.ETFS[0].id]), 1)

    def test_status_ignores_historical_backfill_errors_when_target_is_cached_live(self):
        target = "2026-06-17"
        history = {
            cfg.id: [{
                "date": target,
                "sourceStatus": "live",
                "sourceWarning": "",
                "analysisSummary": {"returnCoverageStatus": "ok", "returnCoverage": 1.0, "priceErrors": {}},
                "top10": [{"ticker": "AAA", "weightPercent": 1}],
            }]
            for cfg in update_data.ETFS
        }
        diagnostics = {
            cfg.id: [
                {"targetDate": target, "date": target, "sourceStatus": "cached_live", "hasTop10": True, "skippedFetch": True},
                {"targetDate": "2025-03-31", "date": "2025-03-31", "sourceStatus": "error", "sourceWarning": "old 429", "hasTop10": False},
                {"targetDate": "2025-04-01", "date": "2025-04-01", "sourceStatus": "rate_limited", "sourceWarning": "old 429", "hasTop10": False},
            ]
            for cfg in update_data.ETFS
        }
        provider = update_data.PriceProvider(no_live=True)
        provider.errors["OLD"] = "historical_missing_close"
        status = update_data.build_status(history, "2026-06-17T00:00:00+00:00", provider, target, diagnostics)
        self.assertEqual(status["overallStatus"], "ok")
        self.assertEqual(status["priceErrorCount"], 0)
        self.assertEqual(update_data.automation_warnings(status), [])
        self.assertEqual(status["etfs"][0]["fetchStats"]["historicalErrors"], 1)
        self.assertEqual(status["etfs"][0]["fetchStats"]["historicalRateLimited"], 1)

    def test_status_splits_target_diagnostics_from_historical_counts(self):
        target = "2026-06-17"
        history = {cfg.id: [] for cfg in update_data.ETFS}
        history[update_data.ETFS[0].id] = [{
            "date": "2026-06-16",
            "sourceStatus": "live",
            "sourceWarning": "",
            "analysisSummary": {"returnCoverageStatus": "ok", "returnCoverage": 1.0},
            "top10": [{"ticker": "AAA", "weightPercent": 1}],
        }]
        diagnostics = {cfg.id: [] for cfg in update_data.ETFS}
        diagnostics[update_data.ETFS[0].id] = [
            {"targetDate": target, "date": target, "sourceStatus": "error", "hasTop10": False},
            {"targetDate": "2026-06-10", "date": "2026-06-10", "sourceStatus": "error", "hasTop10": False},
        ]
        status = update_data.build_status(history, "2026-06-17T00:00:00+00:00", update_data.PriceProvider(no_live=True), target, diagnostics)
        stats = status["etfs"][0]["fetchStats"]
        self.assertEqual(stats["targetErrors"], 1)
        self.assertEqual(stats["historicalErrors"], 1)

    def test_committed_dashboard_latest_decomposition_matches_formula_and_policy(self):
        dashboard = json.loads((ROOT / "data" / "dashboard.json").read_text(encoding="utf-8"))
        summary = json.loads((ROOT / "data" / "summary.json").read_text(encoding="utf-8"))
        self.assertEqual(summary["contract"], "quant-research-summary")
        self.assertEqual(summary["projectId"], "etf")
        self.assertTrue(summary["primaryEntities"])
        self.assertIn("entityKey", summary["primaryEntities"][0])
        self.assertTrue(any("가능성 신호" in text for text in summary["limitations"]))
        seen_formula_row = False
        for etf in dashboard["etfs"]:
            for row in etf["latest"]["decomposition"]:
                required = [
                    row.get("previousWeightPercent"),
                    row.get("securityReturn"),
                    row.get("benchmarkReturn"),
                    row.get("predictedWeightPercent"),
                    row.get("deltaPricePercentPoint"),
                    row.get("deltaResidualPercentPoint"),
                ]
                if any(value is None for value in required):
                    continue
                seen_formula_row = True
                predicted = row["previousWeightPercent"] * (1 + row["securityReturn"]) / (1 + row["benchmarkReturn"])
                self.assertAlmostEqual(row["predictedWeightPercent"], predicted)
                self.assertAlmostEqual(row["deltaPricePercentPoint"], predicted - row["previousWeightPercent"])
                self.assertAlmostEqual(
                    row["deltaResidualPercentPoint"],
                    row["actualWeightPercent"] - row["previousWeightPercent"] - row["deltaPricePercentPoint"],
                )
                residual_abs = abs(row["deltaResidualPercentPoint"])
                aligned = row["priceAlignedTolerancePercentPoint"]
                action = row["residualActionTolerancePercentPoint"]
                if row["classification"] == "price_aligned":
                    self.assertLessEqual(residual_abs, aligned + 1e-9)
                    self.assertNotEqual(row.get("confidence"), "high")
                elif row["classification"] == "residual_watch":
                    self.assertGreater(residual_abs, aligned - 1e-9)
                    self.assertLess(residual_abs, action + 1e-9)
                    self.assertIn(row["actionEstimate"], {"weak_buy_watch", "weak_sell_watch"})
                    self.assertIn("관찰", row["actionLabel"])
                elif row["classification"] == "likely_buy":
                    self.assertGreaterEqual(row["deltaResidualPercentPoint"], action - 1e-9)
                    self.assertEqual(row["actionEstimate"], "likely_buy")
                elif row["classification"] == "likely_sell":
                    self.assertLessEqual(row["deltaResidualPercentPoint"], -action + 1e-9)
                    self.assertEqual(row["actionEstimate"], "likely_sell")
        self.assertTrue(seen_formula_row)

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

    def test_status_reuses_existing_live_target_snapshot_when_refetch_is_throttled(self):
        target = "2026-06-17"
        history = {
            cfg.id: [{
                "date": target,
                "sourceStatus": "live",
                "sourceWarning": "",
                "analysisSummary": {"returnCoverageStatus": "ok", "returnCoverage": 1.0},
                "top10": [{"ticker": "AAA", "weightPercent": 1}],
            }]
            for cfg in update_data.ETFS
        }
        diagnostics = {
            cfg.id: [{
                "targetDate": target,
                "date": target,
                "sourceStatus": "live",
                "sourceWarning": "",
                "hasTop10": True,
            }]
            for cfg in update_data.ETFS
        }
        diagnostics[update_data.ETFS[0].id] = [{
            "targetDate": target,
            "date": target,
            "sourceStatus": "error",
            "sourceWarning": "HTTP Error 429: Too Many Requests",
            "hasTop10": False,
        }]
        status = update_data.build_status(history, "2026-06-17T00:00:00+00:00", update_data.PriceProvider(no_live=True), target, diagnostics)
        self.assertEqual(status["overallStatus"], "ok")
        self.assertEqual(status["etfs"][0]["targetFetchStatus"], "cached_live")
        self.assertTrue(status["etfs"][0]["reusedExistingTargetSnapshot"])
        self.assertEqual(update_data.automation_warnings(status), [])

    def test_workflow_has_scheduled_refresh_with_safe_commit_gates(self):
        workflow = (ROOT / ".github" / "workflows" / "update-data.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("schedule:", workflow)
        for cron in ['cron: "0 0 * * 2-6"', 'cron: "0 3 * * 2-6"', 'cron: "0 9 * * 2-6"']:
            self.assertIn(cron, workflow)
        self.assertIn("09:00 KST Tue-Sat", workflow)
        self.assertIn("--soft-fail", workflow)
        self.assertIn("strict_validation", workflow)
        self.assertIn("backfill_start_date", workflow)
        self.assertIn("--backfill-start-date", workflow)
        self.assertIn("refresh_existing", workflow)
        self.assertIn("--refresh-existing", workflow)
        self.assertIn("continue-on-error", workflow)
        self.assertIn("safe_to_commit", workflow)
        self.assertIn('run_status == "ok"', workflow)
        self.assertIn("scheduled and reviewed manual provider refreshes", workflow)
        self.assertFalse((ROOT / ".github" / "workflows" / "deploy-pages.yml").exists())



class WorkflowStrictValidationTests(unittest.TestCase):
    def test_manual_strict_validation_defaults_to_true(self):
        workflow = (ROOT / ".github" / "workflows" / "update-data.yml").read_text(encoding="utf-8")
        strict_block = re.search(r"strict_validation:\n(?P<body>(?:        .+\n)+)", workflow)
        self.assertIsNotNone(strict_block, "strict_validation input should exist")
        self.assertIn("default: 'true'", strict_block.group("body"))
        self.assertIn("set false only for diagnostics", strict_block.group("body"))

    def test_strict_manual_gate_covers_update_verify_assess_and_commit(self):
        workflow = (ROOT / ".github" / "workflows" / "update-data.yml").read_text(encoding="utf-8")
        self.assertIn("inputs.strict_validation == 'true'", workflow)
        self.assertIn("steps.update.outcome != 'success'", workflow)
        self.assertIn("steps.verify.outcome != 'success'", workflow)
        self.assertIn("steps.assess.outputs.safe_to_commit != 'true'", workflow)
        self.assertIn("steps.commit-data.outcome == 'failure'", workflow)


if __name__ == "__main__":
    unittest.main()
