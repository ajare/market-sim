"""Draws the Location/Route network onto the app's background draw list, so it
reads as a backdrop the floating panels sit on top of rather than a panel of
its own."""
from __future__ import annotations

import sys
from pathlib import Path

# cli.py / sim/ live one directory up from exp-ui/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from imgui_bundle import imgui

from sim import routes as routes_mod
from sim.faction import Company, PirateBrigade, PoliceFleet, SoloTrader
from sim.pathfinding import path_node_sequence
from sim.routes import ROUTE_TERMINAL_COMPATIBILITY, RouteType
from sim.transport import TransportStatus
from sim.world_data import LOCATION_COORDINATES, travel_days_between
from sim.state import SimState

_ROUTE_COLORS = {
    RouteType.Sea: imgui.ImVec4(0.20, 0.55, 1.00, 1.00),
    RouteType.Railroad: imgui.ImVec4(1.00, 0.60, 0.00, 1.00),
    RouteType.Air: imgui.ImVec4(0.00, 1.00, 0.80, 1.00),
}
_OPEN_COLOR = imgui.ImVec4(0.25, 1.00, 0.35, 1.00)
_CLOSED_COLOR = imgui.ImVec4(1.00, 0.20, 0.20, 1.00)
_LABEL_COLOR = imgui.ImVec4(0.80, 0.80, 0.80, 0.70)
_MARGIN = 60.0
_NODE_RADIUS = 6.0
_HOVER_RADIUS = _NODE_RADIUS + 4.0
_TRANSPORT_RADIUS = 5.0
_TRANSPORT_HOVER_RADIUS = _TRANSPORT_RADIUS + 3.0
_DOCKED_RADIUS = 5.0
_DOCKED_HOVER_RADIUS = _DOCKED_RADIUS + 3.0
_DOCKED_SPACING = _DOCKED_RADIUS * 2 + 3.0
_DOCKED_ROW_GAP = _NODE_RADIUS + _DOCKED_RADIUS + 6.0

# Checked in this order since SoloTrader subclasses Company (see faction.py)
# -- a plain isinstance(x, Company) check alone would misclassify every
# SoloTrader as a Company.
_FACTION_COLORS = [
    (PoliceFleet, imgui.ImVec4(0.25, 1.00, 0.35, 1.00)),   # green
    (PirateBrigade, imgui.ImVec4(1.00, 0.20, 0.20, 1.00)), # red
    (SoloTrader, imgui.ImVec4(0.65, 0.25, 1.00, 1.00)),    # purple
    (Company, imgui.ImVec4(0.20, 0.55, 1.00, 1.00)),       # blue
]
_INDEPENDENT_TRANSPORT_COLOR = imgui.ImVec4(0.85, 0.85, 0.85, 1.00)  # no Faction at all

_EVENT_SCOPE_COLORS = {
    "Global": imgui.ImVec4(1.00, 0.85, 0.20, 1.00),     # yellow
    "Location": imgui.ImVec4(1.00, 0.55, 0.85, 1.00),   # pink
    "Worldwide": imgui.ImVec4(1.00, 0.35, 0.35, 1.00),  # red
    "Agent": imgui.ImVec4(0.55, 0.85, 1.00, 1.00),      # light blue
}
_EVENT_LIST_MARGIN = 12.0
_EVENT_LIST_LINE_HEIGHT = 16.0


def _faction_color_vec4(trader) -> imgui.ImVec4:
    if trader.company is not None:
        for faction_cls, color in _FACTION_COLORS:
            if isinstance(trader.company, faction_cls):
                return color
    return _INDEPENDENT_TRANSPORT_COLOR


def _transport_color(trader) -> int:
    return imgui.color_convert_float4_to_u32(_faction_color_vec4(trader))


def _is_hovered(mouse_pos: imgui.ImVec2, point: imgui.ImVec2, radius: float) -> bool:
    dx, dy = mouse_pos.x - point.x, mouse_pos.y - point.y
    return dx * dx + dy * dy <= radius * radius


