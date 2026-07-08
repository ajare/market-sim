from imgui_bundle import imgui

from app import Panel
from sim_state import SimState


class FleetPanel(Panel):
    title = "Fleet"

    def __init__(self, state: SimState):
        self.state = state

    def render(self) -> None:
        world = self.state.world
        flags = imgui.TableFlags_.borders | imgui.TableFlags_.row_bg | imgui.TableFlags_.resizable
        if not imgui.begin_table("fleet_table", 7, flags):
            return
        imgui.table_setup_column("Ship")
        imgui.table_setup_column("Faction")
        imgui.table_setup_column("Location")
        imgui.table_setup_column("Destination")
        imgui.table_setup_column("Status")
        imgui.table_setup_column("Cash")
        imgui.table_setup_column("Net Worth")
        imgui.table_headers_row()

        for trader in world.captains:
            imgui.table_next_row()
            imgui.table_next_column()
            imgui.text(trader.name)
            imgui.table_next_column()
            imgui.text(trader.company.name if trader.company is not None else "-")
            imgui.table_next_column()
            imgui.text(trader.location)
            imgui.table_next_column()
            imgui.text(trader.destination if trader.destination is not None else "-")
            imgui.table_next_column()
            imgui.text(trader.status.name)
            imgui.table_next_column()
            imgui.text(f"{trader.cash:,.2f}")
            imgui.table_next_column()
            net_worth = trader.portfolio_history[-1]["total_value"] if trader.portfolio_history else trader.cash
            imgui.text(f"{net_worth:,.2f}")

        imgui.end_table()
