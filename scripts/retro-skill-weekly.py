#!/usr/bin/env python3
"""Read T3 evidence and checkpoint only reports acknowledged by the host.

No source-database writes, model calls, skill edits, or scheduler operations.
"""

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
import uuid


SKILL = "yjx-retro-skill"
TABLE = "orchestration_v2_projection_"
SCHEMA = {
    "threads": {"thread_id", "project_id", "deleted_at", "payload_json"},
    "runs": {"run_id", "thread_id", "status", "provider", "requested_at", "completed_at", "payload_json"},
    "turn_items": {"turn_item_id", "thread_id", "run_id", "type", "status", "updated_at", "payload_json"},
    "messages": {"message_id", "thread_id", "run_id", "role", "streaming", "created_at", "updated_at", "payload_json"},
}


def stamp(value=None):
    return (value or datetime.now(timezone.utc)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2))


@contextlib.contextmanager
def database(path):
    conn = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
        conn.execute("BEGIN")  # One consistent WAL snapshot, not a moving API page.
        for name, required in SCHEMA.items():
            actual = {r[1] for r in conn.execute(f"PRAGMA table_info({TABLE}{name})")}
            if not required <= actual:
                raise ValueError(f"T3 schema changed: {name}, missing {sorted(required - actual)}")
        yield conn
    finally:
        conn.close()


def events(conn, thread_id, cutoff):
    result = []
    message_ids = set()
    for row in conn.execute(f"SELECT i.*,r.requested_at AS run_started FROM {TABLE}turn_items i LEFT JOIN {TABLE}runs r ON r.run_id=i.run_id WHERE i.thread_id=? AND i.updated_at<=?", (thread_id, cutoff)):
        payload = json.loads(row["payload_json"])
        if payload.get("messageId"):
            message_ids.add(payload["messageId"])
        result.append({"id": row["turn_item_id"], "updatedAt": row["updated_at"], "sourceTime": payload.get("startedAt") or row["run_started"] or row["updated_at"], "data": payload})
    for row in conn.execute(f"SELECT * FROM {TABLE}messages WHERE thread_id=? AND updated_at<=?", (thread_id, cutoff)):
        if row["message_id"] in message_ids:
            continue
        payload = json.loads(row["payload_json"])
        payload["type"] = row["role"] + "_message"
        payload["messageId"] = row["message_id"]
        result.append({"id": row["message_id"], "updatedAt": row["updated_at"], "sourceTime": row["created_at"], "data": payload})
    return sorted(result, key=lambda e: (e["sourceTime"], e["data"].get("ordinal") or 0, e["id"]))


def identity(event):
    p = event["data"]
    native = p.get("nativeItemRef") or {}
    if native.get("strength") == "strong" and native.get("nativeId"):
        return f"{native.get('driver')}:{native['nativeId']}"
    return "t3:" + (p.get("messageId") or event["id"])


