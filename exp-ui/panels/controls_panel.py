from imgui_bundle import imgui

from app import Panel
from sim_state import SimState


class ControlsPanel(Panel):
    title = "Controls"

    def __init__(self, state: SimState):
        self.state = state

    def render(self) -> None:
        imgui.text(f"Day: {self.state.day}")

        if imgui.button("Step"):
            self.state.step()
        imgui.same_line()
        if imgui.button("Pause" if self.state.playing else "Play"):
            self.state.playing = not self.state.playing
        imgui.same_line()
        if imgui.button("Reset"):
            self.state.reset()

        _, self.state.days_per_second = imgui.slider_float(
            "Days/sec", self.state.days_per_second, 0.5, 30.0, "%.1f"
        )

        imgui.separator()
        imgui.text(f"Factions: {len(self.state.factions)}")
        imgui.text(f"Traders: {len(self.state.world.captains)}")
        imgui.text(f"Locations: {len(self.state.world.locations)}")
