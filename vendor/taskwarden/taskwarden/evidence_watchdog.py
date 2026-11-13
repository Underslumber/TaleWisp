"""Owner-side lifecycle watchdog for one evidence broker child.

The owner supplies the trusted child factory and authoritative task-state
reader. This module deliberately accepts no executor packet or command data.
"""

from __future__ import annotations

import subprocess
import time
from typing import Any, Callable, Optional


ACTIVE = "ACTIVE"
PAUSED = "PAUSED"
TERMINAL_STATES = frozenset({"CANCELLED", "ACCEPTED"})
IDLE_STATES = frozenset({PAUSED, "INVESTIGATION", "BLOCKED"})
KNOWN_STATES = frozenset({ACTIVE, *IDLE_STATES, *TERMINAL_STATES})


class EvidenceWatchdog:
    """Keep at most one owner-created child alive with bounded restart backoff.

    ``child_factory`` must close over a fixed, trusted argv and return a
    Popen-like object. ``owner_stop_requested`` is the only owner stop signal;
    task states are read through ``state_reader``. ``step`` performs one
    non-blocking supervision pass, making the lifecycle easy to test.
    """

    def __init__(
        self,
        *,
        state_reader: Callable[[], str],
        child_factory: Callable[[], Any],
        owner_stop_requested: Callable[[], bool],
        health: Callable[[str, str], None],
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        poll_interval: float = 0.5,
        stop_timeout: float = 3.0,
        stop_check_interval: float = 0.25,
    ) -> None:
        if poll_interval <= 0 or stop_timeout <= 0 or stop_check_interval <= 0:
            raise ValueError("poll and stop intervals must be positive")
        self._state_reader = state_reader
        self._child_factory = child_factory
        self._owner_stop_requested = owner_stop_requested
        self._health = health
        self._clock = clock
        self._sleep = sleep
        self._poll_interval = poll_interval
        self._stop_timeout = stop_timeout
        self._stop_check_interval = stop_check_interval

        self._child: Optional[Any] = None
        self._retry_at = 0.0
        self._failure_count = 0
        self._stopped = False
        self._terminal = False
        self._last_state: Optional[str] = None

    @property
    def child(self) -> Optional[Any]:
        """The single child created by this watchdog, exposed for diagnostics."""
        return self._child

    @property
    def stopped(self) -> bool:
        return self._stopped

    def step(self) -> None:
        """Run one supervision pass without sleeping."""
        if self._stopped:
            return
        if self._terminal:
            self._stop_child()
            self._stopped = self._child is None
            return

        stop_requested, stop_known = self._read_owner_stop()
        if stop_requested:
            self._report("stopping", "owner stop requested")
            self._stop_child()
            self._stopped = self._child is None
            return
        if not stop_known:
            # An unreadable owner stop signal must never authorize a launch.
            self._report("degraded", "owner stop signal unavailable; launches withheld")

        state = self._read_state()
        if state is None:
            # Keep an existing child under observation, but never launch a
            # replacement until an authoritative state becomes available.
            self._observe_child(allow_restart=False)
            return

        self._last_state = state
        if state in TERMINAL_STATES:
            self._terminal = True
            self._report("terminal", f"task state is {state}; child will not restart")
            self._stop_child()
            self._stopped = self._child is None
            return

        child_exit = self._observe_child(allow_restart=(state == ACTIVE))

        if state in IDLE_STATES:
            if self._child is not None:
                self._report("idle", f"child remains idle while task is {state}")
            else:
                self._report("idle", f"no child launched while task is {state}")
            return

        # Only ACTIVE may launch. Polling an owner-stop failure is allowed, but
        # creating another child is not.
        if not stop_known or self._child is not None:
            return
        now = self._clock()
        if now < self._retry_at:
            return
        if child_exit is not None:
            # Any exit while ACTIVE is incomplete, including exit code zero.
            return

        try:
            child = self._child_factory()
            if child is None or not all(
                callable(getattr(child, method, None))
                for method in ("poll", "terminate", "kill", "wait")
            ):
                raise TypeError("child_factory must return a Popen-like child handle")
            self._child = child
            self._retry_at = 0.0
            self._report("running", "evidence child started")
        except Exception as exc:  # launcher faults must not stop the owner
            self._schedule_restart(f"child startup failed: {type(exc).__name__}: {exc}")

    def run(self) -> None:
        """Run until the explicit owner stop signal is observed.

        Sleeps are split into short slices so the owner stop callback is read
        during backoff, not only after the full delay.
        """
        while not self._stopped:
            self.step()
            if self._stopped:
                break
            remaining = self._poll_interval
            if self._retry_at > self._clock():
                remaining = max(remaining, self._retry_at - self._clock())
            self._sleep_with_stop_checks(remaining)

    def _sleep_with_stop_checks(self, duration: float) -> None:
        deadline = self._clock() + max(0.0, duration)
        while not self._stopped:
            requested, known = self._read_owner_stop()
            if requested:
                self._report("stopping", "owner stop requested during backoff")
                self._stop_child()
                self._stopped = self._child is None
                if not self._stopped:
                    self._sleep(self._stop_check_interval)
                    continue
                return
            if not known:
                self._report("degraded", "owner stop signal unavailable during wait")
            remaining = deadline - self._clock()
            if remaining <= 0:
                return
            self._sleep(min(remaining, self._stop_check_interval))

    def _read_owner_stop(self) -> tuple[bool, bool]:
        try:
            return bool(self._owner_stop_requested()), True
        except Exception as exc:
            self._report("degraded", f"owner stop signal read failed: {type(exc).__name__}: {exc}")
            return False, False

    def _read_state(self) -> Optional[str]:
        try:
            raw = self._state_reader()
            state = str(raw).strip().upper()
        except Exception as exc:
            self._schedule_restart(f"task state read failed: {type(exc).__name__}: {exc}")
            return None
        if state not in KNOWN_STATES:
            self._schedule_restart(f"unknown task state {state!r}; child launch withheld")
            return None
        return state

    def _observe_child(self, *, allow_restart: bool) -> Optional[int]:
        child = self._child
        if child is None:
            return None
        try:
            code = child.poll()
        except Exception as exc:
            self._report("degraded", f"child poll failed: {type(exc).__name__}: {exc}")
            return None
        if code is None:
            return None
        self._child = None
        if allow_restart:
            self._schedule_restart(f"active child exited with code {code}")
        else:
            self._schedule_restart(f"child exited with code {code} while state disallowed restart")
        return int(code)

    def _schedule_restart(self, reason: str) -> None:
        delay = min(30.0, float(2 ** min(self._failure_count, 5)))
        self._failure_count += 1
        self._retry_at = self._clock() + delay
        self._report("degraded", f"{reason}; retry in {delay:g}s")

    def _stop_child(self) -> None:
        """Stop only the exact process object this instance created."""
        child = self._child
        if child is None:
            return
        try:
            code = child.poll()
            if code is not None:
                self._child = None
                return
        except Exception as exc:
            # The handle remains ours even if poll fails, so signal this exact
            # child and use bounded wait/kill; never look up another PID.
            self._report("degraded", f"owned child poll during stop failed: {type(exc).__name__}: {exc}")
        try:
            child.terminate()
        except Exception as exc:
            self._report("degraded", f"owned child terminate failed: {type(exc).__name__}: {exc}")
        try:
            child.wait(timeout=self._stop_timeout)
            self._child = None
            self._report("stopped", "owned child exited after graceful stop")
            return
        except subprocess.TimeoutExpired:
            self._report("degraded", "child did not stop in time; terminating its owned process")
        except Exception as exc:
            self._report("degraded", f"owned child wait failed: {type(exc).__name__}: {exc}")
            return
        try:
            child.kill()
            child.wait(timeout=self._stop_timeout)
            self._child = None
            self._report("stopped", "owned child killed after graceful stop timeout")
        except subprocess.TimeoutExpired:
            self._report("degraded", "owned child did not exit after kill")
        except Exception as exc:
            self._report("degraded", f"owned child kill/wait failed: {type(exc).__name__}: {exc}")

    def _report(self, status: str, detail: str) -> None:
        try:
            self._health(status, detail)
        except Exception:
            # Observability failures are not allowed to terminate supervision.
            pass

