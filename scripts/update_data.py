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
import urllib.error
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

KST = dt.timezone(dt.timedelta(hours=9), name="KST")
USER_AGENT = "Mozilla/5.0 (compatible; ETFTrackingBot/0.1; +https://sonchanggi.github.io/etf-tracking/)"
SCHEMA_VERSION = "1.3.0"
DEFAULT_SCHEDULED_BACKFILL_DAYS = 10
PRICE_ALIGNED_TOLERANCE_PP = 0.10
PRICE_ALIGNED_TOLERANCE_RATIO = 0.03
RESIDUAL_ACTION_TOLERANCE_PP = 0.35
RESIDUAL_ACTION_TOLERANCE_RATIO = 0.10
RETURN_COVERAGE_MIN = 0.60
HTTP_MAX_BYTES = 5_000_000
PRICE_CACHE_FORWARD_DAYS = 21
PUBLIC_ANALYSIS_SUMMARY_FIELDS = (
    "returnCoverage",
    "returnCoverageStatus",
    "returnCoverageUniverse",
    "benchmarkUniverse",
    "validReturnWeightPercent",
    "totalReturnWeightPercent",
    "unpricedReturnWeightPercent",
    "benchmarkReturn",
    "fullHoldingCount",
    "previousFullHoldingCount",
    "fullHoldingsAvailable",
    "previousFullHoldingsAvailable",
    "currentHoldingsUniverse",
    "previousHoldingsUniverse",
    "priceBasis",
    "dateBasis",
    "decompositionFormula",
    "decompositionFormulaCaveat",
    "residualClassificationPolicy",
)
PUBLIC_DECOMPOSITION_DROP_FIELDS = {"priceMeta"}
PUBLIC_HOLDING_DROP_FIELDS = {"sourceFields"}
PUBLIC_HISTORY_HOLDING_FIELDS = ("rank", "codeRaw", "ticker", "name", "shares", "marketValueKrw", "weightPercent")
PUBLIC_SNAPSHOT_DROP_FIELDS = {"queryDate", "navAsOfDate", "sourceConfidence", "sourceWarning", "totalHoldings", "fetchedAt"}
HISTORY_DIR_NAME = "history"


FX_PAIR_CONFIG: dict[str, dict[str, Any]] = {
    "USDKRW": {
        "currency": "USD",
        "label": "USD/KRW",
        "yahoo": ["KRW=X", "USDKRW=X"],
        "stooq": ["usdkrw"],
    },
    "JPYKRW": {
        "currency": "JPY",
        "label": "JPY/KRW",
        "yahoo": ["JPYKRW=X"],
        "stooq": ["jpykrw"],
    },
    "HKDKRW": {
        "currency": "HKD",
        "label": "HKD/KRW",
        "yahoo": ["HKDKRW=X"],
        "stooq": ["hkdkrw"],
    },
}


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


def is_rate_limited_error(error: BaseException) -> bool:
    return isinstance(error, urllib.error.HTTPError) and error.code == 429


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


def holdings_universe(snapshot: dict[str, Any] | None) -> tuple[list[dict[str, Any]], str, bool]:
    if not snapshot:
        return [], "none", False
    holdings = snapshot.get("holdings")
    if isinstance(holdings, list) and holdings:
        return [row for row in holdings if isinstance(row, dict)], "full_holdings", True
    top10 = snapshot.get("top10")
    if isinstance(top10, list) and top10:
        return [row for row in top10 if isinstance(row, dict)], "top10_fallback", False
    return [], "none", False


def source_status_rank(status: Any) -> int:
    return {
        "live": 4,
        "cached_live": 4,
        "cached_history": 3,
        "stale": 2,
        "empty": 1,
        "error": 1,
        "missing": 0,
    }.get(str(status or ""), 0)


def snapshot_is_live_for_target(raw: dict[str, Any], target: str) -> bool:
    as_of = str(raw.get("asOfDate") or raw.get("date") or "")
    query_date = str(raw.get("queryDate") or target)
    return (
        raw.get("sourceStatus") == "live"
        and bool(raw.get("top10"))
        and as_of == target
        and query_date == target
    )


