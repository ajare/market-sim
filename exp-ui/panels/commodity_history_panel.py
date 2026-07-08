import numpy as np
from imgui_bundle import imgui, implot

from app import Panel
from sim_state import SimState

# Matches network_view.py's _EVENT_SCOPE_COLORS, kept as its own constant
# here rather than importing that (module-private) dict, since the two
# panels have no other dependency on each other. "Agent" isn't included --
# World.broad_event_log only ever covers Global/Location/Worldwide events
# (see its docstring), not per-Captain AgentEvents.
_EVENT_SCOPE_COLORS = {
    "Global": imgui.ImVec4(1.00, 0.85, 0.20, 1.00),     # yellow
    "Location": imgui.ImVec4(1.00, 0.55, 0.85, 1.00),   # pink
    "Worldwide": imgui.ImVec4(1.00, 0.35, 0.35, 1.00),  # red
}


class CommodityHistoryPanel(Panel):
    title = "Commodity History"

    def __init__(self, state: SimState):
        self.state = state
        self.location_index = 0
        self.commodity_index = 0
        self.num_days = 30

    def _commodities_at(self, location) -> list[str]:
        return sorted(set(location.buyable_commodities) | set(location.sellable_commodities))

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

        buy_market = world.buy_markets.get((location.name, commodity))
        sell_market = world.sell_markets.get((location.name, commodity))

        if implot.begin_plot(f"{commodity} @ {location.name}"):
            # auto_fit on both axes: without it, ImPlot only fits the axis
            # range ONCE per plot ID, the very first time it's shown -- and
            # that first render can easily have no history yet (e.g. day 0,
            # before any World.step()), leaving the range stuck at ImPlot's
            # uninitialized [0, 1] default forever after, even once real
            # data (a different day/price range) starts coming in.
            implot.setup_axes("Day", "Price", implot.AxisFlags_.auto_fit, implot.AxisFlags_.auto_fit)
            if buy_market is not None and buy_market.history:
                recent = buy_market.history[-self.num_days:]
                days = np.array([r["day"] for r in recent], dtype=np.float64)
                prices = np.array([r["price"] for r in recent], dtype=np.float64)
                implot.plot_line("Buy", days, prices)
            if sell_market is not None and sell_market.history:
                recent = sell_market.history[-self.num_days:]
                days = np.array([r["day"] for r in recent], dtype=np.float64)
                prices = np.array([r["price"] for r in recent], dtype=np.float64)
                implot.plot_line("Sell", days, prices)

            self._plot_event_markers(world, location, commodity, buy_market, sell_market)
            implot.end_plot()

    def _plot_event_markers(self, world, location, commodity, buy_market, sell_market) -> None:
        """One marker per day a Global/Location-wide/Worldwide event (see
        World.broad_event_log -- the full history, so FINISHED events show
        up here too, not just ones still ticking down) affecting the
        CURRENTLY SELECTED (location, commodity) was active, sat right on
        the Buy (or Sell, if no Buy history exists) price line for that
        day -- rather than a single reference line, so it's clear exactly
        which days were affected. A Global event is relevant if it's for
        this commodity (any location); a Location event if it's for this
        location (any commodity); a Worldwide event always applies. Colored
        by scope to match network_view.py's active-events list."""
        price_by_day = {}
        for market in (buy_market, sell_market):
            if market is None:
                continue
            for record in market.history:
                price_by_day.setdefault(record["day"], record["price"])

        for event in world.broad_event_log:
            scope = event["scope"]
            if scope == "Global" and event["subject"] != commodity:
                continue
            if scope == "Location" and event["subject"] != location.name:
                continue
            if scope not in _EVENT_SCOPE_COLORS:
                continue
            event_days = range(event["start_day"], event["start_day"] + event["duration_days"])
            marker_days = [day for day in event_days if day in price_by_day]
            if not marker_days:
                continue
            days = np.array(marker_days, dtype=np.float64)
            prices = np.array([price_by_day[day] for day in marker_days], dtype=np.float64)
            # Label includes the scope and start day since the same named
            # event can recur (and different scopes can share a name) over
            # a long run -- ImPlot uses the label as this plot item's
            # identity, so each occurrence needs a distinct label to show
            # up as its own legend entry.
            label = f"[{scope}] {event['name']} (Day {event['start_day']})"
            color = _EVENT_SCOPE_COLORS[scope]
            implot.plot_scatter(
                label, days, prices,
                implot.Spec(marker=implot.Marker_.circle, marker_size=6,
                            marker_fill_color=color, marker_line_color=color),
            )
