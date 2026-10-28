import io
import sys
from contextlib import redirect_stdout
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import unittest
from unittest.mock import call, patch

import automation_admission as gate


def run(identifier, created="2026-09-22T00:00:00Z", status="in_progress",
        repository="SonChangGi/sox", run_attempt=1, **extra):
    return {"id": identifier, "created_at": created, "admission_started_at": created, "status": status,
            "repository": {"full_name": repository}, "run_attempt": run_attempt,
            "html_url": f"https://github.com/runs/{identifier}", **extra}


def job(started="2026-09-22T03:00:00Z", status="in_progress", conclusion=None,
        run_id=1, run_attempt=2, **extra):
    return {"id": 10, "run_id": run_id, "run_attempt": run_attempt, "status": status,
            "conclusion": conclusion, "started_at": started, **extra}


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.output = io.StringIO()
        self.enterContext(redirect_stdout(self.output))
        self.enterContext(patch.object(gate.time, "monotonic", side_effect=lambda: self.now))
        self.sleep = self.enterContext(patch.object(gate.time, "sleep", side_effect=self.advance))

    def advance(self, seconds):
        self.now += seconds

    def test_total_order_avoids_mutual_wait_and_completed_runs_do_not_block(self):
        older, newer = run(1), run(2)
        self.assertEqual(gate.blockers(older, [newer]), [])
        self.assertEqual(gate.blockers(newer, [older]), [older])
        self.assertEqual(gate.blockers(newer, [run(1, status="completed")]), [])

    def test_waits_until_earlier_pipeline_finishes_then_confirms_clear(self):
        with patch.object(gate, "api", return_value=run(2)), patch.object(gate, "started_attempt", side_effect=lambda repo, item: item), patch.object(
            gate, "active_peers", side_effect=[[run(1)], [], []]
        ):
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 100, 45), 0)
            self.assertEqual(self.sleep.call_args_list, [call(45), call(5)])

    def test_timeout_does_not_grant_admission(self):
        with patch.object(gate, "api", return_value=run(2)), patch.object(gate, "started_attempt", side_effect=lambda repo, item: item), patch.object(
            gate, "active_peers", return_value=[run(1)]
        ):
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 0, 45), 1)

    def test_api_failure_propagates_without_admission(self):
        with patch.object(gate, "api", side_effect=OSError("unavailable")), patch.object(gate, "active_peers") as peers:
            with self.assertRaises(OSError):
                gate.wait_for_turn("SonChangGi/sox", "2", 100, 45)
            peers.assert_not_called()

    def test_rerun_is_ordered_by_current_attempt_start(self):
        with patch.object(gate, "api", return_value=run(1, run_attempt=2,
            admission_started_at="2026-09-22T02:00:00Z")), patch.object(gate, "started_attempt", side_effect=lambda repo, item: item), patch.object(
            gate, "active_peers", return_value=[run(2, "2026-09-22T01:00:00Z")]
        ):
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "1", 0, 45, run_attempt=2), 1)

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
        with patch.object(gate, "api", return_value={"total_count": 3, "jobs": [
            job(), job(started=None, status="queued"),
            job(started="2026-09-22T00:00:00Z", status="completed", conclusion="skipped"),
        ]}) as api:
            current = gate.started_attempt("SonChangGi/sox", run(1, run_attempt=2))
        self.assertEqual(current["admission_started_at"], "2026-09-22T03:00:00Z")
        self.assertIn("/attempts/2/jobs?", api.call_args.args[0])

    def test_queued_current_run_must_become_in_progress_before_peer_checks(self):
        with patch.object(gate, "api", side_effect=[run(2, status="queued"), run(2), run(2)]) as api, patch.object(
            gate, "started_attempt", side_effect=lambda repo, item: item
        ), patch.object(gate, "active_peers", return_value=[]) as peers:
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 100, 90), 0)
        self.assertEqual(api.call_args_list, [call("repos/SonChangGi/sox/actions/runs/2")] * 3)
        self.assertEqual(self.sleep.call_args_list, [call(5), call(5)])
        self.assertEqual(peers.call_count, 2)
        self.assertIn('"status": "queued"', self.output.getvalue())
        self.assertIn('"status": "in_progress"', self.output.getvalue())

    def test_job_start_evidence_can_appear_during_the_bounded_start_wait(self):
        with patch.object(gate, "api", return_value=run(2)), patch.object(gate, "started_attempt", side_effect=[
            run(2, admission_started_at=None), run(2), run(2),
        ]), patch.object(gate, "active_peers", return_value=[]) as peers:
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 100, 90), 0)
        self.assertEqual(self.sleep.call_args_list, [call(5), call(5)])
        self.assertEqual(peers.call_count, 2)

    def test_startup_wait_is_bounded_and_never_inspects_peers_while_unconfirmed(self):
        for status in ("queued", "waiting", "pending", "requested", "in_progress"):
            with self.subTest(status=status):
                self.now = 0
                with patch.object(gate, "api", return_value=run(2, status=status)), patch.object(
                    gate, "started_attempt", return_value=run(2, admission_started_at=None)
                ), patch.object(gate, "active_peers") as peers:
                    with self.assertRaisesRegex(RuntimeError, "bounded wait"):
                        gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
                    peers.assert_not_called()
                self.assertEqual(self.now, 30)
        self.assertNotIn("Admission granted", self.output.getvalue())

    def test_startup_rechecks_do_not_extend_the_overall_wait_budget(self):
        with patch.object(gate, "api", return_value=run(2, status="queued")), patch.object(gate, "active_peers") as peers:
            with self.assertRaisesRegex(RuntimeError, "bounded wait"):
                gate.wait_for_turn("SonChangGi/sox", "2", 8, 90)
            peers.assert_not_called()
        self.assertEqual(self.sleep.call_args_list, [call(5), call(3)])

    def test_valid_start_received_after_the_startup_deadline_is_rejected(self):
        def delayed_response(path):
            self.now = 31
            return run(2)

        with patch.object(gate, "api", side_effect=delayed_response), patch.object(
            gate, "started_attempt", side_effect=lambda repo, item: item
        ), patch.object(gate, "active_peers") as peers:
            with self.assertRaisesRegex(RuntimeError, "bounded wait"):
                gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
            peers.assert_not_called()
        self.assertNotIn("Admission granted", self.output.getvalue())

    def test_terminal_and_unknown_current_statuses_fail_without_recheck_or_peers(self):
        for status in ("completed", "cancelled", "failure", "unknown", None, 1):
            with self.subTest(status=status), patch.object(gate, "api", return_value=run(2, status=status)) as api, patch.object(
                gate, "started_attempt"
            ) as starts, patch.object(gate, "active_peers") as peers:
                with self.assertRaises(RuntimeError):
                    gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
                api.assert_called_once()
                starts.assert_not_called()
                peers.assert_not_called()
        self.sleep.assert_not_called()

    def test_malformed_or_mismatched_current_identity_fails_without_recheck(self):
        invalid = [
            None, [], {}, run(3), run("2"), run(True),
            run(2, repository="SonChangGi/etf-tracking"),
            {**run(2), "repository": None}, {**run(2), "repository": {}},
            run(2, run_attempt=2), run(2, run_attempt="1"), run(2, run_attempt=True),
        ]
        for payload in invalid:
            with self.subTest(payload=payload), patch.object(gate, "api", return_value=payload) as api, patch.object(gate, "active_peers") as peers:
                with self.assertRaises(RuntimeError):
                    gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
                api.assert_called_once()
                peers.assert_not_called()
        self.sleep.assert_not_called()

    def test_api_error_during_start_recheck_does_not_inspect_peers_or_grant(self):
        with patch.object(gate, "api", side_effect=[run(2, status="queued"), OSError("unavailable")]), patch.object(gate, "active_peers") as peers:
            with self.assertRaises(OSError):
                gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
            peers.assert_not_called()
        self.assertEqual(self.sleep.call_args_list, [call(5)])
        self.assertNotIn("Admission granted", self.output.getvalue())

    def test_transient_recovery_still_waits_for_peers_and_two_consecutive_clear_checks(self):
        with patch.object(gate, "api", side_effect=[run(2, status="queued"), run(2), run(2)]), patch.object(
            gate, "started_attempt", side_effect=lambda repo, item: item
        ), patch.object(gate, "active_peers", side_effect=[[run(1)], [], [run(1)], [], []]) as peers:
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 300, 60), 0)
        self.assertEqual(peers.call_count, 5)
        self.assertEqual(self.sleep.call_args_list, [call(5), call(60), call(5), call(60), call(5)])

    def test_current_terminal_status_at_grant_time_blocks_admission(self):
        with patch.object(gate, "api", side_effect=[run(2), run(2, status="completed")]), patch.object(
            gate, "started_attempt", side_effect=lambda repo, item: item
        ), patch.object(gate, "active_peers", return_value=[]) as peers:
            with self.assertRaises(RuntimeError):
                gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
        self.assertEqual(peers.call_count, 2)
        self.assertNotIn("Admission granted", self.output.getvalue())

    def test_final_current_recheck_cannot_release_after_the_admission_deadline(self):
        def response(path):
            if self.now:
                self.now = 101
            return run(2)

        with patch.object(gate, "api", side_effect=response), patch.object(
            gate, "started_attempt", side_effect=lambda repo, item: item
        ), patch.object(gate, "active_peers", return_value=[]) as peers:
            with self.assertRaisesRegex(RuntimeError, "deadline expired"):
                gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
        self.assertEqual(peers.call_count, 2)
        self.assertNotIn("Admission granted", self.output.getvalue())

    def test_changed_or_missing_start_evidence_at_grant_time_blocks_admission(self):
        for start in (None, "2026-09-22T01:00:00Z"):
            with self.subTest(start=start), patch.object(gate, "api", return_value=run(2)), patch.object(
                gate, "started_attempt", side_effect=[run(2), run(2, admission_started_at=start)]
            ), patch.object(gate, "active_peers", return_value=[]):
                with self.assertRaisesRegex(RuntimeError, "evidence changed"):
                    gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
        self.assertNotIn("Admission granted", self.output.getvalue())

    def test_attempt_change_at_grant_time_blocks_admission(self):
        with patch.object(gate, "api", side_effect=[run(2), run(2, run_attempt=2)]), patch.object(
            gate, "started_attempt", side_effect=lambda repo, item: item
        ), patch.object(gate, "active_peers", return_value=[]):
            with self.assertRaises(RuntimeError):
                gate.wait_for_turn("SonChangGi/sox", "2", 100, 90)
        self.assertNotIn("Admission granted", self.output.getvalue())

    def test_job_identity_must_match_the_requested_run_and_attempt(self):
        for evidence in (job(run_id=2), job(run_id="1"), job(run_attempt=1), job(run_attempt="2"), job(run_attempt=True)):
            with self.subTest(evidence=evidence), patch.object(gate, "api", return_value={"total_count": 1, "jobs": [evidence]}):
                with self.assertRaisesRegex(RuntimeError, "run and attempt"):
                    gate.started_attempt("SonChangGi/sox", run(1, run_attempt=2))

    def test_skipped_or_unstarted_jobs_do_not_supply_admission_start_evidence(self):
        for evidence in (job(status="completed", conclusion="skipped"), job(status="queued"), job(status="waiting", started=None)):
            with self.subTest(evidence=evidence), patch.object(gate, "api", return_value={"total_count": 1, "jobs": [evidence]}):
                current = gate.started_attempt("SonChangGi/sox", run(1, run_attempt=2))
                self.assertIsNone(current["admission_started_at"])

    def test_skipped_only_job_response_times_out_without_inspecting_peers(self):
        def response(path):
            if "/jobs?" in path:
                return {"total_count": 1, "jobs": [job(run_id=2, run_attempt=1, status="completed", conclusion="skipped")]}
            return run(2)

        with patch.object(gate, "api", side_effect=response), patch.object(gate, "active_peers") as peers:
            with self.assertRaisesRegex(RuntimeError, "bounded wait"):
                gate.wait_for_turn("SonChangGi/sox", "2", 10, 90)
            peers.assert_not_called()

    def test_malformed_job_start_timestamp_is_not_accepted(self):
        for timestamp in ("not-a-date", "2026-09-22", "2026-09-22T03:00:00", 123):
            with self.subTest(timestamp=timestamp), patch.object(gate, "api", return_value={"total_count": 1, "jobs": [job(started=timestamp)]}):
                with self.assertRaisesRegex(RuntimeError, "timestamp"):
                    gate.started_attempt("SonChangGi/sox", run(1, run_attempt=2))

    def test_earliest_job_start_is_ordered_by_instant_across_timezone_offsets(self):
        with patch.object(gate, "api", return_value={"total_count": 2, "jobs": [
            job(started="2026-09-22T03:00:00Z"), job(started="2026-09-22T04:00:00+02:00"),
        ]}):
            current = gate.started_attempt("SonChangGi/sox", run(1, run_attempt=2))
        self.assertEqual(gate.order(current)[0].isoformat(), "2026-09-22T04:00:00+02:00")

    def test_malformed_job_response_is_rejected(self):
        for payload in (None, [], {}, {"jobs": [], "total_count": "0"}, {"jobs": None, "total_count": 0}, {"jobs": [], "total_count": -1}):
            with self.subTest(payload=payload), patch.object(gate, "api", return_value=payload):
                with self.assertRaises(RuntimeError):
                    gate.started_attempt("SonChangGi/sox", run(1, run_attempt=2))

    def test_main_requires_and_forwards_the_workflow_attempt(self):
        env = {"GITHUB_REPOSITORY": "SonChangGi/sox", "GITHUB_RUN_ID": "2", "GITHUB_RUN_ATTEMPT": "2"}
        with patch.dict(gate.os.environ, env, clear=True), patch.object(sys, "argv", ["automation_admission.py"]), patch.object(gate, "wait_for_turn", return_value=0) as wait:
            self.assertEqual(gate.main(), 0)
        wait.assert_called_once_with("SonChangGi/sox", "2", 2700, 90, 2)

    def test_main_blocks_missing_or_malformed_workflow_attempt(self):
        for value in (None, "not-an-integer"):
            env = {"GITHUB_REPOSITORY": "SonChangGi/sox", "GITHUB_RUN_ID": "2"}
            if value is not None:
                env["GITHUB_RUN_ATTEMPT"] = value
            with self.subTest(value=value), patch.dict(gate.os.environ, env, clear=True), patch.object(sys, "argv", ["automation_admission.py"]), patch.object(gate, "wait_for_turn") as wait:
                self.assertEqual(gate.main(), 1)
                wait.assert_not_called()

    def test_observation_diagnostics_do_not_print_authentication_tokens(self):
        token = "private-test-token-not-for-logs"
        with patch.dict(gate.os.environ, {"GH_TOKEN": token, "GITHUB_TOKEN": token}), patch.object(gate, "api", return_value=run(2)), patch.object(
            gate, "started_attempt", side_effect=lambda repo, item: item
        ), patch.object(gate, "active_peers", return_value=[]):
            self.assertEqual(gate.wait_for_turn("SonChangGi/sox", "2", 100, 90), 0)
        self.assertIn("Admission observation", self.output.getvalue())
        self.assertIn('"observed_attempt": 1', self.output.getvalue())
        self.assertNotIn(token, self.output.getvalue())

    def test_only_active_factor_sox_etf_peers_are_coordinated(self):
        self.assertEqual(gate.WORKFLOWS, {
            "SonChangGi/sox": "deploy-pages.yml",
            "SonChangGi/factor": "daily-dashboard.yml",
            "SonChangGi/etf-tracking": "update-data.yml",
        })


if __name__ == "__main__":
    unittest.main()
