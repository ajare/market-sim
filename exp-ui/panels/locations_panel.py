from imgui_bundle import imgui

from app import Panel
from sim.state import SimState


class LocationsPanel(Panel):
    title = "Locations"

    def __init__(self, state: SimState):
        self.state = state

    def _commodity_table(self, table_id: str, location, rates, market_dict,
                          show_min: bool, price_label: str) -> None:
        """A small commodity/stock/min/rate/price table nested inside a
        Produces or Consumes cell -- `table_id` must be unique across the
        whole panel (imgui tables are identified by this string), `rates`
        is `location.produced_commodities` or `location.consumed_commodities`
        (commodity -> units/day, see Location.daily_update), `show_min` is
        False for the Produces side since min_stockpiles only applies to
        something consumed here. `price_label` is "Sell Price" for Produces
        (a Captain buys a produced commodity, so it's what the location
        SELLS it for) or "Buy Price" for Consumes (a Captain sells there,
        so it's what the location BUYS it for)."""
        if not rates:
            imgui.text("-")
            return
        flags = imgui.TableFlags_.borders | imgui.TableFlags_.row_bg
        if not imgui.begin_table(table_id, 5, flags):
            return
        imgui.table_setup_column("Commodity")
        imgui.table_setup_column("Stock")
        imgui.table_setup_column("Min")
        imgui.table_setup_column("Daily rate")
        imgui.table_setup_column(price_label)
        imgui.table_headers_row()
        for c, rate in rates.items():
            imgui.table_next_row()
            imgui.table_next_column()
            imgui.text(c)
            imgui.table_next_column()
            imgui.text(f"{location.stockpiles.get(c, 0.0):.1f}")
            imgui.table_next_column()
            imgui.text(f"{location.min_stockpiles.get(c, 0.0):.1f}" if show_min else "-")
            imgui.table_next_column()
            imgui.text(f"{rate:.1f}")
            imgui.table_next_column()
            imgui.text(f"{market_dict[(location.name, c)].price:.2f}")
        imgui.end_table()

    def render(self) -> None:
        world = self.state.world
        flags = imgui.TableFlags_.borders | imgui.TableFlags_.row_bg | imgui.TableFlags_.resizable
        if not imgui.begin_table("locations_table", 4, flags):
            return
        imgui.table_setup_column("Location")
        imgui.table_setup_column("Status")
        imgui.table_setup_column("Produces")
        imgui.table_setup_column("Consumes")
        imgui.table_headers_row()

        for location in world.locations:
            imgui.table_next_row()
            imgui.table_next_column()
            imgui.text(location.name)

            imgui.table_next_column()
            is_open = world.is_location_open(location.name)
            if is_open:
                imgui.text_colored(imgui.ImVec4(0.4, 0.9, 0.4, 1.0), "OPEN")
            else:
                closure = world.closed_locations[location.name]
                imgui.text_colored(imgui.ImVec4(0.9, 0.4, 0.4, 1.0), f"CLOSED ({closure.name})")

            imgui.table_next_column()
            self._commodity_table(f"produces_table_{location.name}", location,
                                   location.produced_commodities, world.buy_markets,
                                   show_min=False, price_label="Sell Price")

            imgui.table_next_column()
            self._commodity_table(f"consumes_table_{location.name}", location,
                                   location.consumed_commodities, world.sell_markets,
                                   show_min=True, price_label="Buy Price")

        imgui.end_table()
