import numpy as np
from imgui_bundle import imgui, implot

from app import Panel
from sim.state import SimState


class StockpileHistoryPanel(Panel):
    """
    Plots a single (Location, Commodity)'s stockpile over time, alongside
    the reference level its price is measured against (see
    Location.reference_stockpile/Market._stockpile_price) -- min_stockpile
    for something consumed here, starting stockpile for something produced
    here. Mirrors CommodityHistoryPanel's location/commodity picker so the
    two panels feel like the same family, just plotting a different pair
    of fields (stockpile/reference_stockpile instead of price) off the
    same per-day Market.history records.
    """

    title = "Stockpile History"

    def __init__(self, state: SimState):
        self.state = state
        self.location_index = 0
        self.commodity_index = 0
        self.num_days = 30

    def _commodities_at(self, location) -> list[str]:
        return sorted(set(location.produced_commodities) | set(location.consumed_commodities))

    def render(self) -> None:
        world = self.state.world
        locations = world.locations
        if not locations:
            imgui.text("No locations")
            return

        location_names = [loc.name for loc in locations]
        self.location_index = min(self.location_index, len(location_names) - 1)
        changed, self.location_index = imgui.combo("Location", self.location_index, location_names)
        location = locations[self.location_index]

        commodities = self._commodities_at(location)
        if not commodities:
            imgui.text(f"{location.name} trades no commodities")
            return
        if changed:
            self.commodity_index = 0
        self.commodity_index = min(self.commodity_index, len(commodities) - 1)
        _, self.commodity_index = imgui.combo("Commodity", self.commodity_index, commodities)
        commodity = commodities[self.commodity_index]

        _, self.num_days = imgui.slider_int("Days", self.num_days, 5, 200)

        # A commodity is either produced (its Market lives in buy_markets)
        # or consumed (sell_markets) at any one location, never both -- see
        # Location.__post_init__ -- so exactly one of these holds history.
        market = world.buy_markets.get((location.name, commodity)) \
            or world.sell_markets.get((location.name, commodity))

        if implot.begin_plot(f"{commodity} @ {location.name} -- Stockpile"):
            # auto_fit on both axes: without it, ImPlot only fits the axis
            # range ONCE per plot ID, the very first time it's shown -- and
            # that first render can easily have no history yet (e.g. day 0,
            # before any World.step()), leaving the range stuck at ImPlot's
            # uninitialized [0, 1] default forever after, even once real
            # data (a different day/stockpile range) starts coming in.
            implot.setup_axes("Day", "Stockpile", implot.AxisFlags_.auto_fit, implot.AxisFlags_.auto_fit)
            if market is not None and market.history:
                recent = market.history[-self.num_days:]
                days = np.array([r["day"] for r in recent], dtype=np.float64)
                stockpile = np.array([r["stockpile"] for r in recent], dtype=np.float64)
                reference = np.array([r["reference_stockpile"] for r in recent], dtype=np.float64)
                implot.plot_line("Stockpile", days, stockpile)
                implot.plot_line("Reference", days, reference)
            implot.end_plot()
