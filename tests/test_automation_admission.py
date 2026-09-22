import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import unittest
from unittest.mock import patch

import automation_admission as gate


def run(identifier, created="2026-09-22T00:00:00Z", status="in_progress", **extra):
    return {"id": identifier, "created_at": created, "admission_started_at": created, "status": status,
            "html_url": f"https://github.com/runs/{identifier}", **extra}


class AdmissionTests(unittest.TestCase):
    def test_total_order_avoids_mutual_wait_and_completed_runs_do_not_block(self):
        older, newer = run(1), run(2)
        self.assertEqual(gate.blockers(older, [newer]), [])
        self.assertEqual(gate.blockers(newer, [older]), [older])
        self.assertEqual(gate.blockers(newer, [run(1, status="completed")]), [])

    def test_waits_until_earlier_pipeline_finishes_then_confirms_clear(self):
        with patch.object(gate, "api", return_value=run(2)), patch.object(gate, "started_attempt", side_effect=lambda repo, item: item), patch.object(
            gate, "active_peers", side_effect=[[run(1)], [], []]
        ), patch.object(gate.time, "sleep") as sleep:
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 100, 45), 0)
            self.assertEqual(sleep.call_count, 2)

    def test_timeout_does_not_grant_admission(self):
        with patch.object(gate, "api", return_value=run(2)), patch.object(gate, "started_attempt", side_effect=lambda repo, item: item), patch.object(
            gate, "active_peers", return_value=[run(1)]
        ):
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 0, 45), 1)

    def test_api_failure_propagates_without_admission(self):
        with patch.object(gate, "api", side_effect=OSError("unavailable")):
            with self.assertRaises(OSError):
                gate.wait_for_turn("SonChangGi/sox", "2", 100, 45)

    def test_rerun_is_ordered_by_current_attempt_start(self):
        with patch.object(gate, "api", return_value=run(1, run_attempt=2,
            admission_started_at="2026-09-22T02:00:00Z")), patch.object(gate, "started_attempt", side_effect=lambda repo, item: item), patch.object(
            gate, "active_peers", return_value=[run(2, "2026-09-22T01:00:00Z")]
        ):
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "1", 0, 45), 1)

    def test_unstarted_old_pending_run_cannot_deadlock_running_groups(self):
        pending = run(1, status="pending", admission_started_at=None)
        running = run(3, admission_started_at="2026-09-22T01:00:00Z")
        peer = run(2, admission_started_at="2026-09-22T02:00:00Z")
        self.assertEqual(gate.blockers(running, [peer]), [])
        self.assertEqual(gate.blockers(peer, [pending, running]), [running])

    def test_late_starting_old_run_waits_for_work_already_admitted(self):
        late = run(1, admission_started_at="2026-09-22T02:00:00Z")
        active = run(3, admission_started_at="2026-09-22T01:00:00Z")
        self.assertEqual(gate.blockers(late, [active]), [active])

    def test_start_evidence_uses_only_current_attempt_jobs(self):
        with patch.object(gate, "api", return_value={"total_count": 2, "jobs": [
            {"started_at": "2026-09-22T03:00:00Z"}, {"started_at": None}
        ]}) as api:
            current = gate.started_attempt("SonChangGi/sox", run(1, run_attempt=2))
        self.assertEqual(current["admission_started_at"], "2026-09-22T03:00:00Z")
        self.assertIn("/attempts/2/jobs?", api.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
