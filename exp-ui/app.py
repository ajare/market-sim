"""Minimal ImGui application framework built on imgui_bundle's hello_imgui runner."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable

from imgui_bundle import hello_imgui, imgui, immapp


class Panel(ABC):
    """A single ImGui window that an App renders every frame while visible."""

    title: str = "Panel"
    visible: bool = True

    @abstractmethod
    def render(self) -> None:
        """Draw this panel's widgets. Called each frame while `visible` is True."""


@dataclass
class AppConfig:
    window_title: str = "ImGui App"
    window_size: tuple[int, int] = (1280, 800)
    fps_idle: int = 10  # throttle rendering when idle to save CPU
    enable_implot: bool = False  # set True if any panel plots with implot


class App:
    """Owns the panel registry and drives the ImGui frame loop."""

    def __init__(self, config: AppConfig | None = None):
        self.config = config or AppConfig()
        self.panels: list[Panel] = []
        self.update_callbacks: list[Callable[[float], None]] = []
        self.background_renderers: list[Callable[[], None]] = []

    def add_panel(self, panel: Panel) -> Panel:
        self.panels.append(panel)
        return panel

    def add_update(self, callback: Callable[[float], None]) -> None:
        """Register a callback(delta_time) run once per frame before panels render,
        for state that must advance even while its panel isn't visible (e.g. a
        play/pause auto-stepping simulation)."""
        self.update_callbacks.append(callback)

    def add_background(self, callback: Callable[[], None]) -> None:
        """Register a callback drawn once per frame onto the viewport's background
        draw list -- behind every Panel window, useful for a full-window backdrop
        like a map or network diagram that ordinary floating panels sit on top of."""
        self.background_renderers.append(callback)

    def _gui(self) -> None:
        delta_time = imgui.get_io().delta_time
        for callback in self.update_callbacks:
            callback(delta_time)

        for callback in self.background_renderers:
            callback()

        for panel in self.panels:
            if not panel.visible:
                continue
            expanded, panel.visible = imgui.begin(panel.title, panel.visible)
            if expanded:
                panel.render()
            imgui.end()

    def run(self) -> None:
        params = hello_imgui.RunnerParams()
        params.app_window_params.window_title = self.config.window_title
        params.app_window_params.window_geometry.size = self.config.window_size
        params.callbacks.show_gui = self._gui
        params.fps_idling.fps_idle = self.config.fps_idle
        immapp.run(params, immapp.AddOnsParams(with_implot=self.config.enable_implot))
