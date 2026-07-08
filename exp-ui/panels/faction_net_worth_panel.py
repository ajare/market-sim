import numpy as np
from imgui_bundle import imgui, implot

from app import Panel
from sim.faction import Company, PirateBrigade, PoliceFleet, SoloTrader
from sim.state import SimState

# Checked in this order since SoloTrader subclasses Company (see faction.py)
# -- a plain isinstance(x, Company) check alone would misclassify every
# SoloTrader as a Company. Matches network_view.py's per-Transport faction
# colors, kept as its own constant here since the two panels have no other
# dependency on each other.
_FACTION_TYPE_COLORS = [
    (PirateBrigade, imgui.ImVec4(1.00, 0.20, 0.20, 1.00)),  # red
    (SoloTrader, imgui.ImVec4(0.65, 0.25, 1.00, 1.00)),     # purple
    (Company, imgui.ImVec4(0.20, 0.55, 1.00, 1.00)),        # blue
]
_DEFAULT_FACTION_COLOR = imgui.ImVec4(0.85, 0.85, 0.85, 1.00)

# Checked in the same order as _FACTION_TYPE_COLORS (see above) for the same
# reason -- PoliceFleet isn't included here at all, since it's excluded
# from this chart entirely (see render()), never offered as a filter choice.
_FACTION_TYPE_NAMES = [
    (PirateBrigade, "PirateBrigade"),
    (SoloTrader, "SoloTrader"),
    (Company, "Company"),
]


def _faction_color(faction) -> imgui.ImVec4:
    for faction_cls, color in _FACTION_TYPE_COLORS:
        if isinstance(faction, faction_cls):
            return color
    return _DEFAULT_FACTION_COLOR


def _faction_type_name(faction) -> str:
    for faction_cls, name in _FACTION_TYPE_NAMES:
        if isinstance(faction, faction_cls):
            return name
    return type(faction).__name__


class FactionNetWorthPanel(Panel):
    title = "Faction Net Worth"

    def __init__(self, state: SimState):
        self.state = state
        self.num_days = 30
        self.selected_types: set[str] = {name for _, name in _FACTION_TYPE_NAMES}

    def _render_type_filter(self) -> None:
        all_types = [name for _, name in _FACTION_TYPE_NAMES]
        all_selected = len(self.selected_types) == len(all_types)
        label = "Faction Types (All)" if all_selected else f"Faction Types ({len(self.selected_types)})"
        if imgui.button(label):
            imgui.open_popup("faction_type_filter_popup")

        if imgui.begin_popup("faction_type_filter_popup"):
            if imgui.small_button("All"):
                self.selected_types = set(all_types)
            imgui.same_line()
            if imgui.small_button("None"):
                self.selected_types = set()
            imgui.separator()
            for type_name in all_types:
                checked = type_name in self.selected_types
                changed, checked = imgui.checkbox(type_name, checked)
                if changed:
                    if checked:
                        self.selected_types.add(type_name)
                    else:
                        self.selected_types.discard(type_name)
            imgui.end_popup()

    def render(self) -> None:
        world = self.state.world
        self._render_type_filter()
        _, self.num_days = imgui.slider_int("Days", self.num_days, 5, 200)

        reports = world.build_company_daily_reports()
        if implot.begin_plot("Faction Net Worth"):
            # auto_fit on both axes: without it, ImPlot only fits the axis
            # range ONCE per plot ID, the very first time it's shown -- see
            # commodity_history_panel.py for the full reasoning.
            implot.setup_axes("Day", "Net Worth", implot.AxisFlags_.auto_fit, implot.AxisFlags_.auto_fit)
            for faction in world.factions:
                # PoliceFleet's pool is a literal float("inf") (government-
                # funded, see PoliceFleet.__init__) -- plotting it would
                # blow out the Y-axis auto-fit range for every other,
                # finite-valued Faction.
                if isinstance(faction, PoliceFleet):
                    continue
                if _faction_type_name(faction) not in self.selected_types:
                    continue
                rows = reports.get(faction.name)
                if not rows:
                    continue
                recent = rows[-self.num_days:]
                days = np.array([r["day"] for r in recent], dtype=np.float64)
                net_worth = np.array([r["net_worth"] for r in recent], dtype=np.float64)
                implot.plot_line(faction.name, days, net_worth,
                                  implot.Spec(line_color=_faction_color(faction)))
            implot.end_plot()