def inventory(conn, state, report_thread, cutoff):
    threads = {}
    deleted, imported = 0, 0
    for row in conn.execute(f"SELECT * FROM {TABLE}threads"):
        if row["deleted_at"] is not None:
            deleted += 1
            continue
        p = json.loads(row["payload_json"])
        if p.get("historyOrigin") == "v1_import" or row["thread_id"].startswith("import:"):
            imported += 1
            continue
        threads[row["thread_id"]] = p
    if report_thread not in threads:
        raise ValueError("Report thread is not available in this T3 database")
    excluded = {report_thread}
    while True:
        more = {tid for tid, p in threads.items() if (p.get("lineage") or {}).get("parentThreadId") in excluded or (p.get("lineage") or {}).get("rootThreadId") == report_thread}
        if more <= excluded:
            break
        excluded |= more
    matches = set()
    for name in ("turn_items", "messages"):
        for row in conn.execute(f"SELECT DISTINCT thread_id FROM {TABLE}{name} WHERE updated_at<=? AND instr(lower(payload_json),?)>0", (cutoff, SKILL)):
            matches.add(row[0])
    eligible = set(threads) - excluded
    neighbours = {tid: set() for tid in eligible}
    for tid in eligible:
        p = threads[tid]
        for parent in ((p.get("lineage") or {}).get("parentThreadId"), (p.get("forkedFrom") or {}).get("threadId")):
            if parent in eligible:
                neighbours[tid].add(parent)
                neighbours[parent].add(tid)
    related = matches & eligible
    frontier = set(related)
    while frontier:
        frontier = set().union(*(neighbours[tid] for tid in frontier)) - related
        related |= frontier
    candidates = []
    context_threads = {}
    providers = {}
    for tid, p in threads.items():
        if tid in excluded:
            continue
        provider = (p.get("modelSelection") or {}).get("instanceId") or p.get("providerInstanceId") or "unknown"
        providers[provider] = providers.get(provider, 0) + 1
        if tid not in related:
            continue
        rows = events(conn, tid, cutoff)
        fingerprint = digest(rows)
        context_threads[tid] = {"fingerprint": fingerprint, "relatedThreads": sorted(neighbours[tid]), "eventCount": len(rows)}
        latest = max((e["updatedAt"] for e in rows), default="")
        previous = state["checkpoints"].get(tid)
        if latest < state["since"] and tid not in state.get("gaps", {}):
            continue
        if previous and previous["fingerprint"] == fingerprint:
            continue
        keyword_refs = [{"id": e["id"], "type": e["data"].get("type"), "key": identity(e)} for e in rows if SKILL in json.dumps(e["data"], ensure_ascii=False).lower()]
        lineage = p.get("lineage") or {}
        actual_providers = [r[0] for r in conn.execute(f"SELECT DISTINCT provider FROM {TABLE}runs WHERE thread_id=?", (tid,))]
        candidates.append({
            "threadId": tid, "projectId": p.get("projectId"), "providers": actual_providers or [provider],
            "archived": p.get("archivedAt") is not None, "sideChat": lineage.get("sideChat") is True,
            "parentThreadId": lineage.get("parentThreadId"), "relationshipToParent": lineage.get("relationshipToParent"),
            "creationSource": p.get("creationSource"), "createdBy": p.get("createdBy"),
            "originUnverified": p.get("creationSource") not in {"web", "mobile", "mcp"} and not lineage.get("parentThreadId"),
            "matchReason": "name" if tid in matches else "associated-thread", "relatedThreads": sorted(neighbours[tid]),
            "fingerprint": fingerprint, "previousCutoff": previous.get("cutoff") if previous else None,
            "lastEvidenceUpdate": latest, "eventCount": len(rows), "keywordRefs": keyword_refs,
            "missingToolOutputs": sum(e["data"].get("type") in {"dynamic_tool", "command_execution"} and e["data"].get("output") is None for e in rows),
        })
    return {"since": state["since"], "cutoff": cutoff, "candidates": candidates, "contextThreads": context_threads,
            "coverage": {"availableThreads": len(threads), "excludedTaskThreads": len(excluded), "deletedThreads": deleted, "excludedImportedThreads": imported,
                         "providers": providers, "archivedThreads": sum(p.get("archivedAt") is not None for p in threads.values()),
                         "sideChats": sum((p.get("lineage") or {}).get("sideChat") is True for p in threads.values())},
            "priorSampleKeys": state.get("sampleKeys", []), "priorFindingKeys": state.get("findingKeys", []),
            "gaps": state.get("gaps", {})}


def fresh_state(now):
    return {"version": 1, "revision": 0, "since": stamp(now - timedelta(days=7)), "checkpoints": {},
            "sampleKeys": [], "findingKeys": [], "gaps": {}, "active": None}


