"""Functional tests for checkpoint persistence and the T3 receipt protocol.

These exercise no model, skill prompt, or simulated conversation behavior.
"""

import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("retro_weekly", Path(__file__).resolve().parents[1] / "scripts/retro-skill-weekly.py")
weekly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(weekly)


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="retro-weekly-state-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.now = datetime(2026, 11, 12, tzinfo=timezone.utc)

    def test_interrupted_replace_preserves_old_checkpoint(self):
        path = self.root / "state.json"
        old = weekly.fresh_state(self.now)
        weekly.atomic_json(path, old)
        new = copy.deepcopy(old)
        new["revision"] = 1
        with patch.object(weekly.os, "replace", side_effect=OSError("replace interrupted")):
            with self.assertRaises(OSError):
                weekly.atomic_json(path, new)
        self.assertEqual(weekly.load_state(path, self.now), old)
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_corrupt_checkpoint_is_not_reset_or_overwritten(self):
        path = self.root / "state.json"
        path.write_text('{"version":', encoding="utf-8")
        with self.assertRaises(ValueError):
            weekly.load_state(path, self.now)
        self.assertEqual(path.read_text(encoding="utf-8"), '{"version":')

    def test_concurrent_writer_refused_and_lock_released_after_failure(self):
        with self.assertRaisesRegex(RuntimeError, "abort"):
            with weekly.locked(self.root):
                with self.assertRaisesRegex(ValueError, "locked"):
                    with weekly.locked(self.root):
                        self.fail("second writer acquired the lock")
                raise RuntimeError("abort")
        with weekly.locked(self.root):
            self.assertTrue((self.root / "state.lock").exists())

    def manifest_state(self):
        state = weekly.fresh_state(self.now)
        manifest = {"token": "token", "cutoff": weekly.stamp(self.now),
                    "candidates": [{"threadId": "source-a", "fingerprint": "fingerprint-a"}, {"threadId": "source-b", "fingerprint": "fingerprint-b"}]}
        state["active"] = {"token": "token", "runId": "run-a", "reportThreadId": "report-thread", "manifestHash": weekly.digest(manifest), "marker": "<!-- report:unique -->"}
        return manifest, state

    def test_staging_does_not_advance_and_requires_exhaustive_coverage(self):
        manifest, state = self.manifest_state()
        with self.assertRaisesRegex(ValueError, "Every candidate"):
            weekly.stage(state, manifest, {"reviews": [{"threadId": "source-a", "result": "not-used"}]})
        weekly.stage(state, manifest, {"reviews": [{"threadId": "source-a", "result": "reviewed", "sampleKeys": ["native:call"]}, {"threadId": "source-b", "result": "gap", "reason": "missing output"}]})
        self.assertEqual(state["checkpoints"], {})
        self.assertEqual(state["sampleKeys"], [])

    def test_changed_manifest_cannot_submit_checkpoint(self):
        manifest, state = self.manifest_state()
        manifest["candidates"][0]["fingerprint"] = "changed"
        with self.assertRaisesRegex(ValueError, "Stale or foreign"):
            weekly.stage(state, manifest, {"reviews": []})

    def protocol_database(self, status="completed", streaming=False, item=True, text=None):
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.row_factory = sqlite3.Row
        db.executescript("""
          CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, status TEXT, completed_at TEXT);
          CREATE TABLE orchestration_v2_projection_messages (message_id TEXT, thread_id TEXT, run_id TEXT, role TEXT, streaming INTEGER, payload_json TEXT);
          CREATE TABLE orchestration_v2_projection_turn_items (thread_id TEXT, run_id TEXT, type TEXT, status TEXT, payload_json TEXT);
        """)
        db.execute("INSERT INTO orchestration_v2_projection_runs VALUES (?,?,?,?)", ("run-a", "report-thread", status, weekly.stamp(self.now) if status == "completed" else None))
        payload = {"text": text or "<!-- report:unique -->\nreceipt-body", "streaming": streaming, "messageId": "receipt-a"}
        db.execute("INSERT INTO orchestration_v2_projection_messages VALUES (?,?,?,?,?,?)", ("receipt-a", "report-thread", "run-a", "assistant", streaming, json.dumps(payload)))
        if item:
            db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES (?,?,?,?,?)", ("report-thread", "run-a", "assistant_message", "completed", json.dumps(payload)))
        return db

    def test_only_acknowledged_report_commits_progress_and_keeps_gaps(self):
        manifest, state = self.manifest_state()
        weekly.stage(state, manifest, {"reviews": [{"threadId": "source-a", "result": "reviewed", "sampleKeys": ["native:call"]}, {"threadId": "source-b", "result": "gap", "reason": "missing output"}], "findingKeys": ["cause-key"]})
        weekly.reconcile(self.protocol_database(), state)
        self.assertEqual(set(state["checkpoints"]), {"source-a"})
        self.assertEqual(state["gaps"], {"source-b": "missing output"})
        self.assertEqual(state["sampleKeys"], ["native:call"])
        self.assertIsNone(state["active"])

    def test_failed_run_does_not_advance_even_with_receipt_text(self):
        manifest, state = self.manifest_state()
        weekly.stage(state, manifest, {"reviews": [{"threadId": "source-a", "result": "not-used"}, {"threadId": "source-b", "result": "not-used"}]})
        original_since = state["since"]
        weekly.reconcile(self.protocol_database(status="failed"), state)
        self.assertEqual(state["checkpoints"], {})
        self.assertEqual(state["since"], original_since)

    def test_receipt_needs_matching_persisted_items_not_a_quote(self):
        _, state = self.manifest_state()
        for kwargs in [{"streaming": True}, {"item": False}, {"text": "quoted\n<!-- report:unique -->\nbody"}]:
            with self.subTest(kwargs=kwargs):
                self.assertFalse(weekly.receipt(self.protocol_database(**kwargs), state["active"]))
        db = self.protocol_database()
        db.execute("UPDATE orchestration_v2_projection_messages SET run_id='other-run'")
        self.assertFalse(weekly.receipt(db, state["active"]))

    def test_ambiguous_or_unfinished_receipts_do_not_commit(self):
        _, state = self.manifest_state()
        db = self.protocol_database()
        db.execute("INSERT INTO orchestration_v2_projection_messages SELECT * FROM orchestration_v2_projection_messages")
        self.assertFalse(weekly.receipt(db, state["active"]))
        db = self.protocol_database()
        db.execute("UPDATE orchestration_v2_projection_runs SET completed_at=NULL")
        self.assertFalse(weekly.receipt(db, state["active"]))

    def test_unknown_running_owner_cannot_be_silently_discarded(self):
        _, state = self.manifest_state()
        active = copy.deepcopy(state["active"])
        weekly.reconcile(self.protocol_database(status="running"), state)
        self.assertEqual(state["active"], active)

    def test_source_database_is_actually_read_only(self):
        path = self.root / "source.sqlite"
        db = sqlite3.connect(path)
        for name, columns in weekly.SCHEMA.items():
            db.execute(f"CREATE TABLE {weekly.TABLE}{name} ({','.join(c + ' TEXT' for c in columns)})")
        db.commit()
        db.close()
        with weekly.database(path) as ro:
            with self.assertRaises(sqlite3.OperationalError):
                ro.execute(f"DELETE FROM {weekly.TABLE}threads")

    def inventory_database(self):
        db = sqlite3.connect(":memory:")
        self.addCleanup(db.close)
        db.row_factory = sqlite3.Row
        for name, columns in weekly.SCHEMA.items():
            db.execute(f"CREATE TABLE {weekly.TABLE}{name} ({','.join(c + (' INTEGER' if c == 'streaming' else ' TEXT') for c in columns)})")
        def thread(tid, **extra):
            p = {"id": tid, "projectId": "project", "providerInstanceId": "provider-a", "creationSource": "web", "lineage": {}, **extra}
            db.execute(f"INSERT INTO {weekly.TABLE}threads (thread_id,project_id,payload_json) VALUES (?,?,?)", (tid, "project", json.dumps(p)))
        thread("report")
        thread("source", archivedAt="2026-10-01T00:00:00.000Z", lineage={"sideChat": True})
        thread("import:external", historyOrigin="v1_import")
        thread("task-child", lineage={"parentThreadId": "report"})
        p = {"type": "command_execution", "input": {"skill": weekly.SKILL}, "output": None, "ordinal": 1}
        for tid in ["source", "import:external", "task-child"]:
            db.execute(f"INSERT INTO {weekly.TABLE}turn_items (turn_item_id,thread_id,updated_at,payload_json) VALUES (?,?,?,?)", (tid + "-event", tid, "2026-11-11T00:00:00.000Z", json.dumps(p)))
        return db

    def test_late_output_requeues_same_event_without_moving_initial_window(self):
        db = self.inventory_database()
        state = weekly.fresh_state(self.now)
        cutoff = "2026-11-12T00:00:00.000Z"
        first = weekly.inventory(db, state, "report", cutoff)
        self.assertEqual([c["threadId"] for c in first["candidates"]], ["source"])
        original = first["candidates"][0]
        state["checkpoints"]["source"] = {"fingerprint": original["fingerprint"], "cutoff": cutoff}
        self.assertEqual(weekly.inventory(db, state, "report", cutoff)["candidates"], [])
        original_since = state["since"]
        db.execute(f"UPDATE {weekly.TABLE}turn_items SET updated_at=?,payload_json=? WHERE thread_id='source'", ("2026-11-12T01:00:00.000Z", json.dumps({"type": "command_execution", "input": {"skill": weekly.SKILL}, "output": "finished", "ordinal": 1})))
        second = weekly.inventory(db, state, "report", "2026-11-12T02:00:00.000Z")
        self.assertEqual([c["threadId"] for c in second["candidates"]], ["source"])
        self.assertNotEqual(second["candidates"][0]["fingerprint"], original["fingerprint"])
        self.assertEqual(state["since"], original_since)

    def test_unnamed_fork_feedback_requeues_with_older_parent_context(self):
        db = self.inventory_database()
        db.execute(f"UPDATE {weekly.TABLE}turn_items SET updated_at='2026-10-01T00:00:00.000Z' WHERE thread_id='source'")
        p = {"id": "feedback-fork", "projectId": "project", "creationSource": "web", "lineage": {"parentThreadId": "source", "relationshipToParent": "fork"}}
        db.execute(f"INSERT INTO {weekly.TABLE}threads (thread_id,project_id,payload_json) VALUES (?,?,?)", ("feedback-fork", "project", json.dumps(p)))
        db.execute(f"INSERT INTO {weekly.TABLE}turn_items (turn_item_id,thread_id,updated_at,payload_json) VALUES (?,?,?,?)", ("feedback-event", "feedback-fork", "2026-11-11T00:00:00.000Z", json.dumps({"type": "command_execution", "output": "opaque-new-result"})))
        state = weekly.fresh_state(self.now)
        first = weekly.inventory(db, state, "report", weekly.stamp(self.now))
        self.assertEqual([c["threadId"] for c in first["candidates"]], ["feedback-fork"])
        candidate = first["candidates"][0]
        self.assertEqual(candidate["matchReason"], "associated-thread")
        self.assertEqual(candidate["keywordRefs"], [])
        self.assertIn("source", first["contextThreads"])
        state["checkpoints"]["feedback-fork"] = {"fingerprint": candidate["fingerprint"], "cutoff": first["cutoff"]}
        self.assertEqual(weekly.inventory(db, state, "report", weekly.stamp(self.now))["candidates"], [])

    def test_cli_checkpoint_roundtrip_uses_receipt_and_cleans_owned_manifests(self):
        subprocess.run(["git", "init", "--quiet", str(self.root)], check=True, capture_output=True)
        db_path = self.root / "source.sqlite"
        source = self.inventory_database()
        source.commit()
        db = sqlite3.connect(db_path)
        self.addCleanup(db.close)
        source.backup(db)
        now = weekly.stamp()
        db.execute(f"UPDATE {weekly.TABLE}turn_items SET updated_at=?", (now,))
        db.execute(f"INSERT INTO {weekly.TABLE}runs (run_id,thread_id,status,requested_at) VALUES (?,?,?,?)", ("run-first", "report", "running", now))
        db.commit()
        script = str(Path(weekly.__file__).resolve())
        def cli(command, *args):
            out = subprocess.run([sys.executable, "-B", script, command, "--repo", str(self.root), "--db", str(db_path), *args], check=True, capture_output=True, text=True, encoding="utf-8")
            return json.loads(out.stdout)
        cli("preflight", "--report-thread", "report")
        self.assertFalse((self.root / ".git/yjx-retro-weekly").exists())
        begun = cli("begin", "--report-thread", "report")
        manifest = Path(begun["manifest"])
        data = json.loads(manifest.read_text(encoding="utf-8"))
        review = manifest.parent / f"review-{data['token']}.json"
        weekly.atomic_json(review, {"reviews": [{"threadId": "source", "result": "not-used"}]})
        staged = cli("stage", "--manifest", str(manifest), "--decisions", str(review))
        self.assertFalse(staged["checkpointCommitted"])
        self.assertEqual(cli("status")["checkpoints"], {})
        payload = {"text": begun["marker"] + "\nreceipt-body", "messageId": "receipt", "streaming": False}
        db.execute(f"UPDATE {weekly.TABLE}runs SET status='completed',completed_at=? WHERE run_id='run-first'", (now,))
        db.execute(f"INSERT INTO {weekly.TABLE}messages (message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES (?,?,?,?,?,?,?,?)", ("receipt", "report", "run-first", "assistant", 0, now, now, json.dumps(payload)))
        db.execute(f"INSERT INTO {weekly.TABLE}turn_items (turn_item_id,thread_id,run_id,type,status,updated_at,payload_json) VALUES (?,?,?,?,?,?,?)", ("receipt-item", "report", "run-first", "assistant_message", "completed", now, json.dumps(payload)))
        db.execute(f"INSERT INTO {weekly.TABLE}runs (run_id,thread_id,status,requested_at) VALUES (?,?,?,?)", ("run-second", "report", "running", now))
        db.commit()
        second = cli("begin", "--report-thread", "report")
        self.assertEqual(second["candidates"], [])
        self.assertEqual(set(cli("status")["checkpoints"]), {"source"})
        self.assertFalse(manifest.exists())
        self.assertFalse(review.exists())


if __name__ == "__main__":
    unittest.main()
