"""Owns the live World instance the ImGui panels read from and drive."""
from __future__ import annotations

import contextlib
import io
from collections import deque
from typing import List

from .events import Event


class SimState:
    """Wraps a World + its Factions with play/pause/step controls.

    `step()` runs exactly one simulated day (reusing World.step(), which
    tracks its own internal day counter) and captures whatever it would
    normally print to stdout into a rolling log the UI can display,
    instead of re-implementing World's console formatting.
    """

    def __init__(self, max_log_lines: int = 2000):
        self.max_log_lines = max_log_lines
        self.log_lines: deque[str] = deque(maxlen=max_log_lines)
        self.playing = False
        self.days_per_second = 2.0
        self._accumulator = 0.0
        self.day = 0
        self.world = None
        self.factions = []
        # Every Event (MarketEvent/AgentEvent/LocationClosure) generated
        # over the World's lifetime, in the order rolled -- just a reference
        # to World.event_log, since World is what actually creates events
        # and is already the single place that appends to it; re-bound in
        # reset() whenever a new World replaces the old one.
        self.events: List[Event] = []
        self.reset()

    def reset(self) -> None:
        # Imported lazily (rather than at module load) since build_world
        # lives in the root-level cli.py, which sits ABOVE sim/ (it imports
        # from sim, not the other way around -- see CLAUDE.md's module
        # map). Deferring the import here keeps sim/ import-safe on its own
        # while still letting this UI-facing helper reuse cli.py's world
        # assembly instead of duplicating it.
        from cli import build_world
        self.world, self.factions = build_world(max_route_distance=1000)
        self.events = self.world.event_log
        self.day = 0
        self.playing = False
        self._accumulator = 0.0
        self.log_lines.clear()

    def step(self) -> None:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.day = self.world.step(verbose=True)
        for line in buffer.getvalue().splitlines():
            if line.strip():
                self.log_lines.append(line)

    def tick(self, delta_time: float) -> None:
        if not self.playing:
            return
        self._accumulator += delta_time * self.days_per_second
        while self._accumulator >= 1.0:
            self.step()
            self._accumulator -= 1.0
