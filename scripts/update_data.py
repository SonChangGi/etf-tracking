#!/usr/bin/env python3
"""Build static ETF TOP10 tracking data.

The updater is intentionally dependency-free so GitHub Actions can run it on a
plain Python image.  It reads provider public pages/APIs, keeps an idempotent
history file, and emits JSON optimized for a static dashboard.
"""
from __future__ import annotations

import argparse
import calendar
import copy
import csv
import dataclasses
import datetime as dt
import html
import importlib
import io
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

KST = dt.timezone(dt.timedelta(hours=9), name="KST")
USER_AGENT = "Mozilla/5.0 (compatible; ETFTrackingBot/0.1; +https://sonchanggi.github.io/etf-tracking/)"
SCHEMA_VERSION = "1.1.1"
DEFAULT_SCHEDULED_BACKFILL_DAYS = 10
PRICE_EXPLAINED_TOLERANCE_PP = 0.20
PRICE_EXPLAINED_TOLERANCE_RATIO = 0.10
RETURN_COVERAGE_MIN = 0.60
HTTP_MAX_BYTES = 5_000_000
PRICE_CACHE_FORWARD_DAYS = 21


@dataclasses.dataclass(frozen=True)
class EtfConfig:
    id: str
    name: str
    short_name: str
    code: str
    provider: str
    source_url: str
    listing_date: str
    provider_kind: str
    idx: str | None = None
    cate: str | None = None
    f_id: str | None = None


ETFS: tuple[EtfConfig, ...] = (
    EtfConfig(
        id="time-nasdaq100-active",
        name="TIME 미국나스닥100액티브",
        short_name="TIME 나스닥100",
        code="426030",
        provider="TIME ETF",
        source_url="https://timeetf.co.kr/m11_view.php?idx=2&cate=001",
        listing_date="2022-05-11",
        provider_kind="time",
        idx="2",
        cate="001",
    ),
    EtfConfig(
        id="time-global-ai-active",
        name="TIME 글로벌AI인공지능액티브",
        short_name="TIME 글로벌AI",
        code="456600",
        provider="TIME ETF",
        source_url="https://timeetf.co.kr/m11_view.php?idx=6&cate=001",
        listing_date="2023-05-16",
        provider_kind="time",
        idx="6",
        cate="001",
    ),
    EtfConfig(
        id="koact-nasdaq-growth-active",
        name="KoAct 미국나스닥성장기업액티브",
        short_name="KoAct 나스닥성장",
        code="2ETFQ1",
        provider="삼성액티브자산운용",
        source_url="https://www.samsungactive.co.kr/etf/view.do?id=2ETFQ1",
        listing_date="2025-02-25",
        provider_kind="samsung",
        f_id="2ETFQ1",
    ),
)

TICKER_ALIASES = {
    "ALPHABET INC-CL A": "GOOGL",
    "ALPHABET INC-C": "GOOG",
    "ADVANCED MICRO DEVICES": "AMD",
    "BLOOM ENERGY CORPORATION": "BE",
    "BROADCOM LTD": "AVGO",
    "BROADCOM INC": "AVGO",
    "MICRON TECH": "MU",
    "TESLA MOTORS": "TSLA",
    "NETFLIX": "NFLX",
    "SPACE EXPLORATION TECHNOLOGIES CORP": None,
    "SPACE EXPLORATION TECHNOLOGIES": None,
}

NON_PRICE_TOKENS = (
    "CASH",
    "현금",
    "원화",
    "설정현금",
    "INDEX",
    "FUTURE",
    "FUTURES",
    "E-MINI",
    "KRW",
)


def clean_text(value: Any) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def parse_number(value: Any) -> float | None:
    if value is None:
        return None
    text = clean_text(value).replace(",", "").replace("%", "").strip()
    if text in {"", "-", "nan", "None"}:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def parse_intish(value: Any) -> float | None:
    number = parse_number(value)
    return number


def iso_date(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 8:
        return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}"
    if re.match(r"^\d{4}-\d{2}-\d{2}$", value or ""):
        return value
    raise ValueError(f"Unsupported date: {value!r}")


def compact_date(value: str) -> str:
    return iso_date(value).replace("-", "")


def today_kst() -> str:
    return dt.datetime.now(KST).date().isoformat()


def date_range_days(start: str, end: str) -> Iterable[str]:
    current = dt.date.fromisoformat(start)
    final = dt.date.fromisoformat(end)
    while current <= final:
        yield current.isoformat()
        current += dt.timedelta(days=1)


def is_weekday(date_text: str) -> bool:
    return dt.date.fromisoformat(date_text).weekday() < 5


def previous_weekday(date_text: str) -> str:
    current = dt.date.fromisoformat(date_text) - dt.timedelta(days=1)
    while current.weekday() >= 5:
        current -= dt.timedelta(days=1)
    return current.isoformat()


def http_get(url: str, *, accept: str = "text/html,application/json", timeout: int = 25, max_bytes: int = HTTP_MAX_BYTES) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": accept,
            "Referer": "https://sonchanggi.github.io/etf-tracking/",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > max_bytes:
            raise ValueError(f"response_too_large: {content_length} bytes from {url}")
        charset = response.headers.get_content_charset() or "utf-8"
        data = response.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError(f"response_too_large: exceeded {max_bytes} bytes from {url}")
        return data.decode(charset, errors="replace")


def normalize_ticker(code_or_name: str | None, name: str | None = None) -> str | None:
    raw = clean_text(code_or_name or "")
    nm = clean_text(name or "")
    upper_raw = raw.upper()
    upper_name = nm.upper()
    for token in NON_PRICE_TOKENS:
        if token in upper_raw or token in upper_name:
            return None
    if upper_name in TICKER_ALIASES:
        return TICKER_ALIASES[upper_name]

    # Bloomberg-ish provider codes, e.g. "MU US EQUITY" or "285A JP Equity".
    parts = upper_raw.split()
    if len(parts) >= 2:
        symbol, market = parts[0], parts[1]
        if market == "US":
            return symbol.replace("/", "-")
        if market == "JP":
            return f"{symbol}.T"
        if market == "HK":
            return f"{symbol.zfill(4)}.HK" if symbol.isdigit() else f"{symbol}.HK"
        if market == "KS":
            return f"{symbol}.KS"
        if market == "KQ":
            return f"{symbol}.KQ"
        if market == "CN":
            return f"{symbol}.SS"
    # Plain US-style ticker fallback.
    if re.match(r"^[A-Z]{1,5}([.-][A-Z])?$", upper_raw):
        return upper_raw.replace(".", "-")
    return TICKER_ALIASES.get(upper_name)


def holding_key(row: dict[str, Any]) -> str:
    return str(row.get("ticker") or row.get("codeRaw") or row.get("name") or "").upper()


