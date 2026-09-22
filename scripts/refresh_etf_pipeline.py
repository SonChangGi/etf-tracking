#!/usr/bin/env python3
"""Retry one frozen disclosure day; validate a private candidate before promotion."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

from etf_automation import ROOT, disclosure_date, validate_current


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-date")
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--retry-delay", type=float, default=30)
    parser.add_argument("--diagnostics-dir", type=Path, required=True)
    args, updater_args = parser.parse_known_args()
    if not 1 <= args.attempts <= 5 or args.retry_delay < 0:
        parser.error("attempts must be 1..5 and retry delay nonnegative")
    target = args.target_date or disclosure_date()
    args.diagnostics_dir.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, args.attempts + 1):
        print(f"ETF attempt {attempt}/{args.attempts}; frozen disclosure day {target}", flush=True)
        with tempfile.TemporaryDirectory(prefix="etf-candidate-", dir=ROOT.parent) as temporary:
            workspace = Path(temporary) / "workspace"
            shutil.copytree(ROOT, workspace, ignore=shutil.ignore_patterns(".git", "dist", "node_modules", ".venv", "__pycache__"))
            # The committed platform compatibility runtime is required by the test contract.
            shutil.copytree(ROOT / "shared-platform/dist", workspace / "shared-platform/dist")
            completed = subprocess.run([sys.executable, "scripts/update_data.py", "--output-dir", "data", "--target-date", target, "--soft-fail", *updater_args], cwd=workspace)
            data = workspace / "data"
            for name in ("automation-status.json", "status.json"):
                if (data / name).exists():
                    shutil.copy2(data / name, args.diagnostics_dir / name)
            try:
                if completed.returncode:
                    raise ValueError(f"Updater exited {completed.returncode}")
                validate_current(data, target)
                subprocess.run(["npm", "test"], cwd=workspace, check=True)
            except (ValueError, subprocess.CalledProcessError) as exc:
                print(f"Candidate rejected; last-good data preserved: {exc}", flush=True)
            else:
                previous = Path(temporary) / "previous-data"
                (ROOT / "data").rename(previous)
                try:
                    data.rename(ROOT / "data")
                except BaseException:
                    previous.rename(ROOT / "data")
                    raise
                print(f"Promoted verified ETF disclosure day {target}", flush=True)
                return 0
        if attempt < args.attempts:
            time.sleep(args.retry_delay)
    # A provider wait is distinguished from broken code by the workflow assessment.
    diagnostic = json.loads((args.diagnostics_dir / "automation-status.json").read_text())
    return 0 if diagnostic.get("runStatus") == "waiting_for_data" else 1


if __name__ == "__main__":
    sys.exit(main())
