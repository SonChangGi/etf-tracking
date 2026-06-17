#!/usr/bin/env python3
"""Build static ETF TOP10 tracking data.

The updater is intentionally dependency-free so GitHub Actions can run it on a
plain Python image.  It reads provider public pages/APIs, keeps an idempotent
history file, and emits JSON optimized for a static dashboard.
"""
from __future__ import annotations

import argparse
import calendar
import csv
import dataclasses
import datetime as dt
import html
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
SCHEMA_VERSION = "1.0.0"
PRICE_EXPLAINED_TOLERANCE_PP = 0.20
PRICE_EXPLAINED_TOLERANCE_RATIO = 0.10
RETURN_COVERAGE_MIN = 0.60


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


def http_get(url: str, *, accept: str = "text/html,application/json", timeout: int = 25) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": accept,
            "Referer": "https://sonchanggi.github.io/etf-tracking/",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace")


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


def make_holding(rank: int, code_raw: str, name: str, shares: Any, market_value: Any, weight_percent: Any, *, source_fields: dict[str, Any] | None = None) -> dict[str, Any]:
    weight = parse_number(weight_percent)
    ticker = normalize_ticker(code_raw, name)
    holding = {
        "rank": rank,
        "codeRaw": clean_text(code_raw),
        "ticker": ticker,
        "name": clean_text(name),
        "shares": parse_intish(shares),
        "marketValueKrw": parse_intish(market_value),
        "weightPercent": weight,
        "weight": None if weight is None else weight / 100,
        "isPriceTracked": bool(ticker),
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

    source_status = "live" if holdings else "empty"
    warning = "" if holdings else "TIME provider returned no constituent rows for the requested date."
    return {
        "etfId": config.id,
        "asOfDate": query_date,
        "queryDate": requested_date or query_date,
        "navAsOfDate": max(standard_dates) if standard_dates else None,
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
            if snap.get("top10"):
                by_date[str(snap["date"])] = snap
        merged[config.id] = [by_date[key] for key in sorted(by_date)]
    return merged


def dates_to_fetch(config: EtfConfig, end_date: str, *, backfill_all: bool, backfill_days: int) -> list[str]:
    start = config.listing_date if backfill_all else (dt.date.fromisoformat(end_date) - dt.timedelta(days=max(backfill_days - 1, 0))).isoformat()
    start = max(start, config.listing_date)
    return [date for date in date_range_days(start, end_date) if is_weekday(date)]


class PriceProvider:
    def __init__(self, fixture_dir: Path | None = None, no_live: bool = False) -> None:
        self.fixture_dir = fixture_dir
        self.no_live = no_live
        self.cache: dict[tuple[str, str, str], dict[str, float]] = {}
        self.fixture_prices = self._load_fixture_prices(fixture_dir) if fixture_dir else {}
        self.errors: dict[str, str] = {}

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
        if ticker in self.fixture_prices:
            return {date: value for date, value in self.fixture_prices[ticker].items() if start_date <= date <= end_date}
        if self.no_live:
            return {}
        key = (ticker, start_date, end_date)
        if key in self.cache:
            return self.cache[key]
        try:
            data = self._fetch_yahoo_chart(ticker, start_date, end_date)
            self.cache[key] = data
            return data
        except Exception as exc:  # best effort; status file captures the failure.
            self.errors[ticker] = str(exc)
            self.cache[key] = {}
            return {}

    def _fetch_yahoo_chart(self, ticker: str, start_date: str, end_date: str) -> dict[str, float]:
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
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?{params}"
        text = http_get(url, accept="application/json,text/plain,*/*", timeout=20)
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

    def return_between(self, ticker: str | None, start_date: str, end_date: str) -> tuple[float | None, dict[str, Any]]:
        if not ticker:
            return None, {"reason": "not_price_tracked"}
        if end_date <= start_date:
            return None, {"reason": "stale_price_basis", "startDate": start_date, "endDate": end_date}
        closes = self.close_map(ticker, start_date, end_date)
        start_close = nearest_close_on_or_before(closes, start_date)
        end_close = nearest_close_on_or_before(closes, end_date)
        if start_close is None or end_close is None or start_close[1] == 0:
            return None, {"reason": "missing_close", "startDate": start_date, "endDate": end_date}
        if end_close[0] <= start_close[0]:
            return None, {
                "reason": "stale_close",
                "startDate": start_date,
                "endDate": end_date,
                "startCloseDate": start_close[0],
                "endCloseDate": end_close[0],
            }
        value = (end_close[1] / start_close[1]) - 1
        return value, {"start": {"date": start_close[0], "close": start_close[1]}, "end": {"date": end_close[0], "close": end_close[1]}}


def nearest_close_on_or_before(closes: dict[str, float], target_date: str) -> tuple[str, float] | None:
    candidates = [(date, value) for date, value in closes.items() if date <= target_date and math.isfinite(value)]
    if not candidates:
        return None
    return sorted(candidates, key=lambda item: item[0])[-1]


def compute_pair_decomposition(prev: dict[str, Any] | None, current: dict[str, Any], price_provider: PriceProvider) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    if not prev:
        rows = []
        for holding in current.get("top10", []):
            rows.append({
                "date": current["date"],
                "name": holding.get("name"),
                "ticker": holding.get("ticker"),
                "rank": holding.get("rank"),
                "actualWeightPercent": holding.get("weightPercent"),
                "classification": "insufficient_data",
                "confidence": "low",
                "message": "첫 추적 스냅샷이라 전일 비교가 없습니다.",
            })
        return rows, [], {"returnCoverage": 0, "returnCoverageStatus": "insufficient", "benchmarkReturn": None}

    prev_top = prev.get("top10", [])
    curr_top = current.get("top10", [])
    prev_map = {holding_key(row): row for row in prev_top}
    curr_map = {holding_key(row): row for row in curr_top}
    prev_date = str(prev.get("date"))
    curr_date = str(current.get("date"))
    prev_price_basis = str(prev.get("priceBasisDate") or previous_weekday(prev_date))
    curr_price_basis = str(current.get("priceBasisDate") or previous_weekday(curr_date))

    returns: dict[str, tuple[float | None, dict[str, Any]]] = {}
    for key, row in {**prev_map, **curr_map}.items():
        returns[key] = price_provider.return_between(row.get("ticker"), prev_price_basis, curr_price_basis)

    total_prev_weight = sum(float(row.get("weightPercent") or 0) for row in prev_top)
    valid_prev_weight = sum(float(row.get("weightPercent") or 0) for key, row in prev_map.items() if returns.get(key, (None,))[0] is not None)
    coverage = (valid_prev_weight / total_prev_weight) if total_prev_weight else 0

    benchmark_numerator = 0.0
    for key, row in prev_map.items():
        security_return = returns.get(key, (None,))[0]
        if security_return is None:
            continue
        benchmark_numerator += float(row.get("weightPercent") or 0) * security_return
    benchmark_return = benchmark_numerator / valid_prev_weight if valid_prev_weight else None

    decompositions: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []

    for curr in curr_top:
        key = holding_key(curr)
        prev_row = prev_map.get(key)
        actual = parse_number(curr.get("weightPercent"))
        rank = curr.get("rank")
        base = {
            "date": curr_date,
            "previousDate": prev_date,
            "name": curr.get("name"),
            "ticker": curr.get("ticker"),
            "rank": rank,
            "previousRank": prev_row.get("rank") if prev_row else None,
            "actualWeightPercent": actual,
            "previousWeightPercent": parse_number(prev_row.get("weightPercent")) if prev_row else None,
        }
        if not prev_row:
            row = {**base, "classification": "new_entry", "confidence": "high", "message": "TOP10 신규 편입"}
            decompositions.append(row)
            signals.append(signal_from_row(row, "top10_entry", "high"))
            continue
        prev_weight = parse_number(prev_row.get("weightPercent"))
        security_return, price_meta = returns.get(key, (None, {}))
        if actual is None or prev_weight is None or security_return is None or benchmark_return is None:
            row = {
                **base,
                "securityReturn": security_return,
                "priceMeta": price_meta,
                "classification": "insufficient_data",
                "confidence": "low",
                "message": "종가 또는 비중 데이터가 부족해 분해하지 못했습니다.",
            }
            decompositions.append(row)
            continue

        predicted = 100 * ((prev_weight / 100) * (1 + security_return)) / (1 + benchmark_return)
        delta_actual = actual - prev_weight
        delta_price = predicted - prev_weight
        residual = delta_actual - delta_price
        tolerance = max(PRICE_EXPLAINED_TOLERANCE_PP, abs(prev_weight) * PRICE_EXPLAINED_TOLERANCE_RATIO)
        classification = "price_explained"
        message = "가격 수익률로 대부분 설명됩니다."
        confidence = "high"
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
            "classification": classification,
            "confidence": confidence,
            "message": message,
        }
        decompositions.append(row)
        if classification in {"likely_buy", "likely_sell", "mixed"}:
            signals.append(signal_from_row(row, classification, "medium" if classification != "mixed" else "low"))

    for key, prev_row in prev_map.items():
        if key in curr_map:
            continue
        row = {
            "date": curr_date,
            "previousDate": prev_date,
            "name": prev_row.get("name"),
            "ticker": prev_row.get("ticker"),
            "rank": None,
            "previousRank": prev_row.get("rank"),
            "actualWeightPercent": None,
            "previousWeightPercent": prev_row.get("weightPercent"),
            "classification": "exit",
            "confidence": "high",
            "message": "TOP10에서 편출되었습니다.",
        }
        decompositions.append(row)
        signals.append(signal_from_row(row, "top10_exit", "high"))

    summary = {
        "returnCoverage": coverage,
        "returnCoverageStatus": "ok" if coverage >= RETURN_COVERAGE_MIN else "low",
        "benchmarkReturn": benchmark_return,
        "priceBasis": {"previous": prev_price_basis, "current": curr_price_basis},
        "priceErrors": price_provider.errors,
    }
    return decompositions, signals, summary


def signal_from_row(row: dict[str, Any], signal_type: str, severity: str) -> dict[str, Any]:
    return {
        "date": row.get("date"),
        "previousDate": row.get("previousDate"),
        "type": signal_type,
        "severity": severity,
        "name": row.get("name"),
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
    for config in ETFS:
        rows = history.get(config.id, [])
        latest = rows[-1] if rows else None
        signals = latest.get("signals", []) if latest else []
        all_signals.extend({**signal, "etfId": config.id, "etfName": config.name} for signal in signals)
        dates = [row.get("date") for row in rows if row.get("date")]
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
            "prices": "Yahoo Finance best-effort adjusted daily closes",
            "confidenceRule": "returnCoverage below 60% is marked mixed/low confidence",
        },
        "updatePolicy": {
            "timezone": "Asia/Seoul",
            "primary": "08:05 KST",
            "retries": ["09:30 KST", "11:00 KST", "13:00 KST"],
            "cronUtc": ["5 23 * * 0-5", "30 0 * * 1-6", "0 2 * * 1-6", "0 4 * * 1-6"],
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
        is_waiting = (
            source_status in {"missing", "empty", "error", "stale"}
            or analysis.get("returnCoverageStatus") == "low"
            or latest_date != target_date
            or target_status in {"missing", "empty", "error", "stale"}
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
        if item.get("targetFetchStatus") not in {"live"}:
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
        writer = csv.writer(handle)
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
        for target in dates_to_fetch(config, args.target_date, backfill_all=args.backfill_all, backfill_days=args.backfill_days):
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