def all_holdings(snapshot: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not snapshot:
        return []
    holdings = snapshot.get("holdings")
    if isinstance(holdings, list) and holdings:
        return [row for row in holdings if isinstance(row, dict)]
    top10 = snapshot.get("top10")
    if isinstance(top10, list):
        return [row for row in top10 if isinstance(row, dict)]
    return []


def ranked_map(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = holding_key(row)
        if key and key not in out:
            out[key] = row
    return out


def make_holding(rank: int, code_raw: str, name: str, shares: Any, market_value: Any, weight_percent: Any, *, source_fields: dict[str, Any] | None = None) -> dict[str, Any]:
    weight = parse_number(weight_percent)
    ticker = normalize_ticker(code_raw, name)
    parsed_shares = parse_intish(shares)
    parsed_market_value = parse_intish(market_value)
    has_provider_valuation = bool(parsed_shares and parsed_market_value and parsed_shares > 0 and parsed_market_value > 0)
    holding = {
        "rank": rank,
        "codeRaw": clean_text(code_raw),
        "ticker": ticker,
        "name": clean_text(name),
        "shares": parsed_shares,
        "marketValueKrw": parsed_market_value,
        "weightPercent": weight,
        "weight": None if weight is None else weight / 100,
        "hasExternalTicker": bool(ticker),
        "hasProviderValuation": has_provider_valuation,
        "priceTrackingMethod": "external_ticker" if ticker else ("provider_valuation_krw" if has_provider_valuation else None),
        "isPriceTracked": bool(ticker) or has_provider_valuation,
    }
    if source_fields:
        holding["sourceFields"] = source_fields
    return holding


def parse_time_page(html_text: str, config: EtfConfig, *, requested_date: str | None = None, fetched_at: str | None = None) -> dict[str, Any]:
    input_match = re.search(r'id=["\']pdfDate["\'][^>]*value=["\']([^"\']+)', html_text, re.I)
    min_match = re.search(r'id=["\']pdfDate["\'][^>]*min=["\']([^"\']+)', html_text, re.I)
    standard_dates = [f"{y}-{m}-{d}" for y, m, d in re.findall(r"(\d{4})\.(\d{2})\.(\d{2})\s*기준", html_text)]
    query_date = iso_date(input_match.group(1)) if input_match else (requested_date or today_kst())
    listing_date = iso_date(min_match.group(1)) if min_match else config.listing_date

    section_start = html_text.find('id="constituentItems"')
    search_area = html_text[section_start:] if section_start >= 0 else html_text
    table_html = ""
    for match in re.finditer(r"<table[\s\S]*?</table>", search_area, flags=re.I):
        candidate = match.group(0)
        candidate_text = clean_text(candidate)
        if "종목코드" in candidate_text and "비중" in candidate_text:
            table_html = candidate
            break

    holdings: list[dict[str, Any]] = []
    if table_html:
        for tr in re.findall(r"<tr[\s\S]*?</tr>", table_html, flags=re.I):
            cells = [clean_text(cell) for cell in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", tr, flags=re.I)]
            if len(cells) < 5 or cells[0] == "종목코드":
                continue
            weight = parse_number(cells[4])
            if weight is None:
                continue
            holdings.append(make_holding(len(holdings) + 1, cells[0], cells[1], cells[2], cells[3], cells[4]))

    nav_as_of_date = max(standard_dates) if standard_dates else None
    if nav_as_of_date and nav_as_of_date > query_date:
        nav_as_of_date = None

    source_status = "live" if holdings else "empty"
    warning = "" if holdings else "TIME provider returned no constituent rows for the requested date."
    return {
        "etfId": config.id,
        "asOfDate": query_date,
        "queryDate": requested_date or query_date,
        "navAsOfDate": nav_as_of_date,
        "priceBasisDate": previous_weekday(query_date),
        "listingDate": listing_date,
        "sourceStatus": source_status,
        "sourceConfidence": "high" if holdings else "low",
        "sourceWarning": warning,
        "provider": config.provider,
        "sourceUrl": config.source_url,
        "fetchedAt": fetched_at,
        "holdings": holdings,
        "top10": holdings[:10],
        "totalHoldings": len(holdings),
    }


def parse_samsung_payload(payload: dict[str, Any], config: EtfConfig, *, requested_date: str | None = None, fetched_at: str | None = None) -> dict[str, Any]:
    pdf = payload.get("pdf", payload if isinstance(payload.get("pdf"), dict) else {}) if isinstance(payload, dict) else {}
    info = payload.get("info", {}) if isinstance(payload, dict) else {}
    product = info.get("product", {}) if isinstance(info, dict) else {}
    gijun = pdf.get("gijunYMD") or product.get("gijunYMD") or compact_date(requested_date or today_kst())
    as_of = iso_date(str(gijun))
    listing = iso_date(str(product.get("listD") or pdf.get("listD") or config.listing_date))
    raw_rows = pdf.get("list") if isinstance(pdf.get("list"), list) else []
    holdings: list[dict[str, Any]] = []
    for row in raw_rows:
        if not isinstance(row, dict):
            continue
        weight = parse_number(row.get("ratio"))
        if weight is None or weight <= 0:
            continue
        holdings.append(
            make_holding(
                len(holdings) + 1,
                str(row.get("itmNo") or ""),
                str(row.get("secNm") or row.get("secEngNm") or ""),
                row.get("applyQ"),
                row.get("evalA"),
                row.get("ratio"),
                source_fields={"secId": row.get("secId"), "risep": row.get("risep"), "curp": row.get("curp")},
            )
        )

    # Product endpoint sometimes exposes top10 separately even when pdf.list is truncated.
    if not holdings:
        top10 = pdf.get("top10", {}).get("today") if isinstance(pdf.get("top10"), dict) else []
        for row in top10 if isinstance(top10, list) else []:
            if not isinstance(row, dict):
                continue
            holdings.append(
                make_holding(
                    len(holdings) + 1,
                    str(row.get("ticker") or row.get("itmNo") or row.get("secEngNm") or ""),
                    str(row.get("secNm") or row.get("secEngNm") or ""),
                    None,
                    None,
                    row.get("wgt"),
                    source_fields={"secId": row.get("secId"), "newYn": row.get("newYn"), "wgtDiv": row.get("wgtDiv")},
                )
            )

    actual_date_warning = ""
    if requested_date and as_of != requested_date:
        actual_date_warning = f"Requested {requested_date}, provider returned {as_of}."
    source_status = "live" if holdings and not actual_date_warning else ("stale" if holdings else "empty")
    return {
        "etfId": config.id,
        "asOfDate": as_of,
        "queryDate": requested_date or as_of,
        "navAsOfDate": iso_date(str(product.get("gijunYMD"))) if product.get("gijunYMD") else None,
        "priceBasisDate": previous_weekday(as_of),
        "listingDate": listing,
        "sourceStatus": source_status,
        "sourceConfidence": "high" if source_status == "live" else ("medium" if holdings else "low"),
        "sourceWarning": actual_date_warning if holdings else "Samsung Active provider returned no PDF constituent rows.",
        "provider": config.provider,
        "sourceUrl": config.source_url,
        "fetchedAt": fetched_at,
        "holdings": holdings,
        "top10": holdings[:10],
        "totalHoldings": int(parse_number(pdf.get("totalCnt")) or len(holdings)),
    }


def fetch_time_snapshot(config: EtfConfig, target_date: str) -> dict[str, Any]:
    assert config.idx and config.cate
    params = urllib.parse.urlencode({"idx": config.idx, "cate": config.cate, "pdfDate": target_date})
    url = f"https://timeetf.co.kr/m11_view.php?{params}"
    text = http_get(url)
    return parse_time_page(text, config, requested_date=target_date, fetched_at=dt.datetime.now(dt.timezone.utc).isoformat())


def fetch_samsung_snapshot(config: EtfConfig, target_date: str) -> dict[str, Any]:
    assert config.f_id
    compact = compact_date(target_date)
    url = f"https://www.samsungactive.co.kr/api/v1/product/etf-pdf/{config.f_id}.do?gijunYMD={compact}"
    text = http_get(url, accept="application/json,text/plain,*/*")
    payload = json.loads(text)
    return parse_samsung_payload(payload, config, requested_date=target_date, fetched_at=dt.datetime.now(dt.timezone.utc).isoformat())


def fetch_snapshot(config: EtfConfig, target_date: str) -> dict[str, Any]:
    if config.provider_kind == "time":
        return fetch_time_snapshot(config, target_date)
    if config.provider_kind == "samsung":
        return fetch_samsung_snapshot(config, target_date)
    raise ValueError(f"Unknown provider kind: {config.provider_kind}")


def load_fixture_snapshot(config: EtfConfig, fixture_dir: Path, target_date: str) -> dict[str, Any]:
    if config.provider_kind == "time":
        fixture_name = f"time-{config.idx}.html"
        text = (fixture_dir / fixture_name).read_text(encoding="utf-8")
        return parse_time_page(text, config, requested_date=target_date, fetched_at="2026-06-17T00:00:00+00:00")
    fixture_name = f"samsung-{config.f_id}.json"
    payload = json.loads((fixture_dir / fixture_name).read_text(encoding="utf-8"))
    return parse_samsung_payload(payload, config, requested_date=target_date, fetched_at="2026-06-17T00:00:00+00:00")


def snapshot_for_history(snapshot: dict[str, Any]) -> dict[str, Any]:
    return {
        "date": snapshot["asOfDate"],
        "queryDate": snapshot.get("queryDate"),
        "navAsOfDate": snapshot.get("navAsOfDate"),
        "priceBasisDate": snapshot.get("priceBasisDate") or previous_weekday(str(snapshot["asOfDate"])),
        "sourceStatus": snapshot.get("sourceStatus"),
        "sourceConfidence": snapshot.get("sourceConfidence"),
        "sourceWarning": snapshot.get("sourceWarning"),
        "holdings": snapshot.get("holdings", []),
        "top10": snapshot.get("top10", []),
        "totalHoldings": snapshot.get("totalHoldings"),
        "fetchedAt": snapshot.get("fetchedAt"),
    }


def load_history(output_dir: Path) -> dict[str, list[dict[str, Any]]]:
    path = output_dir / "history.json"
    if not path.exists():
        return {config.id: [] for config in ETFS}
    payload = json.loads(path.read_text(encoding="utf-8"))
    raw = payload.get("etfs", {}) if isinstance(payload, dict) else {}
    return {config.id: list(raw.get(config.id, [])) for config in ETFS}


def merge_history(existing: dict[str, list[dict[str, Any]]], snapshots: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    merged: dict[str, list[dict[str, Any]]] = {}
    for config in ETFS:
        by_date: dict[str, dict[str, Any]] = {}
        for snap in existing.get(config.id, []):
            date = snap.get("date") or snap.get("asOfDate")
            if date:
                by_date[str(date)] = snap
        for snap in snapshots.get(config.id, []):
            if snap.get("holdings") or snap.get("top10"):
                by_date[str(snap["date"])] = snap
        merged[config.id] = [by_date[key] for key in sorted(by_date)]
    return merged


def dates_to_fetch(
    config: EtfConfig,
    end_date: str,
    *,
    backfill_all: bool,
    backfill_days: int,
    backfill_start_date: str | None = None,
) -> list[str]:
    end_date = iso_date(end_date)
    if backfill_start_date:
        start = iso_date(backfill_start_date)
    elif backfill_all:
        start = config.listing_date
    else:
        start = (dt.date.fromisoformat(end_date) - dt.timedelta(days=max(backfill_days - 1, 0))).isoformat()
    start = max(start, config.listing_date)
    if start > end_date:
        return []
    return [date for date in date_range_days(start, end_date) if is_weekday(date)]


def prioritized_fetch_dates(dates: list[str], target_date: str) -> list[str]:
    """Fetch the current target first, then historical dates.

    Scheduled runs should not lose the latest snapshot merely because a provider
    throttles while a wider historical backfill is in progress.  History is still
    merged and sorted chronologically after collection.
    """

    target = iso_date(target_date)
    return ([target] if target in dates else []) + [date for date in dates if date != target]


class PriceProvider:
    def __init__(self, fixture_dir: Path | None = None, no_live: bool = False) -> None:
        self.fixture_dir = fixture_dir
        self.no_live = no_live
        self.cache: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.live_series_cache: dict[str, dict[str, Any]] = {}
        self.fixture_prices = self._load_fixture_prices(fixture_dir) if fixture_dir else {}
        self.errors: dict[str, str] = {}
        self.diagnostics: dict[str, list[dict[str, Any]]] = {}

    @staticmethod
    def _load_fixture_prices(fixture_dir: Path | None) -> dict[str, dict[str, float]]:
        if not fixture_dir:
            return {}
        path = fixture_dir / "prices.json"
        if not path.exists():
            return {}
        payload = json.loads(path.read_text(encoding="utf-8"))
        closes = payload.get("closes", payload)
        result: dict[str, dict[str, float]] = {}
        for ticker, rows in closes.items():
            if isinstance(rows, dict):
                result[str(ticker)] = {str(date): float(value) for date, value in rows.items() if parse_number(value) is not None}
        return result

    def close_map(self, ticker: str, start_date: str, end_date: str) -> dict[str, float]:
        return self.close_series(ticker, start_date, end_date).get("closes", {})

    def close_series(self, ticker: str, start_date: str, end_date: str) -> dict[str, Any]:
        key = (ticker, start_date, end_date)
        if key in self.cache:
            return self.cache[key]
        series: dict[str, Any] = {"closes": {}, "sources": {}, "attempts": [], "errors": []}
        if ticker in self.fixture_prices:
            fixture = {date: value for date, value in self.fixture_prices[ticker].items() if start_date <= date <= end_date}
            self._merge_closes(series, fixture, "fixture_prices")
            series["attempts"].append({"source": "fixture_prices", "status": "ok" if fixture else "no_data", "points": len(fixture)})
            self.cache[key] = series
            return series
        if self.no_live:
            series["attempts"].append({"source": "live_prices", "status": "disabled", "points": 0})
            self.cache[key] = series
            return series
        series = self._cached_live_series(ticker, start_date, end_date)
        self.cache[key] = series
        return series

    def _cached_live_series(self, ticker: str, start_date: str, end_date: str) -> dict[str, Any]:
        cached = self.live_series_cache.get(ticker)
        if cached and cached["startDate"] <= start_date and cached["endDate"] >= end_date:
            return copy.deepcopy(cached["series"])

        fetch_start = min(start_date, cached["startDate"]) if cached else start_date
        requested_end = max(end_date, cached["endDate"]) if cached else end_date
        fetch_end = (dt.date.fromisoformat(requested_end) + dt.timedelta(days=PRICE_CACHE_FORWARD_DAYS)).isoformat()
        series = self._fetch_live_series(ticker, fetch_start, fetch_end)
        if cached:
            preserved = copy.deepcopy(cached["series"])
            for date, value in preserved.get("closes", {}).items():
                series["closes"].setdefault(date, value)
            for date, source in preserved.get("sources", {}).items():
                series["sources"].setdefault(date, source)
            series["attempts"] = [*preserved.get("attempts", []), *series.get("attempts", [])]
            series["errors"] = [*preserved.get("errors", []), *series.get("errors", [])]
        self.live_series_cache[ticker] = {"startDate": fetch_start, "endDate": fetch_end, "series": copy.deepcopy(series)}
        return series

    def _fetch_live_series(self, ticker: str, start_date: str, end_date: str) -> dict[str, Any]:
        series: dict[str, Any] = {"closes": {}, "sources": {}, "attempts": [], "errors": []}
        providers = (
            ("yahoo_chart_query1", lambda: self._fetch_yahoo_chart(ticker, start_date, end_date, host="query1.finance.yahoo.com")),
            ("yahoo_chart_query2", lambda: self._fetch_yahoo_chart(ticker, start_date, end_date, host="query2.finance.yahoo.com")),
            ("stooq_csv", lambda: self._fetch_stooq_csv(ticker, start_date, end_date)),
            ("finance_datareader", lambda: self._fetch_finance_datareader(ticker, start_date, end_date)),
        )
        for source, fetcher in providers:
            try:
                data = fetcher()
            except ImportError as exc:
                series["attempts"].append({"source": source, "status": "unavailable", "points": 0, "message": str(exc)})
                continue
            except Exception as exc:  # best effort; status file captures the failure.
                message = f"{type(exc).__name__}: {exc}"
                series["attempts"].append({"source": source, "status": "error", "points": 0, "message": message})
                series["errors"].append({"source": source, "message": message})
                continue
            self._merge_closes(series, data, source)
            series["attempts"].append({"source": source, "status": "ok" if data else "no_data", "points": len(data)})
            if self._has_distinct_required_closes(series["closes"], start_date, end_date):
                break
        if not series["closes"] and series["errors"]:
            self.errors[ticker] = "; ".join(f"{item['source']}: {item['message']}" for item in series["errors"][:3])
        return series

    @staticmethod
    def _merge_closes(series: dict[str, Any], closes: dict[str, float], source: str) -> None:
        for date, value in sorted(closes.items()):
            if not math.isfinite(value):
                continue
            series["closes"].setdefault(date, value)
            series["sources"].setdefault(date, source)

    @staticmethod
    def _has_distinct_required_closes(closes: dict[str, float], start_date: str, end_date: str) -> bool:
        start_close = nearest_close_on_or_before(closes, start_date)
        end_close = nearest_close_on_or_before(closes, end_date)
        return bool(start_close and end_close and end_close[0] > start_close[0] and start_close[1] != 0)

    def _fetch_yahoo_chart(self, ticker: str, start_date: str, end_date: str, *, host: str) -> dict[str, float]:
        start_dt = dt.datetime.combine(dt.date.fromisoformat(start_date) - dt.timedelta(days=7), dt.time.min, tzinfo=dt.timezone.utc)
        end_dt = dt.datetime.combine(dt.date.fromisoformat(end_date) + dt.timedelta(days=2), dt.time.min, tzinfo=dt.timezone.utc)
        params = urllib.parse.urlencode({
            "period1": int(start_dt.timestamp()),
            "period2": int(end_dt.timestamp()),
            "interval": "1d",
            "events": "history",
            "includeAdjustedClose": "true",
        })
        encoded = urllib.parse.quote(ticker, safe="")
        url = f"https://{host}/v8/finance/chart/{encoded}?{params}"
        text = http_get(url, accept="application/json,text/plain,*/*", timeout=6)
        payload = json.loads(text)
        result = payload.get("chart", {}).get("result", [])
        if not result:
            raise ValueError(payload.get("chart", {}).get("error") or "No chart result")
        item = result[0]
        timestamps = item.get("timestamp") or []
        quote = (item.get("indicators", {}).get("adjclose") or item.get("indicators", {}).get("quote") or [{}])[0]
        closes = quote.get("adjclose") or quote.get("close") or []
        out: dict[str, float] = {}
        for stamp, close in zip(timestamps, closes):
            if close is None:
                continue
            date = dt.datetime.fromtimestamp(int(stamp), tz=dt.timezone.utc).date().isoformat()
            out[date] = float(close)
        # Keep provider calls gentle when backfilling many tickers.
        time.sleep(0.05)
        return out

    def _fetch_stooq_csv(self, ticker: str, start_date: str, end_date: str) -> dict[str, float]:
        start_dt = dt.date.fromisoformat(start_date) - dt.timedelta(days=7)
        end_dt = dt.date.fromisoformat(end_date) + dt.timedelta(days=2)
        for symbol in stooq_symbol_candidates(ticker):
            params = urllib.parse.urlencode({
                "s": symbol,
                "d1": start_dt.strftime("%Y%m%d"),
                "d2": end_dt.strftime("%Y%m%d"),
                "i": "d",
            })
            url = f"https://stooq.com/q/d/l/?{params}"
            text = http_get(url, accept="text/csv,text/plain,*/*", timeout=2, max_bytes=1_000_000)
            closes = parse_stooq_csv(text)
            if closes:
                time.sleep(0.05)
                return closes
        return {}

    def _fetch_finance_datareader(self, ticker: str, start_date: str, end_date: str) -> dict[str, float]:
        fdr = importlib.import_module("FinanceDataReader")
        start_dt = (dt.date.fromisoformat(start_date) - dt.timedelta(days=7)).isoformat()
        end_dt = (dt.date.fromisoformat(end_date) + dt.timedelta(days=2)).isoformat()
        frame = fdr.DataReader(ticker, start_dt, end_dt)
        out: dict[str, float] = {}
        if frame is None:
            return out
        for index, row in frame.iterrows():
            close = row.get("Close") if hasattr(row, "get") else None
            value = parse_number(close)
            if value is None:
                continue
            date = index.date().isoformat() if hasattr(index, "date") else iso_date(str(index)[:10])
            out[date] = value
        return out

    def return_between(self, ticker: str | None, start_date: str, end_date: str) -> tuple[float | None, dict[str, Any]]:
        if not ticker:
            return None, {"reason": "not_price_tracked"}
        if end_date <= start_date:
            return None, {"reason": "stale_price_basis", "startDate": start_date, "endDate": end_date}
        series = self.close_series(ticker, start_date, end_date)
        closes = series.get("closes", {})
        start_close = nearest_close_on_or_before(closes, start_date)
        end_close = nearest_close_on_or_before(closes, end_date)
        if start_close is None or end_close is None or start_close[1] == 0:
            meta = {
                "reason": "missing_close",
                "startDate": start_date,
                "endDate": end_date,
                "attempts": series.get("attempts", []),
                "providerErrors": series.get("errors", []),
            }
            self._record_return_diagnostic(ticker, meta)
            return None, meta
        if end_close[0] <= start_close[0]:
            meta = {
                "reason": "stale_close",
                "startDate": start_date,
                "endDate": end_date,
                "startCloseDate": start_close[0],
                "endCloseDate": end_close[0],
                "attempts": series.get("attempts", []),
                "providerErrors": series.get("errors", []),
            }
            self._record_return_diagnostic(ticker, meta)
            return None, meta
        value = (end_close[1] / start_close[1]) - 1
        sources = series.get("sources", {})
        return value, {
            "source": sources.get(end_close[0]) or sources.get(start_close[0]) or "unknown",
            "start": {"date": start_close[0], "close": start_close[1], "source": sources.get(start_close[0])},
            "end": {"date": end_close[0], "close": end_close[1], "source": sources.get(end_close[0])},
            "attempts": series.get("attempts", []),
        }

    def _record_return_diagnostic(self, ticker: str, meta: dict[str, Any]) -> None:
        reason = str(meta.get("reason") or "price_unavailable")
        self.diagnostics.setdefault(ticker, []).append(meta)
        self.errors[ticker] = reason


def nearest_close_on_or_before(closes: dict[str, float], target_date: str) -> tuple[str, float] | None:
    candidates = [(date, value) for date, value in closes.items() if date <= target_date and math.isfinite(value)]
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: item[0])[-1]


def stooq_symbol_candidates(ticker: str) -> list[str]:
    raw = clean_text(ticker).lower().replace("-", ".")
    if not raw:
        return []
    candidates: list[str] = []
    if raw.endswith(".t"):
        base = raw[:-2]
        candidates.extend([f"{base}.jp", raw])
    elif raw.endswith(".hk"):
        base = raw[:-3].lstrip("0") or raw[:-3]
        candidates.extend([f"{base}.hk", raw])
    elif raw.endswith(".ks") or raw.endswith(".kq"):
        candidates.append(raw)
    elif "." in raw:
        candidates.append(raw)
    else:
        candidates.extend([f"{raw}.us", raw])
    return list(dict.fromkeys(candidates))


def parse_stooq_csv(text: str) -> dict[str, float]:
    if not text or "<html" in text[:500].lower() or "Date,Open,High,Low,Close" not in text[:200]:
        return {}
    out: dict[str, float] = {}
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        date = row.get("Date")
        close = parse_number(row.get("Close"))
        if not date or close is None:
            continue
        try:
            out[iso_date(date)] = close
        except ValueError:
            continue
    return out


def provider_unit_value_krw(row: dict[str, Any] | None) -> float | None:
    if not row:
        return None
    shares = parse_number(row.get("shares"))
    market_value = parse_number(row.get("marketValueKrw"))
    if shares is None or market_value is None or shares <= 0 or market_value <= 0:
        return None
    return market_value / shares


def provider_valuation_return(
    prev_row: dict[str, Any] | None,
    curr_row: dict[str, Any] | None,
    *,
    start_date: str | None = None,
    end_date: str | None = None,
) -> tuple[float | None, dict[str, Any]] | None:
    previous_value = provider_unit_value_krw(prev_row)
    current_value = provider_unit_value_krw(curr_row)
    if previous_value is None or current_value is None or previous_value == 0:
        return None
    return (current_value / previous_value) - 1, {
        "source": "provider_valuation_krw",
        "sourceType": "etf_provider_unit_value_krw",
        "start": {"date": start_date, "close": previous_value, "source": "provider_valuation_krw"},
        "end": {"date": end_date, "close": current_value, "source": "provider_valuation_krw"},
        "message": "ETF PDF의 평가금액/수량 단가(KRW)를 수익률로 사용해 환율 효과를 포함했습니다.",
    }


def compute_pair_decomposition(prev: dict[str, Any] | None, current: dict[str, Any], price_provider: PriceProvider) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    current_top = current.get("top10", [])
    if not prev:
        curr_date = str(current.get("date"))
        curr_price_basis = str(current.get("priceBasisDate") or previous_weekday(curr_date))
        rows = []
        for order, holding in enumerate(current_top, start=1):
            rows.append({
                "date": current["date"],
                "currentPriceBasisDate": curr_price_basis,
                "name": holding.get("name"),
                "codeRaw": holding.get("codeRaw"),
                "ticker": holding.get("ticker"),
                "rank": holding.get("rank"),
                "actualWeightPercent": holding.get("weightPercent"),
                "currentIsTop10": True,
                "previousWasTop10": False,
                "displayScope": "current_top10",
                "displayOrder": order,
                "classification": "insufficient_data",
                "economicSignal": "insufficient_data",
                "holdingLifecycle": "new_holding",
                "confidence": "low",
                "message": "첫 추적 스냅샷이라 전일 비교가 없습니다.",
            })
        return rows, [], {
            "returnCoverage": 0,
            "returnCoverageStatus": "insufficient",
            "returnCoverageUniverse": "full_holdings",
            "benchmarkReturn": None,
            "priceBasis": {"previous": None, "current": curr_price_basis},
            "dateBasis": {
                "currentSnapshotDate": curr_date,
                "previousSnapshotDate": None,
                "currentPriceBasisDate": curr_price_basis,
                "previousPriceBasisDate": None,
                "weightDateTimezone": "Asia/Seoul",
                "priceDateTimezone": "security valuation / market close date",
                "rule": "ETF disclosed weight date D is compared with the nearest available security valuation on or before priceBasisDate.",
            },
        }

    prev_top = prev.get("top10", [])
    curr_top = current_top
    prev_all = all_holdings(prev)
    curr_all = all_holdings(current)
    prev_top_map = ranked_map(prev_top)
    curr_top_map = ranked_map(curr_top)
    prev_all_map = ranked_map(prev_all)
    curr_all_map = ranked_map(curr_all)
    prev_date = str(prev.get("date"))
    curr_date = str(current.get("date"))
    prev_price_basis = str(prev.get("priceBasisDate") or previous_weekday(prev_date))
    curr_price_basis = str(current.get("priceBasisDate") or previous_weekday(curr_date))
    display_keys = list(dict.fromkeys([*(holding_key(row) for row in curr_top), *(holding_key(row) for row in prev_top)]))
    display_order = {key: index for index, key in enumerate(display_keys, start=1) if key}

    def resolve_return(key: str) -> tuple[float | None, dict[str, Any]]:
        prev_row = prev_all_map.get(key)
        curr_row = curr_all_map.get(key)
        reference = curr_row or prev_row or {}
        ticker = reference.get("ticker")

        def valuation_return(external_meta: dict[str, Any] | None = None) -> tuple[float | None, dict[str, Any]] | None:
            valuation = provider_valuation_return(prev_row, curr_row, start_date=prev_price_basis, end_date=curr_price_basis)
            if valuation is None:
                return None
            valuation_return_value, valuation_meta = valuation
            if external_meta:
                valuation_meta["externalPriceMeta"] = external_meta
            if ticker:
                price_provider.errors.pop(str(ticker), None)
            return valuation_return_value, valuation_meta

        provider_return = valuation_return()
        if provider_return:
            return provider_return

        security_return, price_meta = price_provider.return_between(ticker, prev_price_basis, curr_price_basis)
        if security_return is None and prev_row and curr_row:
            valuation_after_external_attempt = valuation_return(price_meta)
            if valuation_after_external_attempt:
                return valuation_after_external_attempt
        return security_return, price_meta

    return_keys = list(dict.fromkeys([*prev_all_map.keys(), *curr_all_map.keys()]))
    returns: dict[str, tuple[float | None, dict[str, Any]]] = {key: resolve_return(key) for key in return_keys}

    total_prev_weight = sum(float(row.get("weightPercent") or 0) for row in prev_all)
    valid_prev_weight = sum(
        float(row.get("weightPercent") or 0)
        for key, row in prev_all_map.items()
        if returns.get(key, (None,))[0] is not None
    )
    coverage = (valid_prev_weight / total_prev_weight) if total_prev_weight else 0

    benchmark_numerator = 0.0
    for key, row in prev_all_map.items():
        security_return = returns.get(key, (None,))[0]
        if security_return is None:
            continue
        benchmark_numerator += float(row.get("weightPercent") or 0) * security_return
    benchmark_return = benchmark_numerator / valid_prev_weight if valid_prev_weight else None

    decompositions: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []

    for key in display_keys:
        if not key:
            continue
        curr_row = curr_all_map.get(key)
        prev_row = prev_all_map.get(key)
        reference = curr_row or prev_row or {}
        current_is_top10 = key in curr_top_map
        previous_was_top10 = key in prev_top_map
        membership_change = None
        if current_is_top10 and not previous_was_top10:
            membership_change = "top10_entry"
        elif previous_was_top10 and not current_is_top10:
            membership_change = "top10_exit"

        actual = parse_number(curr_row.get("weightPercent")) if curr_row else 0.0
        prev_weight = parse_number(prev_row.get("weightPercent")) if prev_row else None
        base = {
            "date": curr_date,
            "previousDate": prev_date,
            "previousPriceBasisDate": prev_price_basis,
            "currentPriceBasisDate": curr_price_basis,
            "name": reference.get("name"),
            "codeRaw": reference.get("codeRaw"),
            "ticker": reference.get("ticker"),
            "rank": curr_row.get("rank") if curr_row else None,
            "previousRank": prev_row.get("rank") if prev_row else None,
            "actualWeightPercent": actual,
            "previousWeightPercent": prev_weight,
            "membershipChange": membership_change,
            "positionStatus": "held" if curr_row and prev_row else ("new_holding" if curr_row else "fund_exit"),
            "holdingLifecycle": "held" if curr_row and prev_row else ("new_holding" if curr_row else "fund_exit"),
            "currentIsTop10": current_is_top10,
            "previousWasTop10": previous_was_top10,
            "displayScope": "current_top10" if current_is_top10 else ("previous_top10_exit" if previous_was_top10 else "tracked_holding"),
            "displayOrder": display_order.get(key, 999),
        }

        if not prev_row:
            row = {
                **base,
                "classification": "new_entry",
                "economicSignal": "new_entry",
                "confidence": "high",
                "message": "ETF 보유목록 신규 편입" if current_is_top10 else "신규 보유",
            }
            decompositions.append(row)
            if current_is_top10:
                signals.append(signal_from_row(row, "top10_entry", "high"))
            continue

        if not curr_row:
            row = {
                **base,
                "classification": "fund_exit",
                "economicSignal": "fund_exit",
                "confidence": "high",
                "message": "ETF 보유목록에서 제외되었습니다.",
            }
            decompositions.append(row)
            if previous_was_top10:
                signals.append(signal_from_row(row, "top10_exit", "high"))
            continue

        security_return, price_meta = returns.get(key, (None, {}))
        if actual is None or prev_weight is None or security_return is None or benchmark_return is None:
            row = {
                **base,
                "securityReturn": security_return,
                "priceMeta": price_meta,
                "priceSource": price_meta.get("source") if isinstance(price_meta, dict) else None,
                "benchmarkReturn": benchmark_return,
                "returnCoverage": coverage,
                "classification": "insufficient_data",
                "economicSignal": "insufficient_data",
                "confidence": "low",
                "message": "종가·보조평가액 또는 비중 데이터가 부족해 분해하지 못했습니다.",
            }
            decompositions.append(row)
            if membership_change:
                signals.append(signal_from_row(row, membership_change, "high"))
            continue

        predicted = prev_weight * (1 + security_return) / (1 + benchmark_return)
        delta_actual = actual - prev_weight
        delta_price = predicted - prev_weight
        residual = delta_actual - delta_price
        tolerance = max(PRICE_EXPLAINED_TOLERANCE_PP, abs(prev_weight) * PRICE_EXPLAINED_TOLERANCE_RATIO)
        classification = "price_explained"
        message = "가격 수익률로 대부분 설명됩니다."
        confidence = "high"
        price_source = price_meta.get("source") if isinstance(price_meta, dict) else None
        if price_source == "provider_valuation_krw":
            message = "ETF 평가단가(KRW)로 환율을 포함한 가격 효과를 계산했습니다."
        if coverage < RETURN_COVERAGE_MIN:
            classification = "mixed"
            message = "종가 커버리지가 낮아 가격/매매 요인을 혼합 신호로 표시합니다."
            confidence = "low"
        elif residual > tolerance:
            classification = "likely_buy"
            message = "가격 효과보다 비중 증가가 커 추가 매수 가능성이 있습니다."
            confidence = "medium"
        elif residual < -tolerance:
            classification = "likely_sell"
            message = "가격 효과보다 비중 감소가 커 매도/축소 가능성이 있습니다."
            confidence = "medium"
        if membership_change == "top10_entry":
            message = f"TOP10 편입 · {message}"
        elif membership_change == "top10_exit":
            message = f"TOP10 밖으로 이동(현재 {curr_row.get('rank')}위) · {message}"
        row = {
            **base,
            "securityReturn": security_return,
            "benchmarkReturn": benchmark_return,
            "predictedWeightPercent": predicted,
            "deltaActualPercentPoint": delta_actual,
            "deltaPricePercentPoint": delta_price,
            "deltaResidualPercentPoint": residual,
            "tolerancePercentPoint": tolerance,
            "returnCoverage": coverage,
            "priceMeta": price_meta,
            "priceReturnStartDate": price_meta.get("start", {}).get("date") if isinstance(price_meta.get("start"), dict) else prev_price_basis,
            "priceReturnEndDate": price_meta.get("end", {}).get("date") if isinstance(price_meta.get("end"), dict) else curr_price_basis,
            "priceSource": price_source,
            "priceSourceType": price_meta.get("sourceType") if isinstance(price_meta, dict) else None,
            "attributionFormula": "previousWeightPercent * (1 + securityReturn) / (1 + fullHoldingsBenchmarkReturn)",
            "classification": classification,
            "economicSignal": classification,
            "confidence": confidence,
            "message": message,
        }
        decompositions.append(row)
        if membership_change:
            signals.append(signal_from_row(row, membership_change, "high"))
        if classification in {"likely_buy", "likely_sell", "mixed"}:
            signals.append(signal_from_row(row, classification, "medium" if classification != "mixed" else "low"))

    summary = {
        "returnCoverage": coverage,
        "returnCoverageStatus": "ok" if coverage >= RETURN_COVERAGE_MIN else "low",
        "returnCoverageUniverse": "full_holdings",
        "validReturnWeightPercent": valid_prev_weight,
        "totalReturnWeightPercent": total_prev_weight,
        "benchmarkReturn": benchmark_return,
        "fullHoldingCount": len(curr_all),
        "previousFullHoldingCount": len(prev_all),
        "priceBasis": {"previous": prev_price_basis, "current": curr_price_basis},
        "dateBasis": {
            "currentSnapshotDate": curr_date,
            "previousSnapshotDate": prev_date,
            "currentPriceBasisDate": curr_price_basis,
            "previousPriceBasisDate": prev_price_basis,
            "weightDateTimezone": "Asia/Seoul",
            "priceDateTimezone": "security valuation / market close date",
            "rule": "ETF disclosed weight date D is decomposed using the security valuation return from previous priceBasisDate to current priceBasisDate.",
        },
        "decompositionFormula": "predictedWeightPercent = previousWeightPercent * (1 + securityReturn) / (1 + fullHoldingsBenchmarkReturn); residual = actualWeightChange - priceEffect",
        "priceErrors": copy.deepcopy(price_provider.errors),
        "priceDiagnostics": copy.deepcopy(price_provider.diagnostics),
    }
    return decompositions, signals, summary

def signal_from_row(row: dict[str, Any], signal_type: str, severity: str) -> dict[str, Any]:
    return {
        "date": row.get("date"),
        "previousDate": row.get("previousDate"),
        "type": signal_type,
        "severity": severity,
        "name": row.get("name"),
        "codeRaw": row.get("codeRaw"),
        "ticker": row.get("ticker"),
        "rank": row.get("rank"),
        "previousRank": row.get("previousRank"),
        "weightPercent": row.get("actualWeightPercent"),
        "previousWeightPercent": row.get("previousWeightPercent"),
        "message": row.get("message"),
    }


def enrich_history(history: dict[str, list[dict[str, Any]]], price_provider: PriceProvider) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    summaries: dict[str, dict[str, Any]] = {}
    for config in ETFS:
        rows = sorted(history.get(config.id, []), key=lambda item: item.get("date", ""))
        previous = None
        latest_summary: dict[str, Any] = {"returnCoverage": 0, "returnCoverageStatus": "insufficient", "benchmarkReturn": None}
        for snapshot in rows:
            decomposition, signals, summary = compute_pair_decomposition(previous, snapshot, price_provider)
            snapshot["decomposition"] = decomposition
            snapshot["signals"] = signals
            snapshot["analysisSummary"] = summary
            latest_summary = summary
            previous = snapshot
        history[config.id] = rows
        summaries[config.id] = latest_summary
    return history, summaries


def build_dashboard(history: dict[str, list[dict[str, Any]]], summaries: dict[str, dict[str, Any]], generated_at: str) -> dict[str, Any]:
    etf_payloads = []
    all_signals: list[dict[str, Any]] = []
    all_dates: list[str] = []
    for config in ETFS:
        rows = history.get(config.id, [])
        latest = rows[-1] if rows else None
        signals = latest.get("signals", []) if latest else []
        all_signals.extend({**signal, "etfId": config.id, "etfName": config.name} for signal in signals)
        dates = [row.get("date") for row in rows if row.get("date")]
        all_dates.extend(str(date) for date in dates if date)
        entry_exit_count = sum(1 for signal in signals if signal.get("type") in {"top10_entry", "top10_exit"})
        etf_payloads.append({
            "id": config.id,
            "name": config.name,
            "shortName": config.short_name,
            "code": config.code,
            "provider": config.provider,
            "sourceUrl": config.source_url,
            "listingDate": config.listing_date,
            "availableStartDate": min(dates) if dates else None,
            "availableEndDate": max(dates) if dates else None,
            "historyCount": len(rows),
            "latest": latest,
            "history": rows,
            "signals": signals,
            "metrics": {
                "top10Count": len(latest.get("top10", [])) if latest else 0,
                "entryExitSignalCount": entry_exit_count,
                "signalCount": len(signals),
                "returnCoverage": summaries.get(config.id, {}).get("returnCoverage"),
                "returnCoverageStatus": summaries.get(config.id, {}).get("returnCoverageStatus"),
            },
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "timezone": "Asia/Seoul",
        "disclaimer": "가격 수익률 분해는 추정이며 투자, 세무, 법률 또는 매매 조언이 아닙니다.",
        "sourcePolicy": {
            "holdings": "ETF provider public pages/APIs",
            "holdingsHistory": "Full provider holdings are persisted; TOP10 is a derived dashboard view.",
            "prices": "For attribution, ETF provider valuation-per-share KRW is preferred when available because ETF weights are KRW NAV weights; otherwise the updater falls back to local fixtures, Yahoo Chart query1/query2 adjusted closes, Stooq CSV, and optional FinanceDataReader.",
            "googleFinance": "Google Finance has no stable public historical HTTP API in this updater; use it only as manual cross-check outside scheduled automation.",
            "dateBasis": "ETF disclosed weight date is Korean-calendar based; return intervals use previous/current priceBasisDate valuation dates recorded on each decomposition row.",
            "attribution": "No-trade predicted weight = previous full-holding weight × (1 + security return) / (1 + full-holdings benchmark return). Residual is actual weight change minus this price effect.",
            "confidenceRule": "returnCoverage below 60% is marked mixed/low confidence; external closes are fallback data when KRW valuation-per-share is unavailable.",
        },
        "updatePolicy": {
            "timezone": "Asia/Seoul",
            "primary": "08:05 KST",
            "retries": ["09:30 KST", "11:00 KST", "13:00 KST"],
            "cronUtc": ["5 23 * * 0-5", "30 0 * * 1-6", "0 2 * * 1-6", "0 4 * * 1-6"],
        },
        "historyPolicy": {
            "availableStartDate": min(all_dates) if all_dates else None,
            "availableEndDate": max(all_dates) if all_dates else None,
            "scheduledLookbackDays": DEFAULT_SCHEDULED_BACKFILL_DAYS,
            "startDateExplanation": "기존 2026-06-08 시작일은 예약 자동화의 최근 10일 백필 창 때문입니다. 수동/로컬 백필을 커밋하면 더 넓은 히스토리를 보존합니다.",
            "manualBackfillStartDate": "--backfill-start-date YYYY-MM-DD",
            "manualBackfillAll": "--backfill-all",
            "fetchOrder": "공급자 throttling이 최신 스냅샷을 가리지 않도록 목표일을 먼저 가져온 뒤 과거 날짜를 채웁니다.",
            "payloadTradeoff": "상장일 이후 전체 백필 명령은 지원하지만, 예약 자동화는 정적 JSON 용량과 공급자 요청 제한을 피하기 위해 작은 rolling window만 갱신합니다.",
        },
        "etfs": etf_payloads,
        "signals": sorted(all_signals, key=lambda item: (item.get("date") or "", item.get("severity") or ""), reverse=True)[:50],
    }


def build_latest(history: dict[str, list[dict[str, Any]]], generated_at: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "etfs": [
            {
                "id": config.id,
                "name": config.name,
                "code": config.code,
                "latest": (history.get(config.id) or [None])[-1],
            }
            for config in ETFS
        ],
    }


def build_status(
    history: dict[str, list[dict[str, Any]]],
    generated_at: str,
    price_provider: PriceProvider,
    target_date: str,
    diagnostics: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    diagnostics = diagnostics or {config.id: [] for config in ETFS}
    etf_status = []
    waiting = False
    for config in ETFS:
        latest = (history.get(config.id) or [None])[-1]
        source_status = latest.get("sourceStatus") if latest else "missing"
        analysis = latest.get("analysisSummary", {}) if latest else {}
        target_diagnostics = [item for item in diagnostics.get(config.id, []) if item.get("targetDate", item.get("queryDate", item.get("date"))) == target_date]
        target_diag = target_diagnostics[-1] if target_diagnostics else None
        latest_date = latest.get("date") if latest else None
        target_status = target_diag.get("sourceStatus") if target_diag else "not_attempted"
        target_has_top10 = bool(target_diag.get("hasTop10")) if target_diag else False
        target_warning = target_diag.get("sourceWarning") if target_diag else "No target-date fetch diagnostic available"
        reused_existing_target = (
            latest_date == target_date
            and source_status == "live"
            and bool(latest.get("top10") if latest else False)
            and target_status != "live"
        )
        if reused_existing_target:
            target_status = "cached_live"
            target_has_top10 = True
            target_warning = f"Target fetch {target_diag.get('sourceStatus') if target_diag else 'not_attempted'}: {target_warning}; reused existing live target-date snapshot."
        is_waiting = (
            source_status in {"missing", "empty", "error", "stale"}
            or analysis.get("returnCoverageStatus") == "low"
            or latest_date != target_date
            or target_status in {"missing", "empty", "error", "stale", "not_attempted"}
            or not target_has_top10
        )
        if is_waiting:
            waiting = True
        etf_status.append({
            "id": config.id,
            "name": config.name,
            "targetDate": target_date,
            "latestDate": latest_date,
            "targetFetchStatus": target_status,
            "targetFetchWarning": target_warning,
            "targetFetchHasTop10": target_has_top10,
            "reusedExistingTargetSnapshot": reused_existing_target,
            "sourceStatus": source_status,
            "sourceWarning": latest.get("sourceWarning") if latest else "No snapshot available",
            "returnCoverageStatus": analysis.get("returnCoverageStatus"),
            "returnCoverage": analysis.get("returnCoverage"),
            "priceBasis": analysis.get("priceBasis"),
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "targetDate": target_date,
        "overallStatus": "waiting_for_prior_close" if waiting else "ok",
        "message": "If prior closes or provider rows are missing, scheduled retry slots after 08:00 KST will refresh this file.",
        "priceErrorCount": len(price_provider.errors),
        "priceErrors": price_provider.errors,
        "etfs": etf_status,
    }

def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def automation_warnings(status: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    for item in status.get("etfs", []):
        name = item.get("name") or item.get("id") or "ETF"
        if item.get("latestDate") != item.get("targetDate"):
            warnings.append(f"{name}: latest snapshot {item.get('latestDate') or 'missing'} != target {item.get('targetDate')}")
        if item.get("targetFetchStatus") not in {"live", "cached_live"}:
            warnings.append(f"{name}: target fetch status {item.get('targetFetchStatus') or 'unknown'}")
        if item.get("targetFetchHasTop10") is False:
            warnings.append(f"{name}: target TOP10 rows missing")
        coverage_status = item.get("returnCoverageStatus")
        if coverage_status and coverage_status != "ok":
            warnings.append(f"{name}: return coverage {coverage_status}")
    if status.get("priceErrorCount"):
        warnings.append(f"price errors: {status.get('priceErrorCount')}")
    return warnings


def build_automation_status(
    status: dict[str, Any],
    generated_at: str,
    target_date: str,
    *,
    run_status: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    warnings = automation_warnings(status)
    if run_status is None:
        if error:
            run_status = "soft_failed"
        elif status.get("overallStatus") == "ok" and not warnings:
            run_status = "ok"
        elif status.get("overallStatus") == "waiting_for_prior_close":
            run_status = "waiting_for_data"
        else:
            run_status = "degraded"
    payload: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "targetDate": target_date,
        "runStatus": run_status,
        "overallStatus": status.get("overallStatus"),
        "priceErrorCount": status.get("priceErrorCount", 0),
        "warningCount": len(warnings),
        "warnings": warnings[:40],
        "notificationPolicy": {
            "scheduledWorkflow": "Expected provider/price delays are recorded as data status instead of exiting non-zero.",
            "manualStrictMode": "workflow_dispatch strict_validation=true still fails for debugging.",
        },
    }
    if error:
        payload["error"] = error
    return payload


def build_failure_status(generated_at: str, target_date: str, error: str) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "targetDate": target_date,
        "overallStatus": "automation_error",
        "message": "Updater failed before new ETF data could be written; the site should continue serving the previous committed snapshot.",
        "priceErrorCount": 0,
        "priceErrors": {},
        "etfs": [
            {
                "id": config.id,
                "name": config.name,
                "targetDate": target_date,
                "latestDate": None,
                "targetFetchStatus": "not_attempted",
                "targetFetchWarning": error,
                "targetFetchHasTop10": False,
                "sourceStatus": "unknown",
                "sourceWarning": "Updater failed before collection completed.",
                "returnCoverageStatus": "unknown",
                "returnCoverage": None,
                "priceBasis": None,
            }
            for config in ETFS
        ],
    }


def github_warning(message: str) -> None:
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::warning::{message}")
    else:
        print(f"WARNING: {message}")


def write_csv_summary(path: Path, dashboard: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["etf_id", "date", "rank", "ticker", "name", "weight_percent", "classification", "residual_pp"])
        for etf in dashboard.get("etfs", []):
            latest = etf.get("latest") or {}
            decomposition_by_key = {holding_key(row): row for row in latest.get("decomposition", [])}
            for holding in latest.get("top10", []):
                row = decomposition_by_key.get(holding_key(holding), {})
                writer.writerow([
                    etf.get("id"),
                    latest.get("date"),
                    holding.get("rank"),
                    holding.get("ticker"),
                    holding.get("name"),
                    holding.get("weightPercent"),
                    row.get("classification"),
                    row.get("deltaResidualPercentPoint"),
                ])


def collect_snapshots(args: argparse.Namespace) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    snapshots: dict[str, list[dict[str, Any]]] = {config.id: [] for config in ETFS}
    diagnostics: dict[str, list[dict[str, Any]]] = {config.id: [] for config in ETFS}
    for config in ETFS:
        fetch_dates = dates_to_fetch(
            config,
            args.target_date,
            backfill_all=args.backfill_all,
            backfill_days=args.backfill_days,
            backfill_start_date=args.backfill_start_date,
        )
        for target in prioritized_fetch_dates(fetch_dates, args.target_date):
            try:
                raw = load_fixture_snapshot(config, args.fixture_dir, target) if args.fixture_dir else fetch_snapshot(config, target)
            except Exception as exc:
                diagnostic = {
                    "date": target,
                    "queryDate": target,
                    "sourceStatus": "error",
                    "sourceConfidence": "low",
                    "sourceWarning": str(exc),
                    "hasTop10": False,
                    "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                }
                diagnostics[config.id].append(diagnostic)
                if args.include_empty:
                    snapshots[config.id].append({**diagnostic, "top10": [], "totalHoldings": 0})
                continue
            diagnostic = {
                "date": raw.get("asOfDate") or target,
                "targetDate": target,
                "queryDate": raw.get("queryDate") or target,
                "sourceStatus": raw.get("sourceStatus"),
                "sourceConfidence": raw.get("sourceConfidence"),
                "sourceWarning": raw.get("sourceWarning"),
                "hasTop10": bool(raw.get("top10")),
                "top10Count": len(raw.get("top10", [])),
                "holdingCount": len(raw.get("holdings", [])),
                "fetchedAt": raw.get("fetchedAt"),
            }
            diagnostics[config.id].append(diagnostic)
            if raw.get("top10"):
                snapshots[config.id].append(snapshot_for_history(raw))
            elif args.include_empty:
                snapshots[config.id].append(snapshot_for_history(raw))
            if not args.fixture_dir:
                time.sleep(args.provider_delay)
    return snapshots, diagnostics

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("data"))
    parser.add_argument("--fixture-dir", type=Path)
    parser.add_argument("--target-date", default=today_kst())
    parser.add_argument("--backfill-days", type=int, default=1, help="Weekday lookback window including target date.")
    parser.add_argument("--backfill-start-date", help="Fetch weekdays from this YYYY-MM-DD date through target date, bounded by each ETF listing date.")
    parser.add_argument("--backfill-all", action="store_true", help="Fetch all weekdays from each listing date to target date.")
    parser.add_argument("--include-empty", action="store_true", help="Persist empty/error snapshots for diagnostics.")
    parser.add_argument("--no-live-prices", action="store_true", help="Skip live Yahoo price calls.")
    parser.add_argument("--provider-delay", type=float, default=0.12, help="Delay between provider requests outside fixture mode.")
    parser.add_argument("--soft-fail", action="store_true", help="Record automation failure status and return success for scheduled workflows.")
    return parser.parse_args()


def run_update(args: argparse.Namespace) -> dict[str, Any]:
    args.target_date = iso_date(args.target_date)
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    existing = load_history(output_dir)
    new_snapshots, diagnostics = collect_snapshots(args)
    merged = merge_history(existing, new_snapshots)
    price_provider = PriceProvider(args.fixture_dir, no_live=args.no_live_prices)
    enriched, summaries = enrich_history(merged, price_provider)
    dashboard = build_dashboard(enriched, summaries, generated_at)
    latest = build_latest(enriched, generated_at)
    history_payload = {"schemaVersion": SCHEMA_VERSION, "generatedAt": generated_at, "etfs": enriched, "diagnostics": diagnostics}
    status = build_status(enriched, generated_at, price_provider, args.target_date, diagnostics)

    automation_status = build_automation_status(status, generated_at, args.target_date)

    write_json(output_dir / "history.json", history_payload)
    write_json(output_dir / "latest.json", latest)
    write_json(output_dir / "dashboard.json", dashboard)
    write_json(output_dir / "status.json", status)
    write_json(output_dir / "automation-status.json", automation_status)
    write_csv_summary(output_dir / "latest-summary.csv", dashboard)

    print(f"Wrote ETF tracking data to {output_dir} ({sum(len(v) for v in enriched.values())} snapshots).")
    print(f"Status: {status['overallStatus']} | price errors: {status['priceErrorCount']} | automation: {automation_status['runStatus']}")
    return {"status": status, "automationStatus": automation_status}


def main() -> int:
    args = parse_args()
    try:
        run_update(args)
        return 0
    except Exception as exc:
        if not args.soft_fail:
            raise
        output_dir: Path = args.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
        try:
            target_date = iso_date(args.target_date)
        except Exception:
            target_date = str(args.target_date or today_kst())
        error = f"{type(exc).__name__}: {exc}"
        status = build_failure_status(generated_at, target_date, error)
        automation_status = build_automation_status(status, generated_at, target_date, run_status="soft_failed", error=error)
        write_json(output_dir / "automation-status.json", automation_status)
        if not (output_dir / "status.json").exists():
            write_json(output_dir / "status.json", status)
        github_warning(f"ETF updater soft-failed: {error}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
