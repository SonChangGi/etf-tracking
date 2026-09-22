#!/usr/bin/env python3
"""Frozen Korean disclosure-day identity and fail-closed publication checks."""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import sys
import urllib.request
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
BASE_URL = "https://sonchanggi.github.io/etf-tracking/"
KST = ZoneInfo("Asia/Seoul")


def disclosure_date(now: dt.datetime | None = None) -> str:
    import exchange_calendars as xcals
    day = (now or dt.datetime.now(dt.timezone.utc)).astimezone(KST).date()
    calendar = xcals.get_calendar("XKRX", start=f"{day.year - 1}-01-01", end=f"{day.year + 1}-12-31")
    # D is the Korean holdings disclosure day, not a U.S. price/close date.
    return calendar.date_to_session(day.isoformat(), direction="previous").date().isoformat()


def validate_current(data: Path, target: str) -> None:
    status = json.loads((data / "status.json").read_text())
    automation = json.loads((data / "automation-status.json").read_text())
    summary = json.loads((data / "summary.json").read_text())
    if status.get("targetDate") != target or automation.get("targetDate") != target:
        raise ValueError(f"Publication identity does not match disclosure day {target}")
    if status.get("overallStatus") != "ok" or automation.get("runStatus") != "ok":
        raise ValueError("Collection is not current and healthy")
    if status.get("priceErrorCount") != 0 or automation.get("warningCount") != 0:
        raise ValueError("Collection still has quality errors or warnings")
    etfs = status.get("etfs", [])
    if len(etfs) != 3 or any(e.get("latestDate") != target or e.get("sourceStatus") != "live" for e in etfs):
        raise ValueError("Every ETF must have a live target-day snapshot")
    if summary.get("dataAsOf") != target:
        raise ValueError("Summary does not identify the target disclosure day")


def public_matches(root: Path = ROOT) -> bool:
    paths = [root / "index.html", root / "shared-platform/dist/index.js"]
    paths += sorted((root / "assets").rglob("*"))
    paths += sorted((root / "data").rglob("*.json"))
    for path in paths:
        if not path.is_file():
            continue
        request = urllib.request.Request(BASE_URL + path.relative_to(root).as_posix(), headers={"Cache-Control": "no-cache"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.read() != path.read_bytes():
                    return False
        except Exception:
            return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-date")
    parser.add_argument("--require-current", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    target = args.target_date or disclosure_date()
    if args.require_current:
        if target != disclosure_date():
            raise ValueError("Korean disclosure day changed during this run; restart with a new frozen identity")
        validate_current(ROOT / "data", target)
        print(f"Verified all three ETF disclosures for {target}")
        return 0
    try:
        validate_current(ROOT / "data", target)
        current = True
    except (ValueError, KeyError, OSError):
        current = False
    collect = args.force or not current
    deploy = collect or not public_matches()
    text = f"target_date={target}\nshould_collect={str(collect).lower()}\nshould_deploy={str(deploy).lower()}\n"
    print(text, end="")
    if args.output:
        with args.output.open("a") as stream:
            stream.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
