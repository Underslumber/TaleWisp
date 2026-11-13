"""Durable controller logic. Credentials authorize application actions only."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class WardenError(ValueError):
    pass


DECISIONS = {"CONTINUE", "ACCEPT", "BLOCKED", "PAUSED", "CANCELLED", "INVESTIGATION"}
ROLES = {"owner", "executor", "reviewer"}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


class Controller:
    def __init__(self, db: str | Path, workspace: str | Path, create_workspace: bool = False):
        self.db = Path(db)
        self.db.parent.mkdir(parents=True, exist_ok=True)
        self.workspace = Path(workspace).resolve()
        if create_workspace: self.workspace.mkdir(parents=True, exist_ok=True)
        elif not self.workspace.is_dir(): raise WardenError("workspace does not exist")
        self.con = sqlite3.connect(self.db, timeout=10)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA foreign_keys=ON")
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.executescript("""
        CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS task_revision(task_id TEXT NOT NULL REFERENCES task(id), version INTEGER NOT NULL,
          requirements TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(task_id,version));
        CREATE TABLE IF NOT EXISTS task(id TEXT PRIMARY KEY, version INTEGER NOT NULL,
          requirements TEXT NOT NULL, state TEXT NOT NULL, budget INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, no_progress_count INTEGER NOT NULL DEFAULT 0,
          no_progress_signature TEXT NOT NULL DEFAULT '', workspace TEXT NOT NULL,
          checkpoint TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS capability(task_id TEXT NOT NULL REFERENCES task(id), role TEXT NOT NULL,
          token_hash TEXT NOT NULL, PRIMARY KEY(task_id,role));
        CREATE TABLE IF NOT EXISTS evidence(task_id TEXT NOT NULL REFERENCES task(id), criterion TEXT NOT NULL,
          version INTEGER NOT NULL, relpath TEXT NOT NULL, fingerprint TEXT NOT NULL, note TEXT NOT NULL,
          PRIMARY KEY(task_id,criterion));
        CREATE TABLE IF NOT EXISTS review(task_id TEXT NOT NULL REFERENCES task(id), criterion TEXT NOT NULL,
          version INTEGER NOT NULL, fingerprint TEXT NOT NULL, reviewer TEXT NOT NULL, verdict TEXT NOT NULL,
          note TEXT NOT NULL, PRIMARY KEY(task_id,criterion));
        CREATE TABLE IF NOT EXISTS semantic_audit(task_id TEXT NOT NULL REFERENCES task(id), version INTEGER NOT NULL,
          context_hashes TEXT NOT NULL, model TEXT NOT NULL, agent TEXT NOT NULL, conversation_id TEXT NOT NULL,
          decision TEXT NOT NULL, receipt TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS semantic_attempt(task_id TEXT NOT NULL REFERENCES task(id), signature TEXT NOT NULL,
          state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(task_id,signature));
        CREATE TABLE IF NOT EXISTS event(id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, actor TEXT NOT NULL,
          kind TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        """)
        if not self.con.execute("SELECT 1 FROM schema_meta LIMIT 1").fetchone():
            self.con.execute("INSERT INTO schema_meta(version) VALUES(2)")
        elif self.con.execute("SELECT version FROM schema_meta LIMIT 1").fetchone()[0] != 2:
            raise WardenError("unsupported database schema version")
        self.con.commit()

    @contextmanager
    def _write(self):
        self.con.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self.con.rollback()
            raise
        else:
            self.con.commit()

    def close(self) -> None:
        self.con.close()

    def _event(self, tid: str, actor: str, kind: str, detail: Any) -> None:
        self.con.execute("INSERT INTO event(task_id,actor,kind,detail) VALUES(?,?,?,?)", (tid, actor, kind, _json(detail)))

    def _task(self, tid: str) -> sqlite3.Row:
        row = self.con.execute("SELECT * FROM task WHERE id=?", (tid,)).fetchone()
        if row is None:
            raise WardenError("unknown task")
        if Path(row["workspace"]).resolve() != self.workspace:
            raise WardenError("workspace does not match the task's persisted workspace")
        return row

    def _auth(self, tid: str, role: str, token: str) -> None:
        if role not in ROLES or not isinstance(token, str):
            raise WardenError("invalid role or token")
        row = self.con.execute("SELECT token_hash FROM capability WHERE task_id=? AND role=?", (tid, role)).fetchone()
        if row is None or not secrets.compare_digest(row[0], hashlib.sha256(token.encode()).hexdigest()):
            raise WardenError("capability denied")

    @staticmethod
    def validate_requirements(req: Any) -> list[dict[str, Any]]:
        if not isinstance(req, dict) or set(req) not in ({"goal", "scope", "criteria"}, {"goal", "scope", "criteria", "dispatch"}):
            raise WardenError("requirements require goal, scope, criteria and optional dispatch")
        if "dispatch" in req:
            from .dispatch import validate_contract
            validate_contract(req["dispatch"])
        if not isinstance(req["goal"], str) or not req["goal"].strip() or not isinstance(req["scope"], list) or not req["scope"]:
            raise WardenError("goal and non-empty scope are required")
        for x in req["scope"]:
            if not isinstance(x, str) or not x.strip() or Path(x).is_absolute() or ".." in Path(x).parts:
                raise WardenError("scope entries must be safe relative paths")
        criteria = req["criteria"]
        if not isinstance(criteria, list) or not criteria:
            raise WardenError("at least one criterion is required")
        seen: set[str] = set()
        result = []
        for c in criteria:
            if not isinstance(c, dict) or set(c) != {"id", "text", "mandatory"} or not isinstance(c["id"], str) or not isinstance(c["text"], str) or not isinstance(c["mandatory"], bool):
                raise WardenError("criterion fields must be id, text, mandatory")
            if not c["id"].strip() or not c["text"].strip() or c["id"] in seen:
                raise WardenError("criterion ids and text must be unique and non-empty")
            seen.add(c["id"])
            result.append(c)
        if not any(c["mandatory"] for c in result):
            raise WardenError("at least one mandatory criterion is required")
        return result

    def create(self, tid: str, req: Any, scope: list[str], budget: int = 12) -> dict[str, str]:
        criteria = self.validate_requirements(req)
        if not isinstance(tid, str) or not tid or not isinstance(budget, int) or isinstance(budget, bool) or budget < 1:
            raise WardenError("invalid task id or budget")
        if not isinstance(scope, list) or scope != req["scope"]:
            raise WardenError("workspace scope must exactly match requirements scope")
        tokens = {role: secrets.token_urlsafe(32) for role in ROLES}
        try:
            with self._write():
                self.con.execute("INSERT INTO task(id,version,requirements,state,budget,workspace) VALUES(?,1,?,'ACTIVE',?,?)", (tid, _json(req), budget, str(self.workspace)))
                self.con.execute("INSERT INTO task_revision(task_id,version,requirements) VALUES(?,1,?)", (tid, _json(req)))
                self.con.executemany("INSERT INTO capability(task_id,role,token_hash) VALUES(?,?,?)", [(tid, r, hashlib.sha256(t.encode()).hexdigest()) for r, t in tokens.items()])
                self._event(tid, "owner", "created", {"version": 1})
        except sqlite3.IntegrityError as e:
            raise WardenError("task already exists") from e
        return tokens

    def amend(self, tid: str, token: str, expected_version: int, req: Any) -> dict[str, Any]:
        self.validate_requirements(req)
        with self._write():
            self._auth(tid, "owner", token)
            row = self._task(tid)
            if row["version"] != expected_version:
                raise WardenError("version conflict; reload before amending")
            version = expected_version + 1
            state = "ACTIVE" if row["state"] == "ACCEPTED" else row["state"]
            cur = self.con.execute("UPDATE task SET version=?,requirements=?,state=?,no_progress_count=0,no_progress_signature='',updated=CURRENT_TIMESTAMP WHERE id=? AND version=?", (version, _json(req), state, tid, expected_version))
            if cur.rowcount != 1: raise WardenError("version conflict; reload before amending")
            self.con.execute("DELETE FROM evidence WHERE task_id=?", (tid,))
            self.con.execute("DELETE FROM review WHERE task_id=?", (tid,))
            self._event(tid, "owner", "amended", {"version": version})
            self.con.execute("INSERT INTO task_revision(task_id,version,requirements) VALUES(?,?,?)", (tid, version, _json(req)))
        return {"task": tid, "version": version, "state": state}

    def _scoped_artifact(self, tid: str, rel: str, *, max_artifact_bytes: int | None = None) -> tuple[Path, str]:
        task = self._task(tid)
        req = json.loads(task["requirements"])
        if (max_artifact_bytes is not None
                and (type(max_artifact_bytes) is not int or max_artifact_bytes < 0)):
            raise WardenError("artifact byte limit must be a non-negative integer")
        if not isinstance(rel, str) or not rel or Path(rel).is_absolute() or ".." in Path(rel).parts:
            raise WardenError("artifact must be a relative file path")
        base = self.workspace.resolve()
        path = base / rel
        try:
            resolved = path.resolve(strict=True)
        except OSError as e:
            raise WardenError("artifact does not exist or cannot be resolved") from e
        if not resolved.is_relative_to(base) or not resolved.is_file():
            raise WardenError("artifact escapes workspace or is not a file")
        scopes = [Path(x) for x in req["scope"]]
        if not any(resolved.is_relative_to((base / s).resolve()) for s in scopes):
            raise WardenError("artifact outside authorized scope")
        if max_artifact_bytes is None:
            digest = hashlib.sha256(resolved.read_bytes()).hexdigest()
        else:
            digest_builder = hashlib.sha256()
            total = 0
            try:
                with resolved.open("rb") as stream:
                    before = os.fstat(stream.fileno())
                    if before.st_size > max_artifact_bytes:
                        raise WardenError("artifact exceeds byte limit")
                    while True:
                        block = stream.read(min(64 * 1024, max_artifact_bytes - total + 1))
                        if not block:
                            break
                        total += len(block)
                        if total > max_artifact_bytes:
                            raise WardenError("artifact exceeds byte limit")
                        digest_builder.update(block)
                    after = os.fstat(stream.fileno())
                    if after.st_size > max_artifact_bytes or total > max_artifact_bytes:
                        raise WardenError("artifact exceeds byte limit")
            except OSError as e:
                raise WardenError("artifact could not be read within byte limit") from e
            digest = digest_builder.hexdigest()
        return resolved, digest

    def _scope_snapshot(self, req: dict[str, Any]) -> list[tuple[str, int, int]]:
        """Small metadata snapshot used only to detect equivalent no-progress retries."""
        found: list[tuple[str, int, int]] = []
        for scope in req["scope"]:
            root = (self.workspace / scope).resolve()
            if not root.is_relative_to(self.workspace) or not root.exists(): continue
            candidates = [root] if root.is_file() else []
            if root.is_dir():
                for current, dirs, files in os.walk(root, followlinks=False):
                    dirs[:] = [d for d in dirs if not (Path(current) / d).is_symlink()]
                    candidates.extend(Path(current) / name for name in files)
                    if len(found) + len(candidates) > 5000: break
            for p in candidates:
                if p.is_symlink() or not p.is_file(): continue
                st = p.stat()
                found.append((str(p.relative_to(self.workspace)), st.st_size, st.st_mtime_ns))
        return sorted(set(found))

    def evidence_add(self, tid: str, token: str, expected_version: int, criterion: str, relpath: str, note: str,
                    *, max_artifact_bytes: int | None = None) -> dict[str, Any]:
        with self._write():
            self._auth(tid, "executor", token)
            task = self._task(tid)
            if expected_version != task["version"]: raise WardenError("version conflict; reload before adding evidence")
            if task["state"] != "ACTIVE":
                raise WardenError("task is not active")
            req = json.loads(task["requirements"])
            if criterion not in {c["id"] for c in req["criteria"]} or not isinstance(note, str):
                raise WardenError("unknown criterion or invalid note")
            _, fp = self._scoped_artifact(tid, relpath, max_artifact_bytes=max_artifact_bytes)
            prior = self.con.execute("SELECT version,relpath,fingerprint FROM evidence WHERE task_id=? AND criterion=?", (tid, criterion)).fetchone()
            same_artifact = prior is not None and prior["version"] == task["version"] and prior["relpath"] == relpath and prior["fingerprint"] == fp
            self.con.execute("INSERT OR REPLACE INTO evidence VALUES(?,?,?,?,?,?)", (tid, criterion, task["version"], relpath, fp, note))
            if not same_artifact:
                self.con.execute("DELETE FROM review WHERE task_id=? AND criterion=?", (tid, criterion))
            self._event(tid, "executor", "evidence", {"criterion": criterion, "fingerprint": fp})
        return {"criterion": criterion, "fingerprint": fp, "version": task["version"]}

    def review_add(self, tid: str, token: str, expected_version: int, expected_fingerprint: str, criterion: str, verdict: str, note: str) -> dict[str, Any]:
        if verdict not in {"ACCEPT", "REJECT"} or not isinstance(note, str) or not note.strip():
            raise WardenError("review requires ACCEPT/REJECT and a non-empty note")
        if not isinstance(expected_fingerprint, str) or len(expected_fingerprint) != 64 or any(c not in "0123456789abcdef" for c in expected_fingerprint):
            raise WardenError("review requires the exact lowercase SHA-256 fingerprint inspected by the reviewer")
        with self._write():
            self._auth(tid, "reviewer", token)
            task = self._task(tid)
            if expected_version != task["version"]: raise WardenError("version conflict; reload before reviewing")
            ev = self.con.execute("SELECT * FROM evidence WHERE task_id=? AND criterion=?", (tid, criterion)).fetchone()
            req = json.loads(task["requirements"])
            if criterion not in {c["id"] for c in req["criteria"]} or ev is None or ev["version"] != task["version"]:
                raise WardenError("no current evidence for criterion")
            if ev["fingerprint"] != expected_fingerprint:
                raise WardenError("evidence fingerprint changed since reviewer inspection")
            _, current = self._scoped_artifact(tid, ev["relpath"])
            if current != expected_fingerprint:
                raise WardenError("evidence is stale")
            reviewer = hashlib.sha256(token.encode()).hexdigest()[:16]
            self.con.execute("INSERT OR REPLACE INTO review VALUES(?,?,?,?,?,?,?)", (tid, criterion, task["version"], expected_fingerprint, reviewer, verdict, note))
            self._event(tid, "reviewer", "review", {"criterion": criterion, "verdict": verdict})
        return {"criterion": criterion, "verdict": verdict, "version": task["version"], "fingerprint": current}

    def semantic_review_record(self, tid: str, token: str, expected_version: int,
                               fingerprints: dict[str, str], verdicts: dict[str, dict[str, str]],
                               context_hashes: dict[str, str], model: str, agent: str,
                               conversation_id: str, receipt: dict[str, Any]) -> dict[str, Any]:
        """Persist Gemini review only when every inspected input is still current."""
        if any(not isinstance(x, str) or not x for x in (model, agent, conversation_id)):
            raise WardenError("semantic receipt identity is incomplete")
        manifest_marker = receipt.get("context_manifest") if isinstance(receipt, dict) else None
        receipt_sources = receipt.get("sources") if isinstance(receipt, dict) else None
        if (not isinstance(manifest_marker, str) or not manifest_marker or manifest_marker not in context_hashes
                or not isinstance(receipt_sources, dict) or receipt_sources.get(manifest_marker) != context_hashes.get(manifest_marker)):
            raise WardenError("semantic receipt is not bound to its context manifest")
        with self._write():
            self._auth(tid, "reviewer", token)
            task = self._task(tid)
            if task["version"] != expected_version:
                raise WardenError("version conflict; semantic review is stale")
            req = json.loads(task["requirements"])
            criteria = {c["id"] for c in req["criteria"] if c["id"] in fingerprints}
            mandatory = {c["id"] for c in req["criteria"] if c["mandatory"]}
            if not mandatory.issubset(criteria):
                raise WardenError("semantic review cannot accept without all mandatory evidence")
            if set(verdicts) != criteria or set(fingerprints) != criteria:
                raise WardenError("semantic review must cover exactly the current criteria and evidence")
            for relpath, expected_hash in context_hashes.items():
                path = (self.workspace / relpath).resolve(strict=True)
                if not path.is_relative_to(self.workspace) or not path.is_file():
                    raise WardenError("semantic context escaped workspace")
                if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
                    raise WardenError("semantic context changed during review")
            for criterion in criteria:
                ev = self.con.execute("SELECT * FROM evidence WHERE task_id=? AND criterion=?", (tid, criterion)).fetchone()
                if ev is None or ev["version"] != expected_version or ev["fingerprint"] != fingerprints[criterion]:
                    raise WardenError("semantic evidence changed during review")
                _, now = self._scoped_artifact(tid, ev["relpath"])
                if now != fingerprints[criterion]:
                    raise WardenError("semantic evidence artifact is stale")
                item = verdicts[criterion]
                if not isinstance(item, dict) or set(item) != {"verdict", "note"} or item["verdict"] not in {"ACCEPT", "REJECT"} or not isinstance(item["note"], str) or not item["note"].strip():
                    raise WardenError("invalid per-criterion semantic verdict")
            overall = "ACCEPT" if all(x["verdict"] == "ACCEPT" for x in verdicts.values()) else "REJECT"
            for criterion, item in verdicts.items():
                self.con.execute("INSERT OR REPLACE INTO review VALUES(?,?,?,?,?,?,?)",
                    (tid, criterion, expected_version, fingerprints[criterion], "gemini:" + model, item["verdict"], item["note"][:4000]))
            audit = {"model": model, "agent": agent, "conversation_id": conversation_id,
                     "decision": overall, "context_hashes": context_hashes, "receipt": receipt}
            self.con.execute("INSERT INTO semantic_audit(task_id,version,context_hashes,model,agent,conversation_id,decision,receipt) VALUES(?,?,?,?,?,?,?,?)",
                (tid, expected_version, _json(context_hashes), model, agent, conversation_id, overall, _json(receipt)))
            self._event(tid, "reviewer", "semantic_review", audit)
        return {"task": tid, "version": expected_version, "decision": overall, "criteria": verdicts, "context_hashes": context_hashes}

    def semantic_attempt_start(self, tid: str, token: str, signature: str) -> tuple[str, str]:
        with self._write():
            self._auth(tid, "reviewer", token)
            self._task(tid)
            existing = self.con.execute("SELECT state,detail FROM semantic_attempt WHERE task_id=? AND signature=?", (tid, signature)).fetchone()
            if existing:
                if existing[0] == "SUCCESS": return existing[0], existing[1]
                raise WardenError("semantic review already attempted or in progress for these unchanged inputs; no retry")
            self.con.execute("INSERT INTO semantic_attempt(task_id,signature,state) VALUES(?,?,'RUNNING')", (tid, signature))
            self._event(tid, "reviewer", "semantic_review_started", {"signature": signature})
        return "RUNNING", ""

    def semantic_attempt_finish(self, tid: str, token: str, signature: str, state: str, detail: str = "") -> None:
        if state not in {"SUCCESS", "FAILED"}:
            raise WardenError("invalid semantic attempt state")
        if not isinstance(detail, str):
            raise WardenError("semantic attempt detail must be text")
        if state == "SUCCESS":
            if len(detail.encode("utf-8")) > 64 * 1024:
                raise WardenError("semantic success cache exceeds 64 KiB")
            try:
                parsed = json.loads(detail)
            except json.JSONDecodeError as exc:
                raise WardenError("semantic success cache must be valid JSON") from exc
            if not isinstance(parsed, dict):
                raise WardenError("semantic success cache must be a JSON object")
        else:
            detail = detail[:500]
        with self._write():
            self._auth(tid, "reviewer", token)
            self._task(tid)
            self.con.execute("UPDATE semantic_attempt SET state=?,detail=? WHERE task_id=? AND signature=? AND state='RUNNING'",
                             (state, detail, tid, signature))
            self._event(tid, "reviewer", "semantic_review_" + state.lower(), {"signature": signature, "detail": detail[:500]})

    def _semantic_audit_current(self, tid: str, version: int) -> bool:
        audit = self.con.execute("SELECT context_hashes,receipt FROM semantic_audit WHERE task_id=? AND version=? ORDER BY rowid DESC LIMIT 1", (tid, version)).fetchone()
        if audit is None:
            return False
        try:
            hashes = json.loads(audit[0])
            receipt = json.loads(audit[1])
            marker = receipt.get("context_manifest") if isinstance(receipt, dict) else None
            sources = receipt.get("sources") if isinstance(receipt, dict) else None
            if not isinstance(hashes, dict) or not isinstance(sources, dict) or not isinstance(marker, str) or not marker or marker not in hashes or sources.get(marker) != hashes[marker]:
                return False
            for relpath, expected in hashes.items():
                path = (self.workspace / relpath).resolve(strict=True)
                if not path.is_relative_to(self.workspace) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                    return False
            return True
        except (OSError, ValueError, TypeError, AttributeError):
            return False

    def decide(self, tid: str, role: str, token: str, event: str, payload: dict[str, Any] | None = None, expected_version: int | None = None) -> dict[str, Any]:
        allowed = {"checkpoint", "completion_request", "owner_pause", "owner_cancel", "investigate", "owner_resume"}
        if event not in allowed or not isinstance(payload or {}, dict) or set(payload or {}) - {"note", "dependency", "stop_hook_active", "subagent_id", "no_progress"}:
            raise WardenError("unknown event or payload field")
        payload = payload or {}
        for flag in ("stop_hook_active", "dependency", "no_progress"):
            if flag in payload and not isinstance(payload[flag], bool):
                raise WardenError(f"{flag} must be boolean")
        if "subagent_id" in payload and payload["subagent_id"] is not None and not isinstance(payload["subagent_id"], str):
            raise WardenError("subagent_id must be a string")
        with self._write():
            self._auth(tid, role, token)
            task = self._task(tid)
            if expected_version is None or expected_version != task["version"]:
                raise WardenError("version conflict; reload before acting")
            state, decision, reason = task["state"], "CONTINUE", "work remains actionable"
            if event in {"owner_pause", "owner_cancel", "owner_resume"} and role != "owner":
                raise WardenError("owner capability required")
            if event in {"checkpoint", "completion_request"} and role != "executor":
                raise WardenError("executor capability required")
            if event == "investigate" and role != "owner":
                raise WardenError("owner capability required")
            if event in {"checkpoint", "completion_request"} and task["state"] in {"PAUSED", "CANCELLED", "INVESTIGATION", "BLOCKED"}:
                state, decision = task["state"], task["state"]
                if state == "INVESTIGATION":
                    reason = "Task is in owner-requested investigation. Continue bounded diagnosis using read-only evidence and report the cause; do not resume the original task until the owner explicitly resumes it."
                elif state == "BLOCKED":
                    reason = "Task is blocked and remains incomplete. Perform bounded diagnosis of the blocking condition, identify the specific owner action needed, and do not retry expensive review or exceed the configured budget."
                else:
                    reason = "Task is intentionally stopped by the owner; preserve that pause or cancellation."
            elif event == "owner_pause": state, decision, reason = "PAUSED", "PAUSED", "owner pause"
            elif event == "owner_cancel": state, decision, reason = "CANCELLED", "CANCELLED", "owner cancelled task"
            elif event == "owner_resume":
                if state not in {"PAUSED", "BLOCKED", "INVESTIGATION"}: raise WardenError("task cannot be resumed from this state")
                state, decision, reason = "ACTIVE", "CONTINUE", "owner resumed task"
            elif event == "investigate": state, decision, reason = "INVESTIGATION", "INVESTIGATION", "owner requested investigation"
            elif event == "checkpoint":
                cp = payload.get("note")
                if not isinstance(cp, str) or not cp.strip(): raise WardenError("checkpoint note required")
                self.con.execute("UPDATE task SET checkpoint=? WHERE id=?", (cp, tid))
            elif event == "completion_request":
                if payload.get("dependency") is True:
                    state, decision, reason = "ACTIVE", "CONTINUE", "unverified dependency claim; owner review is required"
                else:
                    req = json.loads(task["requirements"])
                    gaps = []
                    for c in req["criteria"]:
                        if not c["mandatory"]: continue
                        ev = self.con.execute("SELECT * FROM evidence WHERE task_id=? AND criterion=?", (tid, c["id"])).fetchone()
                        rv = self.con.execute("SELECT * FROM review WHERE task_id=? AND criterion=?", (tid, c["id"])).fetchone()
                        valid = ev and rv and ev["version"] == task["version"] and rv["version"] == task["version"] and rv["verdict"] == "ACCEPT" and ev["fingerprint"] == rv["fingerprint"]
                        if valid and rv["reviewer"].startswith("gemini:"):
                            valid = self._semantic_audit_current(tid, task["version"])
                        if valid:
                            try: _, fp = self._scoped_artifact(tid, ev["relpath"]); valid = fp == ev["fingerprint"]
                            except (OSError, WardenError): valid = False
                        if not valid: gaps.append(c["id"])
                    if not gaps:
                        state, decision, reason = "ACCEPTED", "ACCEPT", "all mandatory criteria have current reviewed evidence"
                    elif task["attempts"] >= task["budget"]:
                        state, decision, reason = "BLOCKED", "BLOCKED", "attempt budget exhausted"
                    else:
                        state = "ACTIVE" if task["state"] == "ACCEPTED" else task["state"]
                        attempts = task["attempts"] + 1
                        signature = hashlib.sha256(_json({"version": task["version"], "gaps": gaps, "checkpoint": task["checkpoint"], "evidence": [(r[0], r[1]) for r in self.con.execute("SELECT criterion,fingerprint FROM evidence WHERE task_id=? ORDER BY criterion", (tid,))], "scope_snapshot": self._scope_snapshot(req)}).encode()).hexdigest()
                        no_progress = payload.get("no_progress") is True or payload.get("stop_hook_active") is True
                        repeats = task["no_progress_count"] + 1 if no_progress and signature == task["no_progress_signature"] else (1 if no_progress else 0)
                        self.con.execute("UPDATE task SET attempts=?,no_progress_count=?,no_progress_signature=? WHERE id=?", (attempts, repeats, signature if no_progress else "", tid))
                        if repeats >= 2:
                            state, decision, reason = "BLOCKED", "BLOCKED", "two no-progress recovery attempts"
                        else: reason = "missing current reviewed evidence: " + ", ".join(gaps)
            self.con.execute("UPDATE task SET state=?,updated=CURRENT_TIMESTAMP WHERE id=?", (state, tid))
            self._event(tid, role, event, {"decision": decision, "reason": reason, **payload})
        return {"task": tid, "state": state, "decision": decision, "reason": reason, "version": task["version"], "attempts": self._task(tid)["attempts"]}

    def status(self, tid: str, token: str, role: str) -> dict[str, Any]:
        self._auth(tid, role, token)
        task = self._task(tid)
        evidence = [dict(r) for r in self.con.execute("SELECT criterion,version,relpath,fingerprint,note FROM evidence WHERE task_id=? ORDER BY criterion", (tid,))]
        return {"task": tid, "version": task["version"], "requirements": json.loads(task["requirements"]), "state": task["state"], "budget": task["budget"], "attempts": task["attempts"], "no_progress_count": task["no_progress_count"], "checkpoint": task["checkpoint"], "workspace": str(self.workspace), "evidence": evidence}

    @staticmethod
    def _reviewer_retry_digest(request: dict[str, Any]) -> str:
        material = {key: request.get(key) for key in ("schema", "request_id", "task_id", "thread_id", "workspace", "version", "created_at")}
        return hashlib.sha256(json.dumps(material, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    def authorize_reviewer_retry(self, request: dict[str, Any], owner_token: str) -> int:
        """Record a durable owner-capability receipt for a scoped Desktop retry request."""
        required = {"schema", "request_id", "task_id", "thread_id", "workspace", "version", "created_at"}
        if not isinstance(request, dict) or set(request) != required or request.get("schema") != 1:
            raise WardenError("invalid reviewer retry request")
        if (not isinstance(request.get("request_id"), str) or len(request["request_id"]) != 32
                or not isinstance(request.get("thread_id"), str) or not request["thread_id"]
                or type(request.get("version")) is not int or not isinstance(request.get("created_at"), str)):
            raise WardenError("invalid reviewer retry request fields")
        with self._write():
            self._auth(request["task_id"], "owner", owner_token)
            task = self._task(request["task_id"])
            if task["version"] != request["version"]:
                raise WardenError("version conflict; reload before requesting reviewer retry")
            if request["workspace"] != str(self.workspace) or task["workspace"] != str(self.workspace):
                raise WardenError("reviewer retry workspace binding mismatch")
            detail = {**request, "request_digest": self._reviewer_retry_digest(request)}
            self._event(request["task_id"], "owner", "reviewer_retry_authorized", detail)
            return int(self.con.execute("SELECT last_insert_rowid()").fetchone()[0])

    def validate_reviewer_retry_receipt(self, request: dict[str, Any], executor_token: str) -> bool:
        """Validate an inbox request against its append-only owner-authenticated event."""
        if not isinstance(request, dict) or type(request.get("auth_event_id")) is not int:
            return False
        try:
            self._auth(request.get("task_id"), "executor", executor_token)
            event = self.con.execute("SELECT actor,kind,detail FROM event WHERE id=? AND task_id=?",
                                     (request["auth_event_id"], request["task_id"])).fetchone()
            if event is None or event["actor"] != "owner" or event["kind"] != "reviewer_retry_authorized":
                return False
            detail = json.loads(event["detail"])
            expected_keys = {"schema", "request_id", "task_id", "thread_id", "workspace", "version", "created_at"}
            expected = {key: request.get(key) for key in expected_keys}
            return (set(request) == expected_keys | {"auth_event_id"} and detail.get("request_digest") == self._reviewer_retry_digest(expected)
                    and all(detail.get(key) == expected[key] for key in expected_keys))
        except (WardenError, sqlite3.Error, TypeError, ValueError):
            return False

    def history(self, tid: str, token: str) -> list[dict[str, Any]]:
        self._auth(tid, "owner", token)
        self._task(tid)
        return [{"version": r["version"], "requirements": json.loads(r["requirements"]), "created": r["created"]}
                for r in self.con.execute("SELECT version,requirements,created FROM task_revision WHERE task_id=? ORDER BY version", (tid,))]
