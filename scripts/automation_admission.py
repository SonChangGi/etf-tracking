#!/usr/bin/env python3
"""Serialize the four public data pipelines when delayed cron runs overlap.

Read-only GitHub API coordination. Repository concurrency serializes runs of
one project; a total order (first job start in this attempt, run id) orders
different projects. Unstarted concurrency-pending runs do not hold admission.
No token is printed, no workflow is dispatched, and API failures fail closed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
import urllib.parse
import urllib.request

WORKFLOWS = {
    "SonChangGi/sox": "deploy-pages.yml",
    "SonChangGi/momentum-factor-lab": "daily-dashboard.yml",
    "SonChangGi/best-factor": "update-dashboard.yml",
    "SonChangGi/etf-tracking": "update-data.yml",
}
ACTIVE = ("in_progress", "queued", "waiting", "pending", "requested")


def order(run: dict) -> tuple[dt.datetime, int]:
    return dt.datetime.fromisoformat(run["admission_started_at"].replace("Z", "+00:00")), int(run["id"])


def blockers(current: dict, peers: list[dict]) -> list[dict]:
    return sorted((run for run in peers if run["status"] in ACTIVE and run.get("admission_started_at")
                   and order(run) < order(current)), key=order)


def api(path: str) -> dict:
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "quant-automation-admission",
               "X-GitHub-Api-Version": "2022-11-28", "Cache-Control": "no-cache"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request("https://api.github.com/" + path, headers=headers)
    with urllib.request.urlopen(request, timeout=25) as response:
        return json.load(response)


def started_attempt(repository: str, run: dict) -> dict:
    """Actual job start is stable even when GitHub reorders pending runs.

    created_at/run_started_at can predate a long runner/concurrency queue.
    Ordering by that queued time can deadlock two repository concurrency
    groups, or let a late-starting old run overtake work already admitted.
    Only the current attempt's jobs count, including failed-job-only reruns.
    """
    starts = []
    page = 1
    while True:
        result = api(f"repos/{repository}/actions/runs/{run['id']}/attempts/{run.get('run_attempt', 1)}/jobs?per_page=100&page={page}")
        starts.extend(job["started_at"] for job in result["jobs"] if job.get("started_at"))
        if page * 100 >= result["total_count"]:
            break
        page += 1
        if page > 10:
            raise RuntimeError("Cannot inspect all jobs in the current attempt")
    return {**run, "admission_started_at": min(starts) if starts else None}


def active_peers(repository: str) -> list[dict]:
    found = {}
    for peer, workflow in WORKFLOWS.items():
        if peer.lower() == repository.lower():
            continue
        for status in ACTIVE:
            page = 1
            while True:
                query = urllib.parse.urlencode({"status": status, "per_page": 100, "page": page})
                result = api(f"repos/{peer}/actions/workflows/{workflow}/runs?{query}")
                for run in result["workflow_runs"]:
                    found[run["id"]] = (peer, run)
                if page * 100 >= result["total_count"]:
                    break
                page += 1
                if page > 10:
                    raise RuntimeError("Cannot safely inspect the entire active workflow queue")
    return [started_attempt(peer, run) for peer, run in found.values()]


def wait_for_turn(repository: str, run_id: str, max_wait: int, poll: int) -> int:
    if repository.lower() not in {repo.lower() for repo in WORKFLOWS}:
        raise ValueError("Repository is not part of the coordinated production schedule")
    deadline = time.monotonic() + max_wait
    current = started_attempt(repository, api(f"repos/{repository}/actions/runs/{run_id}"))
    if current["status"] != "in_progress":
        raise RuntimeError("Admission requires an active workflow run")
    if not current.get("admission_started_at"):
        raise RuntimeError("The current attempt has no observable job start")
    clear_checks = 0
    while True:
        peers = active_peers(repository)
        waiting = blockers(current, peers)
        if not waiting:
            clear_checks += 1
            if clear_checks >= 2:
                print("Admission granted: no earlier peer data pipeline is active.", flush=True)
                return 0
        else:
            clear_checks = 0
            print("Waiting for earlier pipeline(s): " + ", ".join(run["html_url"] for run in waiting), flush=True)
        if time.monotonic() >= deadline:
            print("Admission wait expired; no collection started. A later retry slot can recover.", flush=True)
            return 1
        time.sleep(min(5 if clear_checks else poll, max(0, deadline - time.monotonic())))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-wait-seconds", type=int, default=2700)
    parser.add_argument("--poll-seconds", type=int, default=45)
    args = parser.parse_args()
    if not 0 <= args.max_wait_seconds <= 7200 or not 10 <= args.poll_seconds <= 60:
        parser.error("wait must be 0..7200 seconds; poll must be 10..60 seconds")
    try:
        return wait_for_turn(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_RUN_ID"],
                             args.max_wait_seconds, args.poll_seconds)
    except (KeyError, OSError, ValueError, RuntimeError) as exc:
        print(f"Admission could not be verified; collection blocked: {type(exc).__name__}: {exc}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