def load_state(path, now):
    if not path.exists():
        return fresh_state(now)
    state = json.loads(path.read_text(encoding="utf-8"))
    required = {"version", "revision", "since", "checkpoints", "sampleKeys", "findingKeys", "gaps", "active"}
    if not isinstance(state, dict) or not required <= state.keys() or state["version"] != 1:
        raise ValueError("Invalid checkpoint; preserve it and investigate instead of resetting")
    if not isinstance(state["checkpoints"], dict) or not isinstance(state["gaps"], dict):
        raise ValueError("Invalid checkpoint maps")
    datetime.fromisoformat(state["since"].replace("Z", "+00:00"))
    if not isinstance(state["revision"], int) or state["revision"] < 0:
        raise ValueError("Invalid checkpoint revision")
    for key in ("sampleKeys", "findingKeys"):
        if not isinstance(state[key], list) or not all(isinstance(v, str) for v in state[key]):
            raise ValueError("Invalid checkpoint keys")
    for checkpoint in state["checkpoints"].values():
        if not isinstance(checkpoint, dict) or not {"fingerprint", "cutoff"} <= checkpoint.keys():
            raise ValueError("Invalid per-thread checkpoint")
    if state["active"] is not None and (not isinstance(state["active"], dict) or not {"token", "runId", "manifest", "manifestHash", "marker", "reportThreadId"} <= state["active"].keys()):
        raise ValueError("Invalid active report")
    if state["active"] is not None:
        uuid.UUID(state["active"]["token"])
    return state


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def locked(directory):
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "state.lock"
    token = f"{os.getpid()}:{uuid.uuid4()}"
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        raise ValueError(f"Checkpoint locked: {lock}; inspect owner, remove only after confirming it is stale") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(token)
        yield
    finally:
        if lock.read_text(encoding="utf-8") != token:
            raise ValueError("Lock ownership changed; preserve the lock and investigate")
        lock.unlink()


def run_status(conn, run_id):
    row = conn.execute(f"SELECT status FROM {TABLE}runs WHERE run_id=?", (run_id,)).fetchone()
    return row[0] if row else None


def receipt(conn, active):
    run = conn.execute(f"SELECT status,completed_at FROM {TABLE}runs WHERE run_id=? AND thread_id=?", (active["runId"], active["reportThreadId"])).fetchone()
    if not run or run["status"] != "completed" or not run["completed_at"]:
        return False
    matches = []
    for row in conn.execute(f"SELECT * FROM {TABLE}messages WHERE thread_id=? AND run_id=? AND role='assistant'", (active["reportThreadId"], active["runId"])):
        p = json.loads(row["payload_json"])
        text = p.get("text", "")
        if row["streaming"] or p.get("streaming") is not False or not text.startswith(active["marker"] + "\n") or not text[len(active["marker"]):].strip():
            continue
        items = conn.execute(f"SELECT payload_json FROM {TABLE}turn_items WHERE thread_id=? AND run_id=? AND type='assistant_message' AND status='completed'", (active["reportThreadId"], active["runId"]))
        for item in items:
            data = json.loads(item[0])
            if data.get("messageId") == row["message_id"] and data.get("streaming") is False and data.get("text") == text:
                matches.append(row["message_id"])
    return len(matches) == 1


def reconcile(conn, state):
    active = state.get("active")
    if not active:
        return
    if active.get("staged") and receipt(conn, active):
        for tid, checkpoint in active["staged"]["checkpoints"].items():
            state["checkpoints"][tid] = checkpoint
            state["gaps"].pop(tid, None)
        state["gaps"].update(active["staged"]["gaps"])
        state["sampleKeys"] = sorted(set(state["sampleKeys"]) | set(active["staged"]["sampleKeys"]))
        state["findingKeys"] = sorted(set(state["findingKeys"]) | set(active["staged"]["findingKeys"]))
        state["lastReport"] = {"runId": active["runId"], "marker": active["marker"]}
        state["active"] = None
    elif run_status(conn, active["runId"]) in {"completed", "failed", "cancelled", "interrupted", "rolled_back"}:
        # No delivery acknowledgement: no checkpoint advances, including on a
        # technically completed run which failed to include the report marker.
        state["active"] = None


