import sys
from pathlib import Path

# cli.py / sim/ live one directory up from exp-ui/ -- must be on sys.path
# before any exp-ui module (network_view, sim.state) imports from them.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import App, AppConfig
from network_view import NetworkBackground
from panels.commodity_history_panel import CommodityHistoryPanel
from panels.controls_panel import ControlsPanel
from panels.events_panel import EventsPanel
from panels.faction_net_worth_panel import FactionNetWorthPanel
from panels.fleet_panel import FleetPanel
from panels.locations_panel import LocationsPanel
from panels.stockpile_history_panel import StockpileHistoryPanel
from sim.state import SimState


def main() -> None:
    state = SimState()

    app = App(AppConfig(window_title="Commodity Sim Viewer", enable_implot=True))
    app.add_update(state.tick)
    app.add_background(NetworkBackground(state).render)
    app.add_panel(ControlsPanel(state))
    app.add_panel(LocationsPanel(state))
    app.add_panel(FleetPanel(state))
    app.add_panel(EventsPanel(state))
    app.add_panel(CommodityHistoryPanel(state))
    app.add_panel(StockpileHistoryPanel(state))
    app.add_panel(FactionNetWorthPanel(state))
    app.run()


if __name__ == "__main__":
    main()
