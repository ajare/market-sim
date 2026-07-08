from imgui_bundle import imgui

from app import Panel
from sim_state import SimState


class LocationsPanel(Panel):
    title = "Locations"

    def __init__(self, state: SimState):
        self.state = state

    def render(self) -> None:
        world = self.state.world
        flags = imgui.TableFlags_.borders | imgui.TableFlags_.row_bg | imgui.TableFlags_.resizable
        if not imgui.begin_table("locations_table", 4, flags):
            return
        imgui.table_setup_column("Location")
        imgui.table_setup_column("Status")
        imgui.table_setup_column("Buy")
        imgui.table_setup_column("Sell")
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
            buy_str = ", ".join(
                f"{c} {world.buy_markets[(location.name, c)].price:.2f}"
                for c in location.buyable_commodities
            )
            imgui.text_wrapped(buy_str or "-")

            imgui.table_next_column()
            sell_str = ", ".join(
                f"{c} {world.sell_markets[(location.name, c)].price:.2f}"
                for c in location.sellable_commodities
            )
            imgui.text_wrapped(sell_str or "-")

        imgui.end_table()