def stage(state, manifest, decisions):
    active = state.get("active")
    if not active or active["token"] != manifest["token"] or active["manifestHash"] != digest(manifest):
        raise ValueError("Stale or foreign manifest")
    expected = {c["threadId"]: c for c in manifest["candidates"]}
    reviews = decisions.get("reviews", [])
    if len(reviews) != len(expected) or {r["threadId"] for r in reviews} != set(expected):
        raise ValueError("Every candidate needs exactly one reviewed/not-used/gap disposition")
    checkpoints, gaps, samples = {}, {}, []
    for review in reviews:
        tid, result = review["threadId"], review["result"]
        if result not in {"reviewed", "not-used", "gap"}:
            raise ValueError("Unknown review disposition")
        if result == "gap":
            if not review.get("reason"):
                raise ValueError("Evidence gap needs a reason")
            gaps[tid] = review["reason"]
            continue
        keys = review.get("sampleKeys", [])
        if not isinstance(keys, list):
            raise ValueError("sampleKeys must be a list of source identities")
        if result == "reviewed" and not keys:
            raise ValueError("A reviewed invocation needs stable source sample keys")
        if not all(isinstance(k, str) and k for k in keys):
            raise ValueError("Invalid sample key")
        samples += keys
        checkpoints[tid] = {"fingerprint": expected[tid]["fingerprint"], "cutoff": manifest["cutoff"]}
    finding_keys = decisions.get("findingKeys", [])
    if not isinstance(finding_keys, list) or not all(isinstance(k, str) and k for k in finding_keys):
        raise ValueError("Invalid finding keys")
    active["staged"] = {"checkpoints": checkpoints, "gaps": gaps, "sampleKeys": samples, "findingKeys": finding_keys}


def private_directory(repo):
    result = subprocess.run(["git", "rev-parse", "--git-path", "yjx-retro-weekly"], cwd=repo, check=True, capture_output=True, text=True)
    path = Path(result.stdout.strip())
    return path if path.is_absolute() else (repo / path).resolve()


def current_run(conn, report_thread):
    rows = conn.execute(f"SELECT run_id FROM {TABLE}runs WHERE thread_id=? AND status='running'", (report_thread,)).fetchall()
    if len(rows) != 1:
        raise ValueError("Expected exactly one running report-thread run; do not guess ownership")
    return rows[0][0]


