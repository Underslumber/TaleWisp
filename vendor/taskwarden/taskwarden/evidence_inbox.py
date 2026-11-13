"""Narrow, bounded bridge from an executor inbox to Controller.evidence_add.

The broker accepts data records only. It has no command, role, review, or
completion interface, and acknowledgements never claim task acceptance.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from .core import Controller, WardenError


MAX_REQUEST_BYTES = 16 * 1024
MAX_BATCH = 10
MAX_SCAN_PER_TICK = 1000
MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
STOP_STATES = {"CANCELLED", "ACCEPTED"}
REQUEST_FIELDS = {"task_id", "version", "criterion", "relpath", "note"}
_TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class InboxError(ValueError):
    """A fail-closed inbox configuration or journal error."""


def _no_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise InboxError("duplicate JSON key")
        result[key] = value
    return result


def _parse_json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise InboxError("invalid JSON") from exc


def _is_reparse(st: os.stat_result) -> bool:
    attrs = getattr(st, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attrs & reparse)


def _check_components(path: Path, *, must_exist: bool) -> Path:
    """Resolve an absolute path while refusing symlink/junction components."""
    if not path.is_absolute() or ".." in path.parts:
        raise InboxError("path must be absolute and normalized")
    current = Path(path.anchor)
    parts = path.parts[1:]
    for index, part in enumerate(parts):
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if must_exist or index < len(parts) - 1:
                raise InboxError("configured path does not exist")
            continue
        except OSError as exc:
            raise InboxError("configured path cannot be inspected") from exc
        if stat.S_ISLNK(info.st_mode) or _is_reparse(info):
            raise InboxError("configured path contains a link or reparse point")
    try:
        return path.resolve(strict=must_exist)
    except (OSError, RuntimeError) as exc:
        raise InboxError("configured path cannot be resolved") from exc


def _regular_file_bytes(path: Path, limit: int) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise InboxError("file cannot be opened safely") from exc
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or _is_reparse(before) or before.st_size > limit:
            raise InboxError("file is not a bounded regular file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            raw = stream.read(limit + 1)
        after_path = path.lstat()
        if (stat.S_ISLNK(after_path.st_mode) or _is_reparse(after_path)
                or (before.st_ino and after_path.st_ino != before.st_ino)
                or (before.st_dev and after_path.st_dev != before.st_dev)):
            raise InboxError("file changed while being inspected")
        if len(raw) > limit:
            raise InboxError("file exceeds its size limit")
        return raw
    finally:
        os.close(fd)


def _source_signature(path: Path) -> str:
    try:
        info = path.lstat()
    except OSError:
        return "missing"
    marker = (info.st_mode, info.st_size, info.st_mtime_ns, info.st_dev, info.st_ino,
              getattr(info, "st_file_attributes", 0))
    return hashlib.sha256(repr(marker).encode("ascii")).hexdigest()


def _atomic_write(path: Path, content: bytes) -> None:
    """Write a small file durably with replace semantics in its own directory."""
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or _is_reparse(info) or not stat.S_ISREG(info.st_mode):
            raise InboxError("output target is not a regular file")
    fd, temp_name = tempfile.mkstemp(prefix="." + path.name + ".", suffix=".tmp", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        except OSError:
            directory_fd = None
        if directory_fd is not None:
            try:
                os.fsync(directory_fd)
            except OSError:
                pass
            finally:
                os.close(directory_fd)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass


def _inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class EvidenceInboxBroker:
    """One lifetime-locked broker bound to a single task and executor token."""

    def __init__(self, controller: Controller, *, task_id: str, executor_token: str,
                 inbox: str | Path, journal: str | Path,
                 protected_state_root: str | Path, poll_seconds: float = 1.0):
        if not isinstance(task_id, str) or not _TASK_ID.fullmatch(task_id):
            raise InboxError("invalid task binding")
        if not isinstance(executor_token, str) or not executor_token or len(executor_token) > 4096:
            raise InboxError("invalid executor capability")
        if isinstance(poll_seconds, bool) or not isinstance(poll_seconds, (int, float)) or not 0.1 <= poll_seconds <= 3600:
            raise InboxError("poll interval outside allowed bounds")

        self.controller = controller
        self.task_id = task_id
        self._executor_token = executor_token
        self.poll_seconds = float(poll_seconds)
        self.workspace = _check_components(controller.workspace, must_exist=True)
        if not self.workspace.is_dir():
            raise InboxError("workspace is not a directory")
        self.protected_root = _check_components(Path(protected_state_root), must_exist=True)
        if not self.protected_root.is_dir():
            raise InboxError("protected state root is not a directory")

        if isinstance(inbox, str):
            inbox_rel = Path(inbox)
        else:
            inbox_rel = inbox
        if (inbox_rel.is_absolute() or ".." in inbox_rel.parts or not inbox_rel.parts
                or any(part in {"", "."} for part in inbox_rel.parts)):
            raise InboxError("inbox must be a normalized workspace-relative path")
        inbox_candidate = self.workspace / inbox_rel
        self.inbox = _check_components(inbox_candidate, must_exist=True)
        if not self.inbox.is_dir() or _inside(self.inbox, self.protected_root):
            raise InboxError("inbox must be a directory outside protected state")

        journal_path = Path(journal)
        if not journal_path.is_absolute():
            raise InboxError("journal must be an absolute operator path")
        self.journal = _check_components(journal_path, must_exist=False)
        if not _inside(self.journal, self.protected_root) or not self.journal.parent.is_dir():
            raise InboxError("journal must be under the existing protected state root")
        self.lock_path = self.journal.with_name(self.journal.name + ".lock")
        self._lock_fd: int | None = None
        self._journal_db: sqlite3.Connection | None = None
        self._stopped = False
        self._ack_backoff_until = 0.0
        self._store_backoff_until = 0.0
        self._scan_after = ""
        self._acquire_lock()
        try:
            self._open_store()
        except BaseException:
            self.close()
            raise

    def _open_store(self) -> None:
        protected_now = _check_components(self.protected_root, must_exist=True)
        journal_now = _check_components(self.journal, must_exist=self.journal.exists())
        if (protected_now != self.protected_root or journal_now != self.journal
                or not _inside(journal_now, protected_now)):
            raise InboxError("protected journal path changed")
        connection = sqlite3.connect(self.journal, timeout=0.25)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=250")
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=FULL")
            connection.execute("""
                CREATE TABLE IF NOT EXISTS inbox_request(
                    request_id TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL,
                    source_signature TEXT NOT NULL,
                    state TEXT NOT NULL CHECK(state IN ('processing','done','rejected','changed')),
                    code TEXT NOT NULL,
                    version INTEGER,
                    updated_ns INTEGER NOT NULL
                )
            """)
            connection.commit()
        except BaseException:
            connection.close()
            raise
        self._journal_db = connection

    def _store(self) -> sqlite3.Connection:
        if self._journal_db is None:
            raise InboxError("journal store is closed")
        return self._journal_db

    def _store_get(self, request_id: str) -> dict[str, Any] | None:
        row = self._store().execute(
            "SELECT request_id,sha256,source_signature,state,code,version FROM inbox_request WHERE request_id=?",
            (request_id,)).fetchone()
        return dict(row) if row is not None else None

    def _store_put(self, request_id: str, *, digest: str, source_signature: str,
                   state: str, code: str, version: int | None) -> None:
        connection = self._store()
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute("""
                INSERT INTO inbox_request(request_id,sha256,source_signature,state,code,version,updated_ns)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(request_id) DO UPDATE SET sha256=excluded.sha256,
                    source_signature=excluded.source_signature,state=excluded.state,
                    code=excluded.code,version=excluded.version,updated_ns=excluded.updated_ns
            """, (request_id, digest, source_signature, state, code, version, time.time_ns()))
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()

    def _store_signature(self, request_id: str, signature: str) -> None:
        connection = self._store()
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute("UPDATE inbox_request SET source_signature=?,updated_ns=? WHERE request_id=?",
                               (signature, time.time_ns(), request_id))
        except BaseException:
            connection.rollback()
            raise
        else:
            connection.commit()

    def _acquire_lock(self) -> None:
        lock_now = _check_components(self.lock_path, must_exist=self.lock_path.exists())
        if lock_now != self.lock_path:
            raise InboxError("lifetime lock path changed")
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(self.lock_path, flags, 0o600)
        except OSError as exc:
            raise InboxError("broker lifetime lock cannot be acquired") from exc
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or _is_reparse(info):
                raise InboxError("lifetime lock is not a regular file")
            if info.st_size == 0:
                os.write(fd, b"\x00")
                os.fsync(fd)
            os.lseek(fd, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            raise InboxError("another evidence inbox broker holds the lifetime lock") from exc
        except BaseException:
            os.close(fd)
            raise
        self._lock_fd = fd

    def close(self) -> None:
        connection, self._journal_db = self._journal_db, None
        fd, self._lock_fd = self._lock_fd, None
        try:
            if connection is not None:
                connection.close()
        finally:
            if fd is not None:
                try:
                    if os.name == "nt":
                        import msvcrt
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_UN)
                finally:
                    os.close(fd)

    def _result(self, request_id: str, *, recorded: bool, code: str, version: int | None) -> None:
        inbox_now = _check_components(self.inbox, must_exist=True)
        if inbox_now != self.inbox or _inside(inbox_now, self.protected_root):
            raise InboxError("inbox path changed")
        if recorded:
            result = {"request_id": request_id, "status": "evidence_recorded",
                      "task_id": self.task_id, "version": version}
        else:
            result = {"request_id": request_id, "status": "rejected", "code": code}
        target = self.inbox / (request_id + ".result.json")
        _atomic_write(target, (json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8"))

    def _try_result(self, request_id: str, row: dict[str, Any]) -> bool:
        try:
            self._result(request_id, recorded=row["state"] == "done",
                         code=row["code"], version=row["version"])
        except (InboxError, OSError):
            self._ack_backoff_until = time.monotonic() + max(1.0, self.poll_seconds * 5)
            return False
        return True

    def _reject(self, request_id: str, digest: str, code: str, version: int | None,
                source_signature: str) -> None:
        self._store_put(request_id, digest=digest, source_signature=source_signature,
                        state="rejected", code=code, version=version)
        row = self._store_get(request_id)
        assert row is not None
        self._try_result(request_id, row)

    def _safe_artifact(self, relpath: str) -> Path:
        if (not isinstance(relpath, str) or not relpath or len(relpath) > 1024
                or "\x00" in relpath):
            raise InboxError("invalid artifact path")
        rel = Path(relpath)
        if rel.is_absolute() or ".." in rel.parts or any(part in {"", "."} for part in rel.parts):
            raise InboxError("invalid artifact path")
        candidate = self.workspace / rel
        resolved = _check_components(candidate, must_exist=True)
        if _inside(resolved, self.protected_root):
            raise InboxError("artifact resolves into protected state")
        try:
            info = resolved.stat()
        except OSError as exc:
            raise InboxError("artifact cannot be inspected") from exc
        if not stat.S_ISREG(info.st_mode) or _is_reparse(info):
            raise InboxError("artifact is not a regular file")
        return resolved

    def _decode_request(self, request_id: str, raw: bytes) -> dict[str, Any]:
        try:
            canonical = str(uuid.UUID(request_id)) == request_id
        except ValueError:
            canonical = False
        if not canonical:
            raise InboxError("invalid request filename")
        request = _parse_json(raw)
        if not isinstance(request, dict) or set(request) != REQUEST_FIELDS:
            raise InboxError("invalid request fields")
        if request["task_id"] != self.task_id:
            raise InboxError("task binding mismatch")
        if type(request["version"]) is not int or request["version"] < 1:
            raise InboxError("invalid task version")
        if (not isinstance(request["criterion"], str) or not request["criterion"]
                or len(request["criterion"]) > 128):
            raise InboxError("invalid criterion")
        if not isinstance(request["note"], str) or len(request["note"]) > 4000:
            raise InboxError("invalid note")
        self._safe_artifact(request["relpath"])
        return request

    def _process_one(self, path: Path, status: dict[str, Any]) -> None:
        request_id = path.stem
        try:
            raw = _regular_file_bytes(path, MAX_REQUEST_BYTES - 1)
        except InboxError:
            digest = hashlib.sha256(b"unsafe-input").hexdigest()
            source_signature = _source_signature(path)
            prior = self._store_get(request_id)
            if prior is None:
                self._reject(request_id, digest, "unsafe_input", None, source_signature)
            elif prior["sha256"] == digest and prior["state"] == "rejected" and prior["code"] == "unsafe_input":
                self._store_signature(request_id, source_signature)
                current = self._store_get(request_id)
                assert current is not None
                self._try_result(request_id, current)
            else:
                self._store_put(request_id, digest=prior["sha256"], source_signature=source_signature,
                                state="changed", code="request_changed", version=prior["version"])
                current = self._store_get(request_id)
                assert current is not None
                self._try_result(request_id, current)
            return

        digest = hashlib.sha256(raw).hexdigest()
        source_signature = _source_signature(path)
        prior = self._store_get(request_id)
        if prior is not None:
            if prior["sha256"] != digest:
                self._store_put(request_id, digest=prior["sha256"], source_signature=source_signature,
                                state="changed", code="request_changed", version=prior["version"])
                current = self._store_get(request_id)
                assert current is not None
                self._try_result(request_id, current)
                return
            if prior["state"] in {"done", "rejected", "changed"}:
                if prior["source_signature"] != source_signature:
                    self._store_signature(request_id, source_signature)
                    prior = self._store_get(request_id) or prior
                self._try_result(request_id, prior)
                return

        try:
            request = self._decode_request(request_id, raw)
        except InboxError as exc:
            code = "invalid_request"
            if "task binding" in str(exc):
                code = "task_mismatch"
            self._reject(request_id, digest, code, None, source_signature)
            return

        if request["version"] != status["version"]:
            self._reject(request_id, digest, "version_mismatch", status["version"], source_signature)
            return
        if status["state"] != "ACTIVE":
            return

        if prior is None:
            # This durable commit must succeed before touching controller state.
            self._store_put(request_id, digest=digest, source_signature=source_signature,
                            state="processing", code="", version=request["version"])
        elif prior["state"] != "processing":
            return

        # Only a journaled in-flight request can be recovered without replaying
        # the controller operation. A new UUID must always go through evidence_add,
        # which refreshes fingerprints and invalidates any now-stale review.
        current = next((item for item in status.get("evidence", [])
                        if item.get("criterion") == request["criterion"]
                        and item.get("version") == request["version"]), None)
        current_artifact_fingerprint = None
        if prior is not None and prior["state"] == "processing":
            try:
                _, current_artifact_fingerprint = self.controller._scoped_artifact(
                    self.task_id, request["relpath"], max_artifact_bytes=MAX_ARTIFACT_BYTES)
            except (WardenError, OSError):
                current_artifact_fingerprint = None
        already_recorded = bool(
            prior is not None and prior["state"] == "processing" and current
            and current.get("relpath") == request["relpath"]
            and current.get("note") == request["note"]
            and current.get("fingerprint") == current_artifact_fingerprint
        )
        if not already_recorded:
            try:
                self._safe_artifact(request["relpath"])
                self.controller.evidence_add(self.task_id, self._executor_token, request["version"],
                                             request["criterion"], request["relpath"], request["note"],
                                             max_artifact_bytes=MAX_ARTIFACT_BYTES)
            except (WardenError, InboxError, OSError):
                self._store_put(request_id, digest=digest, source_signature=source_signature,
                                state="rejected", code="evidence_rejected", version=request["version"])
                current_row = self._store_get(request_id)
                assert current_row is not None
                self._try_result(request_id, current_row)
                return

        self._store_put(request_id, digest=digest, source_signature=source_signature,
                        state="done", code="", version=request["version"])
        current_row = self._store_get(request_id)
        assert current_row is not None
        self._try_result(request_id, current_row)

    def tick(self) -> bool:
        """Process at most ten requests; owner pauses remain live and idle."""
        if self._stopped:
            return False
        now = time.monotonic()
        if now < self._store_backoff_until:
            return True
        try:
            inbox_now = _check_components(self.inbox, must_exist=True)
            protected_now = _check_components(self.protected_root, must_exist=True)
            if (inbox_now != self.inbox or protected_now != self.protected_root
                    or _inside(inbox_now, protected_now)):
                raise InboxError("inbox or protected root changed")
            status = self.controller.status(self.task_id, self._executor_token, "executor")
        except (InboxError, WardenError, OSError, sqlite3.Error):
            self._store_backoff_until = now + max(1.0, self.poll_seconds * 5)
            return True
        if status["state"] in STOP_STATES:
            self._stopped = True
            return False
        if status["state"] != "ACTIVE":
            return True

        processed = 0
        scanned = 0
        cursor = self._scan_after
        cursor_found = not cursor
        saw_after_cursor = False
        try:
            with os.scandir(self.inbox) as entries:
                for entry in entries:
                    if not cursor_found:
                        if entry.name == cursor:
                            cursor_found = True
                        continue
                    if cursor:
                        saw_after_cursor = True
                    scanned += 1
                    self._scan_after = entry.name
                    if scanned > MAX_SCAN_PER_TICK:
                        break
                    if not entry.name.endswith(".json") or entry.name.endswith(".result.json"):
                        continue
                    try:
                        request_id = str(uuid.UUID(entry.name[:-5]))
                    except ValueError:
                        continue
                    if request_id + ".json" != entry.name:
                        continue

                    row = self._store_get(request_id)
                    source_signature = _source_signature(Path(entry.path))
                    if (row is not None and row["state"] in {"done", "rejected", "changed"}
                            and row["source_signature"] == source_signature):
                        if time.monotonic() < self._ack_backoff_until:
                            continue
                        if not self._try_result(request_id, row):
                            continue
                        processed += 1
                    else:
                        latest = self.controller.status(self.task_id, self._executor_token, "executor")
                        if latest["state"] in STOP_STATES:
                            self._stopped = True
                            return False
                        if latest["state"] != "ACTIVE":
                            return True
                        self._process_one(Path(entry.path), latest)
                        processed += 1
                    if processed >= MAX_BATCH:
                        break
            if not cursor_found or not saw_after_cursor and cursor:
                self._scan_after = ""
            elif scanned <= MAX_SCAN_PER_TICK and processed < MAX_BATCH:
                # Reached the directory end; wrap next tick so newly-created
                # names before the cursor are also considered.
                self._scan_after = ""
        except (InboxError, WardenError, OSError, sqlite3.Error):
            # Store and path failures are degraded-idle: no ACK implies no
            # acceptance, and processing is never attempted without its commit.
            self._scan_after = cursor
            self._store_backoff_until = time.monotonic() + max(1.0, self.poll_seconds * 5)
        return True

    def run(self) -> None:
        try:
            while self.tick():
                time.sleep(self.poll_seconds)
        finally:
            self.close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bounded TaskWarden evidence inbox broker")
    parser.add_argument("--db", required=True)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--executor-token-file", required=True)
    parser.add_argument("--inbox", required=True, help="workspace-relative inbox directory")
    parser.add_argument("--journal", required=True, help="absolute journal path under protected state")
    parser.add_argument("--protected-state-root", required=True)
    parser.add_argument("--poll-seconds", required=True, type=float)
    return parser


def _validated_cli_paths(args: argparse.Namespace) -> tuple[Path, Path, Path, Path, Path]:
    workspace = _check_components(Path(args.workspace), must_exist=True)
    protected = _check_components(Path(args.protected_state_root), must_exist=True)
    if not workspace.is_dir() or not protected.is_dir():
        raise InboxError("workspace and protected root must be directories")
    db = _check_components(Path(args.db), must_exist=True)
    token_file = _check_components(Path(args.executor_token_file), must_exist=True)
    journal = _check_components(Path(args.journal), must_exist=False)
    inbox_rel = Path(args.inbox)
    if (inbox_rel.is_absolute() or ".." in inbox_rel.parts or not inbox_rel.parts
            or any(part in {"", "."} for part in inbox_rel.parts)):
        raise InboxError("inbox must be a normalized workspace-relative path")
    inbox = _check_components(workspace / inbox_rel, must_exist=True)
    if not inbox.is_dir() or _inside(inbox, protected):
        raise InboxError("inbox must be outside protected state")
    if not db.is_file() or not token_file.is_file():
        raise InboxError("database and executor token must be regular files")
    if not _inside(db, protected) or not _inside(token_file, protected) or not _inside(journal, protected):
        raise InboxError("database, token, and journal must be under protected state")
    if not isinstance(args.task, str) or not _TASK_ID.fullmatch(args.task):
        raise InboxError("invalid task binding")
    if isinstance(args.poll_seconds, bool) or not 0.1 <= args.poll_seconds <= 3600:
        raise InboxError("poll interval outside allowed bounds")
    return db, workspace, token_file, journal, protected


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    controller: Controller | None = None
    broker: EvidenceInboxBroker | None = None
    try:
        db, workspace, token_file, journal, protected = _validated_cli_paths(args)
        token_bytes = _regular_file_bytes(token_file, 4096)
        executor_token = token_bytes.decode("utf-8").strip()
        if not executor_token:
            raise InboxError("empty executor capability")
        controller = Controller(db, workspace)
        if controller.workspace != workspace:
            raise InboxError("controller workspace mismatch")
        broker = EvidenceInboxBroker(controller, task_id=args.task, executor_token=executor_token,
                                     inbox=args.inbox, journal=journal,
                                     protected_state_root=protected, poll_seconds=args.poll_seconds)
        broker.run()
        return 0
    except (InboxError, WardenError, OSError, ValueError, sqlite3.Error):
        print("TaskWarden evidence inbox stopped: configuration or task check failed.", file=sys.stderr)
        return 2
    finally:
        if broker is not None:
            broker.close()
        if controller is not None:
            controller.close()


if __name__ == "__main__":
    raise SystemExit(main())