def history_snapshot_is_usable(snapshot: dict[str, Any], expected_date: str | None = None) -> bool:
    if not snapshot.get("top10") or str(snapshot.get("sourceStatus") or "") != "live":
        return False
    date = str(snapshot.get("date") or snapshot.get("asOfDate") or "")
    query_date = snapshot.get("queryDate")
    if not date:
        return False
    if expected_date and date != expected_date:
        return False
    if expected_date:
        return not query_date or str(query_date) == expected_date
    return not query_date or str(query_date) == date


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

    actual_date_warning = ""
    if requested_date and query_date != requested_date:
        actual_date_warning = f"Requested {requested_date}, provider returned {query_date}."
    source_status = "live" if holdings and not actual_date_warning else ("stale" if holdings else "empty")
    warning = actual_date_warning if holdings else "TIME provider returned no constituent rows for the requested date."
    return {
        "etfId": config.id,
        "asOfDate": query_date,
        "queryDate": requested_date or query_date,
        "navAsOfDate": nav_as_of_date,
        "priceBasisDate": previous_weekday(query_date),
        "listingDate": listing_date,
        "sourceStatus": source_status,
        "sourceConfidence": "high" if source_status == "live" else ("medium" if holdings else "low"),
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


def public_holding(row: dict[str, Any], *, compact: bool = False) -> dict[str, Any]:
    if compact:
        compacted = {key: row[key] for key in PUBLIC_HISTORY_HOLDING_FIELDS if key in row and row[key] is not None}
        if compacted.get("ticker"):
            compacted.pop("codeRaw", None)
            compacted.pop("name", None)
        return compacted
    return {key: value for key, value in row.items() if key not in PUBLIC_HOLDING_DROP_FIELDS}


def public_decomposition_row(row: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if key not in PUBLIC_DECOMPOSITION_DROP_FIELDS}


def public_analysis_summary(summary: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(summary, dict):
        return {}
    return {key: summary[key] for key in PUBLIC_ANALYSIS_SUMMARY_FIELDS if key in summary}


def public_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    sanitized = {key: value for key, value in snapshot.items() if key not in PUBLIC_SNAPSHOT_DROP_FIELDS}
    sanitized["holdings"] = [public_holding(row, compact=True) for row in as_records(snapshot.get("holdings"))]
    sanitized["top10"] = [public_holding(row) for row in as_records(snapshot.get("top10"))]
    sanitized["decomposition"] = [public_decomposition_row(row) for row in as_records(snapshot.get("decomposition"))]
    sanitized["signals"] = [dict(row) for row in as_records(snapshot.get("signals"))]
    sanitized["analysisSummary"] = public_analysis_summary(snapshot.get("analysisSummary"))
    return sanitized


def stored_holding(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in row.items()
        if key not in PUBLIC_HOLDING_DROP_FIELDS and value is not None
    }


def stored_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Return the replay-safe public history record.

    Dashboard/latest payloads stay intentionally slim, but future updater runs use
    committed history as their source of truth.  Therefore per-ETF history keeps
    provider/date provenance and holding identifiers while still stripping heavy
    diagnostics and raw source fields that are only useful during a single run.
    """
    date = str(snapshot.get("date") or snapshot.get("asOfDate") or "")
    sanitized = {
        key: value
        for key, value in snapshot.items()
        if key not in {"holdings", "top10", "decomposition", "signals", "analysisSummary"}
        and value is not None
    }
    if date:
        sanitized["date"] = date
        sanitized.setdefault("queryDate", date)
        sanitized.setdefault("priceBasisDate", previous_weekday(date))
    sanitized["holdings"] = [stored_holding(row) for row in as_records(snapshot.get("holdings"))]
    sanitized["top10"] = [stored_holding(row) for row in as_records(snapshot.get("top10"))]
    sanitized["decomposition"] = [public_decomposition_row(row) for row in as_records(snapshot.get("decomposition"))]
    sanitized["signals"] = [dict(row) for row in as_records(snapshot.get("signals"))]
    sanitized["analysisSummary"] = public_analysis_summary(snapshot.get("analysisSummary"))
    return sanitized


def public_history(history: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    return {config.id: [public_snapshot(snapshot) for snapshot in history.get(config.id, [])] for config in ETFS}


def stored_history(history: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    return {config.id: [stored_snapshot(snapshot) for snapshot in history.get(config.id, [])] for config in ETFS}


def as_records(value: Any) -> list[dict[str, Any]]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def history_url_for(config: EtfConfig) -> str:
    return f"data/{HISTORY_DIR_NAME}/{config.id}.json"


def history_path_for(output_dir: Path, config: EtfConfig) -> Path:
    return output_dir / HISTORY_DIR_NAME / f"{config.id}.json"


def coerce_loaded_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    row = dict(snapshot)
    date = row.get("date") or row.get("asOfDate")
    if date:
        row["date"] = str(date)
        row.setdefault("queryDate", str(date))
        row.setdefault("priceBasisDate", previous_weekday(str(date)))
    return row


def history_rows_from_payload(payload: Any, config: EtfConfig) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict):
        if isinstance(payload.get("history"), list):
            rows = payload["history"]
        elif isinstance(payload.get("etfs"), dict):
            rows = payload["etfs"].get(config.id, [])
        else:
            rows = []
    else:
        rows = []
    return [coerce_loaded_snapshot(row) for row in rows if isinstance(row, dict)]


def load_history(output_dir: Path) -> dict[str, list[dict[str, Any]]]:
    history: dict[str, list[dict[str, Any]]] = {config.id: [] for config in ETFS}
    loaded_per_etf = False
    for config in ETFS:
        path = history_path_for(output_dir, config)
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
            history[config.id] = history_rows_from_payload(payload, config)
            loaded_per_etf = True
    if loaded_per_etf:
        return history

    path = output_dir / "history.json"
    if not path.exists():
        return history
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("etfs"), list):
        for item in payload["etfs"]:
            if not isinstance(item, dict):
                continue
            config = next((cfg for cfg in ETFS if cfg.id == item.get("id")), None)
            history_url = str(item.get("historyUrl") or "")
            if config and history_url.startswith(f"data/{HISTORY_DIR_NAME}/"):
                candidate = output_dir / history_url.removeprefix("data/")
                if candidate.exists():
                    history[config.id] = history_rows_from_payload(json.loads(candidate.read_text(encoding="utf-8")), config)
        return history
    if isinstance(payload, dict) and isinstance(payload.get("etfs"), dict):
        raw = payload.get("etfs", {})
        return {config.id: history_rows_from_payload(raw.get(config.id, []), config) for config in ETFS}
    return history


def merge_history(existing: dict[str, list[dict[str, Any]]], snapshots: dict[str, list[dict[str, Any]]]) -> dict[str, list[dict[str, Any]]]:
    merged: dict[str, list[dict[str, Any]]] = {}
    for config in ETFS:
        by_date: dict[str, dict[str, Any]] = {}
        for snap in existing.get(config.id, []):
            date = snap.get("date") or snap.get("asOfDate")
            if date and history_snapshot_is_usable(snap):
                by_date[str(date)] = snap
        for snap in snapshots.get(config.id, []):
            if not history_snapshot_is_usable(snap):
                continue
            date = str(snap["date"])
            current = by_date.get(date)
            if current and source_status_rank(current.get("sourceStatus")) > source_status_rank(snap.get("sourceStatus")):
                continue
            by_date[date] = snap
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


def snapshot_has_usable_data(snapshot: dict[str, Any] | None, expected_date: str | None = None) -> bool:
    if not snapshot:
        return False
    return history_snapshot_is_usable(snapshot, expected_date)


def cached_snapshot_diagnostic(snapshot: dict[str, Any], target: str, run_target_date: str) -> dict[str, Any]:
    is_target = target == run_target_date
    return {
        "date": snapshot.get("date") or target,
        "targetDate": target,
        "queryDate": snapshot.get("queryDate") or target,
        "sourceStatus": "cached_live" if is_target else "cached_history",
        "sourceConfidence": snapshot.get("sourceConfidence") or "high",
        "sourceWarning": "Existing usable snapshot reused; pass --refresh-existing to refetch this date.",
        "hasTop10": bool(snapshot.get("top10")),
        "top10Count": len(snapshot.get("top10", [])),
        "holdingCount": len(all_holdings(snapshot)),
        "fetchedAt": snapshot.get("fetchedAt"),
        "skippedFetch": True,
    }


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
        if self.no_live or (self.fixture_dir and ticker not in self.fixture_prices):
            reason = "disabled" if self.no_live else "fixture_missing"
            series["attempts"].append({"source": "live_prices", "status": reason, "points": 0})
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
        if ticker in FX_PAIR_CONFIG:
            fx_symbols = FX_PAIR_CONFIG[ticker]
            providers = (
                ("yahoo_fx_query1", lambda: self._fetch_yahoo_chart_candidates(fx_symbols["yahoo"], start_date, end_date, host="query1.finance.yahoo.com")),
                ("yahoo_fx_query2", lambda: self._fetch_yahoo_chart_candidates(fx_symbols["yahoo"], start_date, end_date, host="query2.finance.yahoo.com")),
                ("stooq_fx_csv", lambda: self._fetch_stooq_csv_candidates(fx_symbols["stooq"], start_date, end_date)),
            )
        else:
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

    def _fetch_yahoo_chart_candidates(self, tickers: list[str], start_date: str, end_date: str, *, host: str) -> dict[str, float]:
        last_error: Exception | None = None
        for ticker in tickers:
            try:
                data = self._fetch_yahoo_chart(ticker, start_date, end_date, host=host)
            except Exception as exc:
                last_error = exc
                continue
            if data:
                return data
        if last_error:
            raise last_error
        return {}

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
        meta = item.get("meta", {}) if isinstance(item.get("meta"), dict) else {}
        timestamps = item.get("timestamp") or []
        quote = (item.get("indicators", {}).get("adjclose") or item.get("indicators", {}).get("quote") or [{}])[0]
        closes = quote.get("adjclose") or quote.get("close") or []
        out: dict[str, float] = {}
        timezone_name = str(meta.get("exchangeTimezoneName") or "UTC")
        is_fx = yahoo_symbol_is_fx(ticker)
        for stamp, close in zip(timestamps, closes):
            if close is None:
                continue
            value = float(close)
            if is_fx and not plausible_fx_close(ticker, value):
                continue
            date = yahoo_timestamp_date(int(stamp), timezone_name if is_fx else "UTC")
            out[date] = value
        # Keep provider calls gentle when backfilling many tickers.
        time.sleep(0.05)
        return out

    def _fetch_stooq_csv(self, ticker: str, start_date: str, end_date: str) -> dict[str, float]:
        return self._fetch_stooq_csv_candidates(stooq_symbol_candidates(ticker), start_date, end_date)

    def _fetch_stooq_csv_candidates(self, symbols: list[str], start_date: str, end_date: str) -> dict[str, float]:
        start_dt = dt.date.fromisoformat(start_date) - dt.timedelta(days=7)
        end_dt = dt.date.fromisoformat(end_date) + dt.timedelta(days=2)
        for symbol in symbols:
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

    def return_between_krw(self, ticker: str | None, start_date: str, end_date: str) -> tuple[float | None, dict[str, Any]]:
        local_return, local_meta = self.return_between(ticker, start_date, end_date)
        currency = currency_for_ticker(ticker)
        if local_return is None:
            if isinstance(local_meta, dict):
                local_meta["currency"] = currency
            return local_return, local_meta
        if currency == "KRW":
            local_meta["currency"] = currency
            local_meta["fxRequired"] = False
            local_meta.setdefault("sourceType", "external_close_krw")
            return local_return, local_meta
        pair = fx_pair_for_currency(currency)
        if pair not in FX_PAIR_CONFIG:
            local_meta.update({
                "currency": currency,
                "fxRequired": False,
                "fxApplied": False,
                "sourceType": "external_close_local_currency",
                "message": f"{currency} 환율 소스가 없어 현지통화 수익률만 사용했습니다.",
            })
            return local_return, local_meta

        fx_return, fx_meta = self.fx_return_between(currency, start_date, end_date)
        if fx_return is None:
            local_meta.update({
                "currency": currency,
                "fxRequired": True,
                "fxApplied": False,
                "fxMeta": fx_meta,
                "sourceType": "external_close_local_currency",
                "message": f"{currency} 종가 수익률만 사용했습니다. 환율 데이터를 찾지 못해 KRW 환산 정확도가 낮습니다.",
            })
            return local_return, local_meta

        combined = (1 + local_return) * (1 + fx_return) - 1
        sources = [str(local_meta.get("source") or "external_close"), str(fx_meta.get("source") or "fx")]
        return combined, {
            "source": "fx_adjusted_external_close",
            "sourceType": "external_close_fx_adjusted_krw",
            "localPriceSource": local_meta.get("source"),
            "currency": currency,
            "fxRequired": True,
            "fxApplied": True,
            "localCurrencyReturn": local_return,
            "fxReturn": fx_return,
            "fxPair": pair,
            "sourceChain": sources,
            "start": local_meta.get("start"),
            "end": local_meta.get("end"),
            "fxStart": fx_meta.get("start") if isinstance(fx_meta, dict) else None,
            "fxEnd": fx_meta.get("end") if isinstance(fx_meta, dict) else None,
            "fxMeta": fx_meta,
            "attempts": local_meta.get("attempts", []),
            "message": f"{currency} 종가 수익률에 {FX_PAIR_CONFIG[pair]['label']} 환율 수익률을 곱해 KRW 기준 가격효과를 계산했습니다.",
        }

    def fx_return_between(self, currency: str, start_date: str, end_date: str) -> tuple[float | None, dict[str, Any]]:
        pair = fx_pair_for_currency(currency)
        if pair == "KRW":
            return 0.0, {"source": "base_currency", "currency": "KRW", "fxApplied": False}
        if pair not in FX_PAIR_CONFIG:
            return None, {"reason": "unsupported_currency", "currency": currency, "fxPair": pair}
        value, meta = self.return_between(pair, start_date, end_date)
        if isinstance(meta, dict):
            meta["currency"] = currency
            meta["fxPair"] = pair
            meta["sourceType"] = "fx_close"
        return value, meta

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


def yahoo_symbol_is_fx(symbol: str) -> bool:
    upper = clean_text(symbol).upper()
    return upper.endswith("=X") or upper in {alias.upper() for config in FX_PAIR_CONFIG.values() for alias in config.get("yahoo", [])}


def yahoo_timestamp_date(timestamp: int, timezone_name: str) -> str:
    try:
        tz = ZoneInfo(timezone_name)
    except Exception:
        tz = dt.timezone.utc
    return dt.datetime.fromtimestamp(timestamp, tz=dt.timezone.utc).astimezone(tz).date().isoformat()


def plausible_fx_close(symbol: str, value: float) -> bool:
    if not math.isfinite(value) or value <= 0:
        return False
    upper = clean_text(symbol).upper()
    if "JPYKRW" in upper:
        return 5 <= value <= 20
    if "HKDKRW" in upper:
        return 100 <= value <= 300
    if "KRW" in upper or upper in {"KRW=X", "USDKRW=X"}:
        return 500 <= value <= 3000
    return True


def currency_for_ticker(ticker: str | None) -> str:
    raw = clean_text(ticker or "").upper()
    if not raw:
        return "UNKNOWN"
    if raw.endswith(".KS") or raw.endswith(".KQ"):
        return "KRW"
    if raw.endswith(".T"):
        return "JPY"
    if raw.endswith(".HK"):
        return "HKD"
    # Plain tickers in this project are US-listed securities by construction.
    return "USD"


def fx_pair_for_currency(currency: str | None) -> str:
    code = clean_text(currency or "").upper()
    if code == "KRW":
        return "KRW"
    for pair, config in FX_PAIR_CONFIG.items():
        if config.get("currency") == code:
            return pair
    return "UNSUPPORTED"


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


def attribution_thresholds(previous_weight_percent: float | None) -> dict[str, float]:
    """Return conservative residual thresholds in percentage points.

    The lower threshold marks a no-trade/price-aligned residual band.  The
    higher threshold is the first point at which the residual is large enough to
    display a directional buy/sell possibility.  Values between the two are
    deliberately classified as "watch" rather than "price explained" because ETF
    weights also embed cash, creations/redemptions, rounding, disclosure timing,
    and incomplete pricing universe effects.
    """
    base = abs(float(previous_weight_percent or 0))
    aligned = max(PRICE_ALIGNED_TOLERANCE_PP, base * PRICE_ALIGNED_TOLERANCE_RATIO)
    action = max(RESIDUAL_ACTION_TOLERANCE_PP, base * RESIDUAL_ACTION_TOLERANCE_RATIO)
    return {
        "priceAlignedTolerancePercentPoint": aligned,
        "residualActionTolerancePercentPoint": max(action, aligned),
    }


def classify_residual_signal(
    residual_percent_point: float,
    previous_weight_percent: float | None,
    *,
    coverage: float,
    return_coverage_universe: str,
    prev_full_holdings_available: bool,
    curr_full_holdings_available: bool,
    price_meta: dict[str, Any],
) -> dict[str, Any]:
    thresholds = attribution_thresholds(previous_weight_percent)
    aligned_tolerance = thresholds["priceAlignedTolerancePercentPoint"]
    action_tolerance = thresholds["residualActionTolerancePercentPoint"]
    abs_residual = abs(residual_percent_point)
    price_source = price_meta.get("source") if isinstance(price_meta, dict) else None
    price_source_type = price_meta.get("sourceType") if isinstance(price_meta, dict) else None
    confidence = "medium"
    if price_source == "provider_valuation_krw":
        message = "ETF 평가단가(KRW) 기반 no-trade 가격 효과가 우세합니다."
    elif price_source_type == "external_close_fx_adjusted_krw":
        message = "외부 종가와 환율을 반영한 KRW 기준 가격 효과가 우세합니다."
    else:
        message = "가격 효과가 우세하지만 외부 가격·환율·반올림 오차를 함께 봐야 합니다."
    if isinstance(price_meta, dict) and price_meta.get("fxRequired") and not price_meta.get("fxApplied"):
        message = "외부 종가 환율 보정이 부족해 잔차 신뢰도를 낮춰 해석해야 합니다."
        confidence = "low"
    if not prev_full_holdings_available or not curr_full_holdings_available:
        confidence = "low"
        message = f"전체 보유종목 대신 {return_coverage_universe} 기준의 부분 추정입니다. {message}"
    if coverage < RETURN_COVERAGE_MIN:
        return {
            **thresholds,
            "classification": "mixed",
            "economicSignal": "mixed",
            "actionEstimate": "undetermined",
            "actionLabel": "매수·매도 판단 보류",
            "actionExplanation": "종가 커버리지가 낮아 방향성 잔차를 매수·매도 가능성으로 해석하지 않습니다.",
            "confidence": "low",
            "residualBand": "low_coverage",
            "message": "종가 커버리지가 낮아 가격/매매 요인을 혼합 신호로 표시합니다.",
        }
    if abs_residual <= aligned_tolerance:
        return {
            **thresholds,
            "classification": "price_aligned",
            "economicSignal": "price_aligned",
            "actionEstimate": "price_aligned",
            "actionLabel": "매수·매도 추정 없음",
            "actionExplanation": "잔차가 가격 우세 허용구간 안에 있어 추가 매수·매도 방향을 추정하지 않습니다.",
            "confidence": confidence,
            "residualBand": "price_aligned",
            "message": message,
        }
    if residual_percent_point >= action_tolerance:
        return {
            **thresholds,
            "classification": "likely_buy",
            "economicSignal": "likely_buy",
            "actionEstimate": "likely_buy",
            "actionLabel": "매수 가능성",
            "actionExplanation": "실제 비중이 no-trade 예상비중보다 충분히 높아 추가 매수 또는 편입 확대 가능성이 있습니다.",
            "confidence": "medium",
            "residualBand": "directional_action",
            "message": "가격 효과 대비 비중 증가 잔차가 매수 가능성 임계치 이상입니다.",
        }
    if residual_percent_point <= -action_tolerance:
        return {
            **thresholds,
            "classification": "likely_sell",
            "economicSignal": "likely_sell",
            "actionEstimate": "likely_sell",
            "actionLabel": "매도·축소 가능성",
            "actionExplanation": "실제 비중이 no-trade 예상비중보다 충분히 낮아 매도 또는 편입 축소 가능성이 있습니다.",
            "confidence": "medium",
            "residualBand": "directional_action",
            "message": "가격 효과 대비 비중 감소 잔차가 매도/축소 가능성 임계치 이상입니다.",
        }
    action_estimate = "weak_sell_watch" if residual_percent_point < 0 else "weak_buy_watch"
    action_label = "약한 매도·축소 관찰" if residual_percent_point < 0 else "약한 매수 관찰"
    action_explanation = (
        "실제 비중이 no-trade 예상비중보다 낮아 매도·축소 쪽 잔차가 보이지만, 추정 임계치에는 미달합니다."
        if residual_percent_point < 0
        else "실제 비중이 no-trade 예상비중보다 높아 매수 쪽 잔차가 보이지만, 추정 임계치에는 미달합니다."
    )
    return {
        **thresholds,
        "classification": "residual_watch",
        "economicSignal": "residual_watch",
        "actionEstimate": action_estimate,
        "actionLabel": action_label,
        "actionExplanation": action_explanation,
        "confidence": "medium" if confidence != "low" else "low",
        "residualBand": "watch",
        "message": f"{action_label}: 매수·매도 추정 임계치에는 미달해 관찰 신호로 표시합니다.",
    }


def compute_pair_decomposition(prev: dict[str, Any] | None, current: dict[str, Any], price_provider: PriceProvider) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    current_top = current.get("top10", [])
    if not prev:
        curr_date = str(current.get("date"))
        curr_price_basis = str(current.get("priceBasisDate") or previous_weekday(curr_date))
        curr_universe, curr_universe_source, curr_full_holdings_available = holdings_universe(current)
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
            "returnCoverageUniverse": curr_universe_source,
            "benchmarkUniverse": curr_universe_source,
            "fullHoldingsAvailable": curr_full_holdings_available,
            "previousFullHoldingsAvailable": False,
            "validReturnWeightPercent": 0,
            "totalReturnWeightPercent": sum(float(row.get("weightPercent") or 0) for row in curr_universe),
            "unpricedReturnWeightPercent": sum(float(row.get("weightPercent") or 0) for row in curr_universe),
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
    prev_all, prev_universe_source, prev_full_holdings_available = holdings_universe(prev)
    curr_all, curr_universe_source, curr_full_holdings_available = holdings_universe(current)
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
    prior_price_errors = dict(price_provider.errors)
    prior_diagnostic_counts = {ticker: len(items) for ticker, items in price_provider.diagnostics.items()}

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

        security_return, price_meta = price_provider.return_between_krw(ticker, prev_price_basis, curr_price_basis)
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
    unpriced_prev_weight = max(total_prev_weight - valid_prev_weight, 0)
    if prev_universe_source == curr_universe_source:
        benchmark_universe = prev_universe_source
    else:
        benchmark_universe = f"{prev_universe_source}_to_{curr_universe_source}"
    if unpriced_prev_weight > 0 and benchmark_universe == "full_holdings":
        return_coverage_universe = "priced_subset_of_full_holdings"
    elif unpriced_prev_weight > 0 and benchmark_universe == "top10_fallback":
        return_coverage_universe = "priced_subset_of_top10_fallback"
    else:
        return_coverage_universe = benchmark_universe

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
        price_source = price_meta.get("source") if isinstance(price_meta, dict) else None
        price_source_type = price_meta.get("sourceType") if isinstance(price_meta, dict) else None
        signal = classify_residual_signal(
            residual,
            prev_weight,
            coverage=coverage,
            return_coverage_universe=return_coverage_universe,
            prev_full_holdings_available=prev_full_holdings_available,
            curr_full_holdings_available=curr_full_holdings_available,
            price_meta=price_meta,
        )
        classification = signal["classification"]
        message = signal["message"]
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
            "priceAlignedTolerancePercentPoint": signal["priceAlignedTolerancePercentPoint"],
            "residualActionTolerancePercentPoint": signal["residualActionTolerancePercentPoint"],
            "tolerancePercentPoint": signal["residualActionTolerancePercentPoint"],
            "residualBand": signal["residualBand"],
            "actionEstimate": signal["actionEstimate"],
            "actionLabel": signal["actionLabel"],
            "actionExplanation": signal["actionExplanation"],
            "returnCoverage": coverage,
            "priceMeta": price_meta,
            "priceReturnStartDate": price_meta.get("start", {}).get("date") if isinstance(price_meta.get("start"), dict) else prev_price_basis,
            "priceReturnEndDate": price_meta.get("end", {}).get("date") if isinstance(price_meta.get("end"), dict) else curr_price_basis,
            "priceSource": price_source,
            "priceSourceType": price_source_type,
            "currency": price_meta.get("currency") if isinstance(price_meta, dict) else None,
            "fxApplied": price_meta.get("fxApplied") if isinstance(price_meta, dict) else None,
            "fxPair": price_meta.get("fxPair") if isinstance(price_meta, dict) else None,
            "fxReturn": price_meta.get("fxReturn") if isinstance(price_meta, dict) else None,
            "localCurrencyReturn": price_meta.get("localCurrencyReturn") if isinstance(price_meta, dict) else None,
            "attributionFormula": "previousWeightPercent * (1 + securityReturnKrw) / (1 + pricedBenchmarkReturn)",
            "classification": classification,
            "economicSignal": signal["economicSignal"],
            "confidence": signal["confidence"],
            "message": message,
        }
        decompositions.append(row)
        if membership_change:
            signals.append(signal_from_row(row, membership_change, "high"))
        if classification in {"likely_buy", "likely_sell", "residual_watch", "mixed"}:
            signals.append(signal_from_row(row, classification, "medium" if classification != "mixed" else "low"))

    pair_price_errors = {
        ticker: error
        for ticker, error in price_provider.errors.items()
        if prior_price_errors.get(ticker) != error
    }
    pair_price_diagnostics = {
        ticker: items[prior_diagnostic_counts.get(ticker, 0):]
        for ticker, items in price_provider.diagnostics.items()
        if len(items) > prior_diagnostic_counts.get(ticker, 0)
    }

    summary = {
        "returnCoverage": coverage,
        "returnCoverageStatus": "ok" if coverage >= RETURN_COVERAGE_MIN else "low",
        "returnCoverageUniverse": return_coverage_universe,
        "benchmarkUniverse": benchmark_universe,
        "validReturnWeightPercent": valid_prev_weight,
        "totalReturnWeightPercent": total_prev_weight,
        "unpricedReturnWeightPercent": unpriced_prev_weight,
        "benchmarkReturn": benchmark_return,
        "fullHoldingCount": len(curr_all),
        "previousFullHoldingCount": len(prev_all),
        "fullHoldingsAvailable": curr_full_holdings_available,
        "previousFullHoldingsAvailable": prev_full_holdings_available,
        "currentHoldingsUniverse": curr_universe_source,
        "previousHoldingsUniverse": prev_universe_source,
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
        "decompositionFormula": "predictedWeightPercent = previousWeightPercent * (1 + securityReturnKrw) / (1 + pricedBenchmarkReturn); residual = actualWeightChange - priceEffect",
        "decompositionFormulaCaveat": "pricedBenchmarkReturn is a previous-weighted return of holdings with valid prices, not a directly observed ETF NAV return; residuals may include trading, cash, creations/redemptions, disclosure timing, rounding, and unpriced holdings.",
        "residualClassificationPolicy": {
            "priceAlignedTolerance": f"max({PRICE_ALIGNED_TOLERANCE_PP}pp, previousWeightPercent × {PRICE_ALIGNED_TOLERANCE_RATIO})",
            "directionalActionTolerance": f"max({RESIDUAL_ACTION_TOLERANCE_PP}pp, previousWeightPercent × {RESIDUAL_ACTION_TOLERANCE_RATIO})",
            "labels": {
                "price_aligned": "small residual; price effect is dominant, not proof of no trade",
                "residual_watch": "residual direction is shown as weak buy or weak sell watch, but it is below the directional buy/sell threshold",
                "likely_buy_or_sell": "residual is at or beyond the directional threshold; still a possibility signal, not confirmed trading",
            },
        },
        "priceErrors": copy.deepcopy(pair_price_errors),
        "priceDiagnostics": copy.deepcopy(pair_price_diagnostics),
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
        "actionEstimate": row.get("actionEstimate"),
        "actionLabel": row.get("actionLabel"),
        "actionExplanation": row.get("actionExplanation"),
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


def source_availability(config: EtfConfig, rows: list[dict[str, Any]], generated_at: str) -> dict[str, Any]:
    dates = [str(row.get("date")) for row in rows if row.get("date")]
    available_start = min(dates) if dates else None
    available_end = max(dates) if dates else None
    possible_weekdays = dates_to_fetch(
        config,
        str(available_end or generated_at[:10]),
        backfill_all=True,
        backfill_days=1,
    ) if available_end else []
    stored_date_set = {str(date) for date in dates if date}
    coverage_ratio = (len(stored_date_set) / len(possible_weekdays)) if possible_weekdays else None
    continuity_label = "none"
    if available_start == config.listing_date:
        if coverage_ratio is not None and coverage_ratio >= 0.9:
            continuity_label = "listing_date_near_continuous"
        elif coverage_ratio is not None and coverage_ratio >= 0.5:
            continuity_label = "listing_date_partial"
        else:
            continuity_label = "listing_date_sparse"
    elif available_start:
        continuity_label = "partial_after_listing"
    return {
        "listingDate": config.listing_date,
        "oldestStoredDate": available_start,
        "latestStoredDate": available_end,
        "storedFromListingDate": available_start == config.listing_date,
        "continuityLabel": continuity_label,
        "storedWeekdayCount": len(stored_date_set),
        "possibleWeekdayCountThroughLatest": len(possible_weekdays),
        "coverageRatioThroughLatest": coverage_ratio,
        "note": "공급자 public holdings endpoint가 반환한 live 스냅샷만 저장합니다. 휴장일, 공급자 공백, rate limit 날짜는 다음 missing-only 백필에서 이어서 채웁니다.",
    }


def history_manifest(history: dict[str, list[dict[str, Any]]], generated_at: str) -> dict[str, Any]:
    etfs = []
    all_dates: list[str] = []
    for config in ETFS:
        rows = history.get(config.id, [])
        dates = [str(row.get("date")) for row in rows if row.get("date")]
        all_dates.extend(dates)
        availability = source_availability(config, rows, generated_at)
        etfs.append({
            "id": config.id,
            "name": config.name,
            "shortName": config.short_name,
            "code": config.code,
            "provider": config.provider,
            "listingDate": config.listing_date,
            "historyUrl": history_url_for(config),
            "historyCount": len(rows),
            "availableStartDate": min(dates) if dates else None,
            "availableEndDate": max(dates) if dates else None,
            "sourceAvailability": availability,
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "timezone": "Asia/Seoul",
        "description": "Manifest only. Full replay-safe histories are split into per-ETF files under data/history/ to keep GitHub Pages payloads below large-file limits.",
        "availableStartDate": min(all_dates) if all_dates else None,
        "availableEndDate": max(all_dates) if all_dates else None,
        "etfs": etfs,
    }


def write_history_outputs(output_dir: Path, history: dict[str, list[dict[str, Any]]], generated_at: str) -> dict[str, Any]:
    manifest = history_manifest(history, generated_at)
    history_dir = output_dir / HISTORY_DIR_NAME
    history_dir.mkdir(parents=True, exist_ok=True)
    for config in ETFS:
        rows = history.get(config.id, [])
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "generatedAt": generated_at,
            "id": config.id,
            "name": config.name,
            "shortName": config.short_name,
            "code": config.code,
            "provider": config.provider,
            "sourceUrl": config.source_url,
            "listingDate": config.listing_date,
            "historyCount": len(rows),
            "availableStartDate": rows[0].get("date") if rows else None,
            "availableEndDate": rows[-1].get("date") if rows else None,
            "sourceAvailability": source_availability(config, rows, generated_at),
            "latest": rows[-1] if rows else None,
            "history": rows,
        }
        write_json(history_path_for(output_dir, config), payload, compact=True)
    write_json(output_dir / "history.json", manifest, compact=False)
    return manifest


def build_dashboard(history: dict[str, list[dict[str, Any]]], summaries: dict[str, dict[str, Any]], generated_at: str) -> dict[str, Any]:
    etf_payloads = []
    all_signals: list[dict[str, Any]] = []
    all_dates: list[str] = []
    source_earliest_dates: dict[str, str | None] = {}
    for config in ETFS:
        rows = history.get(config.id, [])
        latest = rows[-1] if rows else None
        signals = latest.get("signals", []) if latest else []
        all_signals.extend({**signal, "etfId": config.id, "etfName": config.name} for signal in signals)
        dates = [str(row.get("date")) for row in rows if row.get("date")]
        all_dates.extend(dates)
        available_start = min(dates) if dates else None
        available_end = max(dates) if dates else None
        availability = source_availability(config, rows, generated_at)
        source_earliest_dates[config.id] = str(available_start) if available_start else None
        entry_exit_count = sum(1 for signal in signals if signal.get("type") in {"top10_entry", "top10_exit"})
        etf_payloads.append({
            "id": config.id,
            "name": config.name,
            "shortName": config.short_name,
            "code": config.code,
            "provider": config.provider,
            "sourceUrl": config.source_url,
            "listingDate": config.listing_date,
            "availableStartDate": available_start,
            "availableEndDate": available_end,
            "historyCount": len(rows),
            "historyUrl": history_url_for(config),
            "sourceAvailability": availability,
            "latest": latest,
            "signals": signals,
            "metrics": {
                "top10Count": len(latest.get("top10", [])) if latest else 0,
                "entryExitSignalCount": entry_exit_count,
                "signalCount": len(signals),
                "returnCoverage": summaries.get(config.id, {}).get("returnCoverage"),
                "returnCoverageStatus": summaries.get(config.id, {}).get("returnCoverageStatus"),
            },
        })
    severity_rank = {"high": 0, "medium": 1, "low": 2}
    sorted_signals = sorted(
        all_signals,
        key=lambda item: (item.get("date") or "", -severity_rank.get(str(item.get("severity") or ""), 9)),
        reverse=True,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "timezone": "Asia/Seoul",
        "disclaimer": "가격 수익률 분해는 추정이며 투자, 세무, 법률 또는 매매 조언이 아닙니다.",
        "sourcePolicy": {
            "holdings": "ETF provider public pages/APIs",
            "holdingsHistory": "Full provider holdings are persisted in per-ETF history files; TOP10 is a derived dashboard view.",
            "prices": "For attribution, ETF provider valuation-per-share KRW is preferred when available because ETF weights are KRW NAV weights; otherwise the updater falls back to local fixtures, Yahoo Chart query1/query2 adjusted closes, Stooq CSV, and optional FinanceDataReader.",
            "fx": "External USD/JPY/HKD closes are converted to KRW returns with direct FX series where available: Yahoo Chart FX first, then Stooq FX CSV. Google Finance is not used in automation because it lacks a stable historical HTTP API.",
            "googleFinance": "Google Finance has no stable public historical HTTP API in this updater; use it only as manual cross-check outside GitHub Actions automation.",
            "dateBasis": "ETF disclosed weight date is Korean-calendar based; return intervals use previous/current priceBasisDate valuation dates recorded on each decomposition row.",
            "attribution": "No-trade predicted weight = previous weight × (1 + KRW-adjusted security return) / (1 + priced benchmark return). The benchmark is the previous-weighted priced holdings universe, not an observed ETF NAV return; residual is actual weight change minus this model price effect.",
            "confidenceRule": "Price-aligned means the residual is small, not fully proven no-trade. Residuals between the aligned threshold and directional threshold are marked residual_watch; only residuals at or beyond the directional threshold become likely_buy/likely_sell possibility signals.",
        },
        "updatePolicy": {
            "timezone": "Asia/Seoul",
            "primary": "09:00 KST Tue-Sat scheduled refresh plus reviewed workflow_dispatch",
            "retries": ["12:00 KST Tue-Sat", "18:00 KST Tue-Sat"],
            "cronUtc": ["0 0 * * 2-6", "0 3 * * 2-6", "0 9 * * 2-6"],
        },
        "historyPolicy": {
            "availableStartDate": min(all_dates) if all_dates else None,
            "availableEndDate": max(all_dates) if all_dates else None,
            "sourceEarliestStoredDates": source_earliest_dates,
            "scheduledLookbackDays": DEFAULT_SCHEDULED_BACKFILL_DAYS,
            "missingOnlyDefault": True,
            "historyManifestUrl": "data/history.json",
            "historyStorage": "per_etf_lazy_files",
            "startDateExplanation": "2026-04-01은 공급자 한계가 아니라 이전 커밋의 백필 범위였습니다. 현재는 공급자 public holdings endpoint가 live로 반환한 상장일 이후 usable 스냅샷을 저장하며, 공급자 공백·휴장일·rate limit 날짜는 missing-only 백필에서 이어서 채웁니다. 다만 상장일 스냅샷이 있어도 coverage가 낮으면 연속 시계열이 아니라 희소 백필로 표시합니다.",
            "manualBackfillStartDate": "--backfill-start-date YYYY-MM-DD",
            "manualBackfillAll": "--backfill-all",
            "manualRefreshExisting": "--refresh-existing",
            "fetchOrder": "공급자 throttling이 최신 스냅샷을 가리지 않도록 목표일을 먼저 확인하고, 이미 저장된 usable 스냅샷은 재요청하지 않은 뒤 없는 날짜만 채웁니다.",
            "payloadTradeoff": "상장일 이후 전체 백필 명령은 지원하지만, 기본 수동 실행은 정적 JSON 용량과 공급자 요청 제한을 피하기 위해 작은 rolling window만 갱신합니다. 상세 히스토리는 ETF 선택 시 별도 파일로 불러옵니다.",
        },
        "manualUpdatePolicy": {
            "workflowUrl": "https://github.com/SonChangGi/etf-tracking/actions/workflows/update-data.yml",
            "workflowFile": "update-data.yml",
            "cliCommand": "gh workflow run update-data.yml --repo SonChangGi/etf-tracking --ref main -f backfill_all=false -f backfill_start_date= -f refresh_existing=false -f strict_validation=false",
            "security": "Public static pages do not store GitHub tokens; the button opens GitHub's authenticated workflow_dispatch screen.",
            "defaultMode": "missing_only",
        },
        "etfs": etf_payloads,
        "signals": sorted_signals[:50],
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


def build_public_summary(dashboard: dict[str, Any]) -> dict[str, Any]:
    """Build the compact cross-project summary consumed by quant-dashboard."""

    etfs = dashboard.get("etfs") if isinstance(dashboard.get("etfs"), list) else []
    signals = dashboard.get("signals") if isinstance(dashboard.get("signals"), list) else []
    latest_dates = [
        str((etf.get("latest") or {}).get("date"))
        for etf in etfs
        if isinstance(etf, dict) and isinstance(etf.get("latest"), dict) and (etf.get("latest") or {}).get("date")
    ]
    low_coverage = []
    primary_entities = []
    for etf in etfs:
        if not isinstance(etf, dict):
            continue
        latest = etf.get("latest") if isinstance(etf.get("latest"), dict) else {}
        metrics = etf.get("metrics") if isinstance(etf.get("metrics"), dict) else {}
        coverage = metrics.get("returnCoverage")
        if isinstance(coverage, (int, float)) and coverage < RETURN_COVERAGE_MIN:
            low_coverage.append(etf.get("shortName") or etf.get("name") or etf.get("id"))
        for holding in (latest.get("top10") or [])[:10]:
            if not isinstance(holding, dict):
                continue
            primary_entities.append(
                {
                    "entityKey": f"{etf.get('id') or etf.get('code') or etf.get('shortName') or etf.get('name')}:{holding.get('ticker') or holding.get('codeRaw') or holding.get('name')}",
                    "symbol": holding.get("ticker") or holding.get("codeRaw"),
                    "name": holding.get("name"),
                    "label": f"{holding.get('ticker') or holding.get('codeRaw') or holding.get('name')} · {etf.get('shortName') or etf.get('name')}",
                    "sector": "ETF Holdings",
                    "sectorLabel": "ETF 보유종목",
                    "themes": ["ETF", "Active ETF", etf.get("shortName") or etf.get("name") or ""],
                    "metrics": {
                        "weight": holding.get("weight"),
                        "rank": holding.get("rank"),
                        "date": latest.get("date"),
                        "etf": etf.get("shortName") or etf.get("name"),
                        "returnCoverage": coverage,
                    },
                    "signals": ["TOP10 보유 노출입니다. residual signal은 실제 매매 증명이 아니라 가능성 신호입니다."],
                    "warnings": ["가격 정렬은 no-trade 증명이 아니며, 공급자 공시 지연이 있을 수 있습니다."],
                }
            )
    return {
        "schemaVersion": 1,
        "contract": "quant-research-summary",
        "projectId": "etf",
        "projectName": "ETF TOP10 Tracking",
        "generatedAt": dashboard.get("generatedAt"),
        "dataAsOf": max(latest_dates) if latest_dates else None,
        "timezone": dashboard.get("timezone") or "Asia/Seoul",
        "detailUrl": "https://sonchanggi.github.io/etf-tracking/",
        "detailDataUrl": "https://sonchanggi.github.io/etf-tracking/data/dashboard.json",
        "status": {
            "state": "degraded" if low_coverage else ("ok" if etfs else "degraded"),
            "label": f"{len(etfs)}개 ETF · {len(signals)}개 최근 신호",
            "cadence": "scheduled 09:00/12:00/18:00 KST Tue-Sat plus reviewed workflow_dispatch",
            "expectedFreshnessDays": 3,
            "degradedReasons": [f"low return coverage: {name}" for name in low_coverage],
        },
        "coverage": {
            "etfCount": len(etfs),
            "signalCount": len(signals),
            "historyStorage": (dashboard.get("historyPolicy") or {}).get("historyStorage"),
            "historyManifestUrl": (dashboard.get("historyPolicy") or {}).get("historyManifestUrl"),
        },
        "highlights": [
            {"label": "ETF", "value": len(etfs), "description": "한국 상장 액티브 ETF 추적"},
            {"label": "신호", "value": len(signals), "description": "편입·편출 및 residual possibility"},
            {"label": "최근 기준일", "value": max(latest_dates) if latest_dates else None, "description": "ETF별 latest date 기준"},
        ],
        "primaryEntities": primary_entities[:40],
        "limitations": [
            "Residual signal은 실제 매매 증명이 아니라 가능성 신호입니다.",
            "가격 정렬은 no-trade 증명이 아니며 provider 공시 지연이 있을 수 있습니다.",
            "상세 히스토리는 per-ETF lazy files에 분리되어 있습니다.",
        ],
        "sources": [
            {"label": "ETF provider public pages/APIs", "url": "https://sonchanggi.github.io/etf-tracking/"},
        ],
        "automation": {
            "workflowUrl": "https://github.com/SonChangGi/etf-tracking/actions/workflows/update-data.yml",
            "manualUpdateLabel": "GitHub Actions update-data 수동 실행",
            "tokenPolicy": "Static page keeps no GitHub token.",
        },
        "payload": {
            "summaryBytes": None,
            "detailBytes": None,
        },
    }


def diagnostic_requested_date(item: dict[str, Any]) -> str | None:
    value = item.get("targetDate", item.get("queryDate", item.get("date")))
    return str(value) if value else None


def build_status(
    history: dict[str, list[dict[str, Any]]],
    generated_at: str,
    price_provider: PriceProvider,
    target_date: str,
    diagnostics: dict[str, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    diagnostics = diagnostics or {config.id: [] for config in ETFS}
    etf_status = []
    waiting_for_target = False
    degraded = False
    latest_price_errors: dict[str, str] = {}
    for config in ETFS:
        latest = (history.get(config.id) or [None])[-1]
        source_status = latest.get("sourceStatus") if latest else "missing"
        analysis = latest.get("analysisSummary", {}) if latest else {}
        if isinstance(analysis.get("priceErrors"), dict):
            latest_price_errors.update({f"{config.id}:{ticker}": error for ticker, error in analysis["priceErrors"].items()})
        config_diagnostics = diagnostics.get(config.id, [])
        target_diagnostics = [item for item in config_diagnostics if diagnostic_requested_date(item) == target_date]
        historical_diagnostics = [item for item in config_diagnostics if diagnostic_requested_date(item) != target_date]
        target_diag = target_diagnostics[-1] if target_diagnostics else None
        latest_date = latest.get("date") if latest else None
        target_status = target_diag.get("sourceStatus") if target_diag else "not_attempted"
        target_has_top10 = bool(target_diag.get("hasTop10")) if target_diag else False
        target_warning = target_diag.get("sourceWarning") if target_diag else "No target-date fetch diagnostic available"
        skipped_fetch_count = sum(1 for item in config_diagnostics if item.get("skippedFetch"))
        fetched_count = sum(1 for item in config_diagnostics if not item.get("skippedFetch") and item.get("sourceStatus") == "live")
        historical_error_count = sum(1 for item in historical_diagnostics if item.get("sourceStatus") == "error")
        historical_rate_limited_count = sum(1 for item in historical_diagnostics if item.get("sourceStatus") == "rate_limited")
        historical_stale_count = sum(1 for item in historical_diagnostics if item.get("sourceStatus") == "stale")
        historical_mismatch_count = sum(1 for item in historical_diagnostics if item.get("dateMismatch"))
        target_error_count = sum(1 for item in target_diagnostics if item.get("sourceStatus") == "error")
        target_rate_limited_count = sum(1 for item in target_diagnostics if item.get("sourceStatus") == "rate_limited")
        target_stale_count = sum(1 for item in target_diagnostics if item.get("sourceStatus") == "stale")
        target_mismatch_count = sum(1 for item in target_diagnostics if item.get("dateMismatch"))
        reused_existing_target = (
            latest_date == target_date
            and source_status == "live"
            and bool(latest.get("top10") if latest else False)
            and target_status != "live"
        )
        if reused_existing_target:
            target_status = "cached_live"
            target_has_top10 = True
            if target_diag and target_diag.get("sourceStatus") == "error":
                target_error_count = max(target_error_count - 1, 0)
            if target_diag and target_diag.get("sourceStatus") == "stale":
                target_stale_count = max(target_stale_count - 1, 0)
            if target_diag and target_diag.get("sourceStatus") == "rate_limited":
                target_rate_limited_count = max(target_rate_limited_count - 1, 0)
            if target_diag and target_diag.get("dateMismatch"):
                target_mismatch_count = max(target_mismatch_count - 1, 0)
            if target_diag and target_diag.get("skippedFetch"):
                target_warning = target_warning or "Existing live target-date snapshot reused."
            else:
                target_warning = f"Target fetch {target_diag.get('sourceStatus') if target_diag else 'not_attempted'}: {target_warning}; reused existing live target-date snapshot."
        is_target_waiting = (
            source_status in {"missing", "empty", "error", "stale"}
            or latest_date != target_date
            or target_status in {"missing", "empty", "error", "stale", "not_attempted"}
            or not target_has_top10
        )
        if is_target_waiting:
            waiting_for_target = True
        if analysis.get("returnCoverageStatus") == "low" or target_error_count or target_stale_count or target_mismatch_count or target_rate_limited_count:
            degraded = True
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
            "fetchStats": {
                "requestedDates": len(diagnostics.get(config.id, [])),
                "skippedExisting": skipped_fetch_count,
                "fetchedLive": fetched_count,
                "targetErrors": target_error_count,
                "targetRateLimited": target_rate_limited_count,
                "targetStale": target_stale_count,
                "targetDateMismatches": target_mismatch_count,
                "historicalErrors": historical_error_count,
                "historicalRateLimited": historical_rate_limited_count,
                "historicalStale": historical_stale_count,
                "historicalDateMismatches": historical_mismatch_count,
            },
        })
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "targetDate": target_date,
        "overallStatus": "waiting_for_prior_close" if waiting_for_target else ("degraded" if degraded else "ok"),
        "message": "Scheduled refresh runs Tue-Sat in KST; if prior closes or provider rows are missing, use a reviewed workflow_dispatch run to refresh this file.",
        "priceErrorCount": len(latest_price_errors),
        "priceErrors": latest_price_errors,
        "etfs": etf_status,
    }

def write_json(path: Path, payload: Any, *, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=False)
    else:
        body = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False)
    path.write_text(body + "\n", encoding="utf-8")


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
        stats = item.get("fetchStats") if isinstance(item.get("fetchStats"), dict) else {}
        if stats.get("targetErrors"):
            warnings.append(f"{name}: target fetch errors {stats.get('targetErrors')}")
        if stats.get("targetRateLimited"):
            warnings.append(f"{name}: target rate limited {stats.get('targetRateLimited')}")
        if stats.get("targetStale"):
            warnings.append(f"{name}: target stale provider responses {stats.get('targetStale')}")
        if stats.get("targetDateMismatches"):
            warnings.append(f"{name}: target date mismatches {stats.get('targetDateMismatches')}")
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
            "workflowDispatch": "Expected provider/price delays are recorded as data status instead of silently publishing partial data.",
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


def collect_snapshots(
    args: argparse.Namespace,
    existing: dict[str, list[dict[str, Any]]] | None = None,
) -> tuple[dict[str, list[dict[str, Any]]], dict[str, list[dict[str, Any]]]]:
    snapshots: dict[str, list[dict[str, Any]]] = {config.id: [] for config in ETFS}
    diagnostics: dict[str, list[dict[str, Any]]] = {config.id: [] for config in ETFS}
    existing = existing or {config.id: [] for config in ETFS}
    for config in ETFS:
        existing_by_date = {
            str(snapshot.get("date") or snapshot.get("asOfDate")): snapshot
            for snapshot in existing.get(config.id, [])
            if snapshot.get("date") or snapshot.get("asOfDate")
        }
        fetch_dates = dates_to_fetch(
            config,
            args.target_date,
            backfill_all=args.backfill_all,
            backfill_days=args.backfill_days,
            backfill_start_date=args.backfill_start_date,
        )
        for target in prioritized_fetch_dates(fetch_dates, args.target_date):
            cached_snapshot = existing_by_date.get(target)
            if not args.refresh_existing and snapshot_has_usable_data(cached_snapshot, target):
                diagnostics[config.id].append(cached_snapshot_diagnostic(cached_snapshot, target, args.target_date))
                continue
            try:
                raw = load_fixture_snapshot(config, args.fixture_dir, target) if args.fixture_dir else fetch_snapshot(config, target)
            except Exception as exc:
                rate_limited = is_rate_limited_error(exc)
                diagnostic = {
                    "date": target,
                    "queryDate": target,
                    "sourceStatus": "rate_limited" if rate_limited else "error",
                    "sourceConfidence": "low",
                    "sourceWarning": str(exc),
                    "hasTop10": False,
                    "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                }
                diagnostics[config.id].append(diagnostic)
                if args.include_empty:
                    snapshots[config.id].append({**diagnostic, "top10": [], "totalHoldings": 0})
                if rate_limited and not args.fixture_dir:
                    break
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
            if raw.get("asOfDate") != target or raw.get("queryDate") != target:
                diagnostic["dateMismatch"] = {
                    "targetDate": target,
                    "asOfDate": raw.get("asOfDate"),
                    "queryDate": raw.get("queryDate"),
                }
            diagnostics[config.id].append(diagnostic)
            if snapshot_is_live_for_target(raw, target):
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
    parser.add_argument("--refresh-existing", action="store_true", help="Refetch dates even when a usable snapshot already exists.")
    parser.add_argument("--include-empty", action="store_true", help="Persist empty/error snapshots for diagnostics.")
    parser.add_argument("--no-live-prices", action="store_true", help="Skip live Yahoo price calls.")
    parser.add_argument("--provider-delay", type=float, default=0.12, help="Delay between provider requests outside fixture mode.")
    parser.add_argument("--soft-fail", action="store_true", help="Record automation failure status and return success for soft-gated workflow runs.")
    return parser.parse_args()


def run_update(args: argparse.Namespace) -> dict[str, Any]:
    args.target_date = iso_date(args.target_date)
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    existing = load_history(output_dir)
    new_snapshots, diagnostics = collect_snapshots(args, existing)
    merged = merge_history(existing, new_snapshots)
    price_provider = PriceProvider(args.fixture_dir, no_live=args.no_live_prices)
    enriched, summaries = enrich_history(merged, price_provider)
    public_enriched = public_history(enriched)
    replay_history = stored_history(enriched)
    dashboard = build_dashboard(public_enriched, summaries, generated_at)
    latest = build_latest(public_enriched, generated_at)
    status = build_status(enriched, generated_at, price_provider, args.target_date, diagnostics)

    automation_status = build_automation_status(status, generated_at, args.target_date)

    write_history_outputs(output_dir, replay_history, generated_at)
    write_json(output_dir / "latest.json", latest)
    write_json(output_dir / "dashboard.json", dashboard, compact=True)
    summary = build_public_summary(dashboard)
    summary["payload"]["detailBytes"] = len(json.dumps(dashboard, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    write_json(output_dir / "summary.json", summary, compact=True)
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