def _leg_progress(trader) -> float:
    """How far into its current leg an InTransit trader is, from 0.0 (just
    departed -- still sitting right on top of `trader.location`) to 1.0
    (about to arrive). Meaningless if trader.status isn't InTransit."""
    total_days = travel_days_between(trader.location, trader.destination, trader.transport.speed_units_per_day)
    progress = 1.0 - trader.days_remaining / total_days if total_days > 0 else 1.0
    return min(max(progress, 0.0), 1.0)


class NetworkBackground:
    def __init__(self, state: SimState):
        self.state = state

    def _render_active_events(self, world, viewport, draw_list) -> None:
        """A text list of every currently active Global/Location-wide/
        Worldwide MarketEvent and per-Captain TransportEvent (see
        World.active_named_events), one line per event, colored by scope
        (_EVENT_SCOPE_COLORS) and stacked in the background's top-left
        corner. Local (single-market) events aren't included here -- see
        World.active_named_events for why only these scopes are tracked."""
        events = world.active_named_events()
        if not events:
            return
        x = viewport.work_pos.x + _EVENT_LIST_MARGIN
        y = viewport.work_pos.y + _EVENT_LIST_MARGIN
        for event in events:
            color = _EVENT_SCOPE_COLORS.get(event["scope"], _LABEL_COLOR)
            text = (
                f"[{event['scope']}] Day {event['start_day']}: {event['subject']}: "
                f"{event['name']} ({event['days_remaining']}d left)"
            )
            draw_list.add_text(imgui.ImVec2(x, y), imgui.color_convert_float4_to_u32(color), text)
            y += _EVENT_LIST_LINE_HEIGHT

    def _layout(self, origin: imgui.ImVec2, size: imgui.ImVec2):
        coords = LOCATION_COORDINATES
        xs = [x for x, _ in coords.values()]
        ys = [y for _, y in coords.values()]
        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        span_x = max(max_x - min_x, 1e-9)
        span_y = max(max_y - min_y, 1e-9)
        draw_w = max(size.x - 2 * _MARGIN, 1.0)
        draw_h = max(size.y - 2 * _MARGIN, 1.0)

        def to_screen(name: str) -> imgui.ImVec2:
            x, y = coords[name]
            sx = origin.x + _MARGIN + (x - min_x) / span_x * draw_w
            sy = origin.y + _MARGIN + (y - min_y) / span_y * draw_h
            return imgui.ImVec2(sx, sy)

        return to_screen

    def render(self) -> None:
        world = self.state.world
        viewport = imgui.get_main_viewport()
        to_screen = self._layout(viewport.work_pos, viewport.work_size)
        draw_list = imgui.get_background_draw_list(viewport)

        self._render_active_events(world, viewport, draw_list)

        for route in routes_mod.ROUTES.values():
            if route.origin not in LOCATION_COORDINATES or route.destination not in LOCATION_COORDINATES:
                continue
            color = _ROUTE_COLORS.get(route.route_type, _LABEL_COLOR)
            draw_list.add_line(
                to_screen(route.origin), to_screen(route.destination),
                imgui.color_convert_float4_to_u32(color), 2.0,
            )

        mouse_pos = imgui.get_mouse_pos()
        for location in world.locations:
            if location.name not in LOCATION_COORDINATES:
                continue
            point = to_screen(location.name)
            is_open = world.is_location_open(location.name)
            color = imgui.color_convert_float4_to_u32(_OPEN_COLOR if is_open else _CLOSED_COLOR)
            draw_list.add_circle_filled(point, _NODE_RADIUS, color)

            docked = self._transports_at(world, location.name)
            if docked:
                row_y = point.y - _DOCKED_ROW_GAP
                row_width = (len(docked) - 1) * _DOCKED_SPACING
                start_x = point.x - row_width / 2
                for i, trader in enumerate(docked):
                    dock_point = imgui.ImVec2(start_x + i * _DOCKED_SPACING, row_y)
                    draw_list.add_circle_filled(dock_point, _DOCKED_RADIUS, _transport_color(trader))
                    if _is_hovered(mouse_pos, dock_point, _DOCKED_HOVER_RADIUS):
                        self._render_transport_tooltip(trader)

            if _is_hovered(mouse_pos, point, _HOVER_RADIUS):
                self._render_tooltip(world, location)

        for trader in world.captains:
            if trader.status != TransportStatus.InTransit:
                continue
            if trader.location not in LOCATION_COORDINATES or trader.destination not in LOCATION_COORDINATES:
                continue
            progress = _leg_progress(trader)
            if progress <= 0.0:
                # Hasn't actually moved from `trader.location` yet -- rendered
                # in the docked row above that Location instead (see
                # _transports_at), not as a separate floating in-transit dot.
                continue

            origin_point = to_screen(trader.location)
            destination_point = to_screen(trader.destination)
            point = imgui.ImVec2(
                origin_point.x + (destination_point.x - origin_point.x) * progress,
                origin_point.y + (destination_point.y - origin_point.y) * progress,
            )
            draw_list.add_circle_filled(point, _TRANSPORT_RADIUS, _transport_color(trader))
            if _is_hovered(mouse_pos, point, _TRANSPORT_HOVER_RADIUS):
                self._render_transport_tooltip(trader)

    def _transports_at(self, world, location_name: str):
        """Every transport that reads as "at" this Location -- genuinely
        AtLocation, or InTransit but hasn't actually left yet (progress ==
        0.0, i.e. still sitting right on top of it -- see _leg_progress),
        which renders the same way rather than as a separate floating dot."""
        result = []
        for trader in world.captains:
            if trader.location != location_name:
                continue
            if trader.status == TransportStatus.AtLocation:
                result.append(trader)
            elif trader.status == TransportStatus.InTransit and _leg_progress(trader) <= 0.0:
                result.append(trader)
        return result

    def _render_transport_tooltip(self, trader) -> None:
        transport = trader.transport
        if transport.current_fuel is None:
            fuel_str = "N/A"
        else:
            fuel_str = f"{transport.current_fuel:.1f} / {transport.fuel_capacity:.1f}"
        if trader.cargo is not None:
            cargo_str = f"{trader.cargo['quantity']:.1f} {trader.cargo['commodity']}"
        else:
            cargo_str = "-"
        crew_str = str(len(transport.crew))
        # Captain.cash reads from the owning Faction's shared pool when
        # that Faction pools cash (Company/PoliceFleet default) -- only a
        # SoloTrader/PirateBrigade captain (pools_cash=False) or a
        # Faction-less independent keeps a private balance of their own
        # (see Captain.cash / Faction.pools_cash).
        pools_cash = trader.company is not None and trader.company.pools_cash
        cash_label = "Faction Cash" if pools_cash else "Captain Cash"

        imgui.begin_tooltip()
        imgui.text_colored(_faction_color_vec4(trader), transport.name)
        imgui.separator()
        imgui.text(f"Captain: {trader.name}")
        if trader.company is not None:
            imgui.text(f"Faction: {trader.company.name} ({type(trader.company).__name__})")
        else:
            imgui.text("Faction: Independent")
        imgui.text(f"Fuel: {fuel_str}")
        imgui.text(f"{cash_label}: {trader.cash:,.2f}")
        imgui.text(f"Crew: {crew_str}")
        imgui.text(f"Cargo: {cargo_str}")
        if trader.destination is not None:
            imgui.text(f"Destination: {trader.destination}")
            # trader.path holds every leg AFTER the one currently under way
            # (see Captain._execute_local_route/_arrive) -- prepend the
            # current destination to show the full remaining route.
            remaining_nodes = path_node_sequence(trader.destination, trader.path)
            imgui.text(f"Path: {' -> '.join(remaining_nodes)}")
        imgui.end_tooltip()

    def _connections_for(self, world, location):
        """Every other Location this one has a direct Route to, plus which
        TerminalType each end uses for that route (source -> destination),
        and its length in days. A RouteType only requires EACH end to
        independently have a terminal in
        ROUTE_TERMINAL_COMPATIBILITY[route_type] -- not the same one on both
        ends (e.g. Sea connects a Port to a Platform just as well as a Port
        to a Port) -- so the two ends are reported separately rather than
        intersected, which would wrongly read as empty whenever they differ."""
        locations_by_name = {loc.name: loc for loc in world.locations}
        connections = []
        for route in routes_mod.ROUTES.values():
            if location.name not in (route.origin, route.destination):
                continue
            other_name = route.destination if route.origin == location.name else route.origin
            other = locations_by_name.get(other_name)
            if other is None:
                continue
            required = ROUTE_TERMINAL_COMPATIBILITY[route.route_type]
            here_types = ", ".join(sorted(t.name for t in location.terminal_types & required)) or "-"
            other_types = ", ".join(sorted(t.name for t in other.terminal_types & required)) or "-"
            terminal_str = f"{here_types} -> {other_types}"
            days = travel_days_between(location.name, other_name)
            connections.append((other_name, terminal_str, days))
        return sorted(connections)

    def _render_tooltip(self, world, location) -> None:
        here = self._transports_at(world, location.name)

        imgui.begin_tooltip()
        imgui.text(location.name)
        imgui.separator()
        if world.is_location_open(location.name):
            imgui.text_colored(_OPEN_COLOR, "OPEN")
        else:
            closure = world.closed_locations[location.name]
            imgui.text_colored(_CLOSED_COLOR, f"CLOSED ({closure.name})")
        imgui.separator()
        commodities = sorted(set(location.produced_commodities) | set(location.consumed_commodities))
        if commodities and imgui.begin_table("tooltip_prices", 3, imgui.TableFlags_.borders):
            imgui.table_setup_column("Commodity")
            imgui.table_setup_column("Buy Price")
            imgui.table_setup_column("Sell Price")
            imgui.table_headers_row()
            for commodity in commodities:
                imgui.table_next_row()
                imgui.table_next_column()
                imgui.text(commodity)
                imgui.table_next_column()
                buy_market = world.buy_markets.get((location.name, commodity))
                imgui.text(f"{buy_market.price:.2f}" if buy_market is not None else "-")
                imgui.table_next_column()
                sell_market = world.sell_markets.get((location.name, commodity))
                imgui.text(f"{sell_market.price:.2f}" if sell_market is not None else "-")
            imgui.end_table()
        else:
            imgui.text("No commodities traded here")
        imgui.separator()
        if here and imgui.begin_table("tooltip_transports", 3, imgui.TableFlags_.borders):
            imgui.table_setup_column("Transport")
            imgui.table_setup_column("Faction")
            imgui.table_setup_column("Cargo")
            imgui.table_headers_row()
            for trader in here:
                imgui.table_next_row()
                imgui.table_next_column()
                imgui.text(trader.transport.name)
                imgui.table_next_column()
                imgui.text(trader.company.name if trader.company is not None else "Independent")
                imgui.table_next_column()
                if trader.cargo is not None:
                    imgui.text(f"{trader.cargo['quantity']:.1f} {trader.cargo['commodity']}")
                else:
                    imgui.text("-")
            imgui.end_table()
        else:
            imgui.text("No transports here")
        imgui.separator()
        connections = self._connections_for(world, location)
        if connections and imgui.begin_table("tooltip_connections", 3, imgui.TableFlags_.borders):
            imgui.table_setup_column("Connected To")
            imgui.table_setup_column("Terminal Type")
            imgui.table_setup_column("Days")
            imgui.table_headers_row()
            for other_name, terminal_str, days in connections:
                imgui.table_next_row()
                imgui.table_next_column()
                imgui.text(other_name)
                imgui.table_next_column()
                imgui.text(terminal_str)
                imgui.table_next_column()
                imgui.text(str(days))
            imgui.end_table()
        else:
            imgui.text("No connections")
        imgui.end_tooltip()
