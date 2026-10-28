#!/usr/bin/env python3
"""Serialize the three active public data pipelines when delayed cron runs overlap.

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
    "SonChangGi/factor": "daily-dashboard.yml",
    "SonChangGi/etf-tracking": "update-data.yml",
}
ACTIVE = ("in_progress", "queued", "waiting", "pending", "requested")
CURRENT_START_TIMEOUT = 30
CURRENT_START_POLL = 5


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
        if (not isinstance(result, dict) or not isinstance(result.get("jobs"), list)
                or type(result.get("total_count")) is not int or result["total_count"] < 0):
            raise RuntimeError("Malformed current-attempt jobs response")
        for job in result["jobs"]:
            if (not isinstance(job, dict) or type(job.get("run_id")) is not int
                    or job["run_id"] != run["id"] or type(job.get("run_attempt")) is not int
                    or job["run_attempt"] != run.get("run_attempt", 1)):
                raise RuntimeError("Job evidence does not match the requested run and attempt")
            if job.get("conclusion") == "skipped" or job.get("status") not in ("in_progress", "completed"):
                continue
            start = job.get("started_at")
            if start is not None:
                try:
                    parsed = dt.datetime.fromisoformat(start.replace("Z", "+00:00"))
                    if parsed.tzinfo is None:
                        raise ValueError("Missing timezone")
                except (AttributeError, TypeError, ValueError) as exc:
                    raise RuntimeError("Malformed job start timestamp") from exc
                starts.append(start)
        if page * 100 >= result["total_count"]:
            break
        page += 1
        if page > 10:
            raise RuntimeError("Cannot inspect all jobs in the current attempt")
    return {**run, "admission_started_at": min(starts, key=lambda start: dt.datetime.fromisoformat(
        start.replace("Z", "+00:00"))) if starts else None}


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


def current_attempt(repository: str, run_id: str, run_attempt: int) -> dict:
    """Bind self-state evidence to this execution; pending states can only wait."""
    current = api(f"repos/{repository}/actions/runs/{run_id}")
    if not isinstance(current, dict):
        raise RuntimeError("Malformed current workflow run response")
    print("Admission observation: " + json.dumps({
        "expected_run": int(run_id), "expected_attempt": run_attempt,
        "observed_run": current.get("id"), "observed_attempt": current.get("run_attempt"),
        "status": current.get("status"),
    }), flush=True)
    if (type(current.get("id")) is not int or current["id"] != int(run_id)
            or type(current.get("run_attempt")) is not int or current["run_attempt"] != run_attempt
            or not isinstance(current.get("repository"), dict)
            or not isinstance(current["repository"].get("full_name"), str)
            or current["repository"]["full_name"].lower() != repository.lower()):
        raise RuntimeError("Current workflow run identity or attempt does not match this execution")
    if current.get("status") not in ACTIVE:
        raise RuntimeError("Current workflow run is terminal or has an unknown status")
    if current["status"] == "in_progress":
        current = started_attempt(repository, current)
    else:
        current = {**current, "admission_started_at": None}
    print("Admission job-start evidence: " + json.dumps({
        "run": current["id"], "attempt": run_attempt,
        "started_at": current.get("admission_started_at"),
    }), flush=True)
    return current


def wait_for_turn(repository: str, run_id: str, max_wait: int, poll: int, run_attempt: int = 1) -> int:
    if repository.lower() not in {repo.lower() for repo in WORKFLOWS}:
        raise ValueError("Repository is not part of the coordinated production schedule")
    if int(run_id) <= 0 or type(run_attempt) is not int or run_attempt <= 0:
        raise ValueError("A positive workflow run and attempt are required")
    deadline = time.monotonic() + max_wait
    # Confirm observable startup within a small budget before inspecting peers.
    # API failures and terminal/unknown states remain immediate failures.
    start_deadline = min(deadline, time.monotonic() + CURRENT_START_TIMEOUT)
    while True:
        current = current_attempt(repository, run_id, run_attempt)
        if time.monotonic() > start_deadline:
            raise RuntimeError("Current workflow start could not be confirmed within the bounded wait")
        if current["status"] == "in_progress" and current.get("admission_started_at"):
            break
        remaining = start_deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("Current workflow start could not be confirmed within the bounded wait")
        time.sleep(min(CURRENT_START_POLL, remaining))
    clear_checks = 0
    while True:
        peers = active_peers(repository)
        waiting = blockers(current, peers)
        if not waiting:
            clear_checks += 1
            if clear_checks >= 2:
                confirmed = current_attempt(repository, run_id, run_attempt)
                if (confirmed["status"] != "in_progress" or not confirmed.get("admission_started_at")
                        or order(confirmed) != order(current)):
                    raise RuntimeError("Current workflow start evidence changed before admission")
                if time.monotonic() > deadline:
                    raise RuntimeError("Admission deadline expired before release")
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
    # GITHUB_TOKEN has a 1,000 requests/hour/repository primary limit.
    # Two peers x five states plus their running job evidence stay below
    # that budget at 90-second intervals, including bounded failed-job retries.
    parser.add_argument("--poll-seconds", type=int, default=90)
    args = parser.parse_args()
    if not 0 <= args.max_wait_seconds <= 7200 or not 60 <= args.poll_seconds <= 120:
        parser.error("wait must be 0..7200 seconds; poll must be 60..120 seconds")
    try:
        return wait_for_turn(os.environ["GITHUB_REPOSITORY"], os.environ["GITHUB_RUN_ID"],
                             args.max_wait_seconds, args.poll_seconds, int(os.environ["GITHUB_RUN_ATTEMPT"]))
    except (KeyError, OSError, ValueError, RuntimeError) as exc:
        print(f"Admission could not be verified; collection blocked: {type(exc).__name__}: {exc}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