def safe_content(value):
    if isinstance(value, dict):
        if value.get("type") in {"image", "input_image", "audio", "input_audio"}:
            return {"type": value["type"], "content": "[attachment omitted]"}
        return {k: ("[redacted]" if any(s in k.lower() for s in ("password", "secret", "api_key", "apikey", "access_token", "authorization")) else safe_content(v)) for k, v in value.items() if k not in {"attachments", "context"}}
    if isinstance(value, list):
        return [safe_content(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r"data:(?:image|audio|video)/[^;\s]+;base64,[A-Za-z0-9+/=\r\n]+", "[media payload omitted]", value)
        if len(value) > 256 and re.fullmatch(r"[A-Za-z0-9+/=\r\n]+", value):
            return "[encoded payload omitted]"
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["preflight", "begin", "read", "stage", "status"])
    parser.add_argument("--db", type=Path, default=Path.home() / ".t3/userdata/statev2.sqlite")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report-thread")
    parser.add_argument("--thread")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--decisions", type=Path)
    parser.add_argument("--after", type=int, default=0, help="Event offset in the fixed snapshot")
    parser.add_argument("--event", help="Read only this source event")
    parser.add_argument("--text-offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--max-chars", type=int, default=1800)
    args = parser.parse_args()
    if args.after < 0 or args.text_offset < 0 or not 1 <= args.limit <= 100 or not 100 <= args.max_chars <= 20000:
        parser.error("Invalid paging bounds")
    now = datetime.now(timezone.utc)
    directory = private_directory(args.repo.resolve())
    state_path = directory / "state.json"
    with database(args.db) as conn:
        if args.command == "read":
            if not args.manifest or not args.thread:
                parser.error("read requires --manifest and --thread")
            manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
            if args.thread not in manifest["contextThreads"]:
                raise ValueError("Only manifested candidate/context threads may be read")
            rows = events(conn, args.thread, manifest["cutoff"])
            candidate = manifest["contextThreads"][args.thread]
            if digest(rows) != candidate["fingerprint"]:
                raise ValueError("Source items changed after snapshot; mark this thread as a gap and retry next run")
            if args.event:
                rows = [e for e in rows if e["id"] == args.event]
            page = rows[args.after:args.after + args.limit]
            output = []
            for e in page:
                p = e["data"]
                fields = {k: p[k] for k in ("type", "status", "text", "input", "output", "toolName", "exitCode", "prompt", "result", "childThreadId") if k in p}
                content = json.dumps(safe_content(fields), ensure_ascii=False)
                start = args.text_offset if args.event else 0
                output.append({"id": e["id"], "key": identity(e), "sourceTime": e["sourceTime"], "ordinal": p.get("ordinal"), "updatedAt": e["updatedAt"], "runId": p.get("runId"), "providerThreadId": p.get("providerThreadId"), "content": content[start:start + args.max_chars], "truncated": len(content) > start + args.max_chars, "nextTextOffset": start + args.max_chars if len(content) > start + args.max_chars else None})
            emit({"events": output, "nextOffset": args.after + len(page) if args.after + len(page) < len(rows) else None, "totalEvents": len(rows)})
            return
        if args.command in {"preflight", "status"}:
            state = load_state(state_path, now)
            if args.command == "status":
                emit(state)
            else:
                if not args.report_thread:
                    parser.error("preflight requires --report-thread")
                snapshot = inventory(conn, state, args.report_thread, stamp(now))
                snapshot.pop("priorSampleKeys")
                snapshot.pop("priorFindingKeys")
                snapshot.pop("contextThreads")
                for c in snapshot["candidates"]:
                    c["keywordMatchCount"] = len(c["keywordRefs"])
                    c["keywordRefs"] = c["keywordRefs"][:5]
                emit(snapshot)
            return
        with locked(directory):
            state = load_state(state_path, now)
            if args.command == "begin":
                if not args.report_thread:
                    parser.error("begin requires --report-thread")
                old_active = state["active"]
                reconcile(conn, state)
                run_id = current_run(conn, args.report_thread)
                if state["active"]:
                    if state["active"]["runId"] != run_id:
                        raise ValueError("Previous run still active or unknown; preserve its state")
                    emit({"manifest": state["active"]["manifest"], "marker": state["active"]["marker"], "resumed": True})
                    return
                snapshot = inventory(conn, state, args.report_thread, stamp(now))
                token = str(uuid.uuid4())
                path = directory / f"scan-{token}.json"
                snapshot.update({"token": token, "runId": run_id, "reportThreadId": args.report_thread})
                atomic_json(path, snapshot)
                state["active"] = {"token": token, "runId": run_id, "reportThreadId": args.report_thread,
                                   "manifest": str(path), "manifestHash": digest(snapshot), "marker": f"<!-- retro-skill-weekly-report:{token} -->"}
                state["revision"] += 1
                atomic_json(state_path, state)
                if old_active and old_active["token"] != token:
                    for old_name in (f"scan-{old_active['token']}.json", f"review-{old_active['token']}.json"):
                        old_path = directory / old_name
                        if old_path.exists():
                            old_path.unlink()
                emit({"manifest": str(path), "marker": state["active"]["marker"], "candidates": snapshot["candidates"], "coverage": snapshot["coverage"], "since": snapshot["since"], "cutoff": snapshot["cutoff"]})
            elif args.command == "stage":
                if not args.manifest or not args.decisions:
                    parser.error("stage requires --manifest and --decisions")
                manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
                if current_run(conn, manifest["reportThreadId"]) != manifest["runId"]:
                    raise ValueError("Manifest owner is no longer the active report run")
                decisions = json.loads(args.decisions.read_text(encoding="utf-8"))
                stage(state, manifest, decisions)
                for review in decisions.get("reviews", []):
                    if review["result"] != "gap":
                        candidate = next(c for c in manifest["candidates"] if c["threadId"] == review["threadId"])
                        if digest(events(conn, review["threadId"], manifest["cutoff"])) != candidate["fingerprint"]:
                            raise ValueError("Source changed before staging; mark affected thread as gap")
                state["revision"] += 1
                atomic_json(state_path, state)
                emit({"staged": True, "marker": state["active"]["marker"], "checkpointCommitted": False})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, subprocess.CalledProcessError) as error:
        print(f"retro-skill-weekly: {error}", file=sys.stderr)
        sys.exit(1)
