"""
Routes: direct, typed connections between locations (Sea/Railroad/Air),
and the procedurally generated route network built over world_data.LOCATIONS.
Access ROUTES via `routes.ROUTES` (not a `from .routes import ROUTES` copy)
from other modules, so main()/CSV-loading reassignment is seen everywhere.
"""
import random
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Dict, FrozenSet, List, Optional

from .location import Location, TerminalType
from .world_data import LOCATIONS, WORLD_GEN_SEED, distance_between


class RouteType(Enum):
    Railroad=auto()
    Air=auto()
    Sea=auto()


# Which TerminalType(s) a given RouteType can connect through -- a route of
# that type is only usable between two locations that EACH have at least one
# terminal in the corresponding set (see _generate_routes / ROUTE_TERMINAL_COMPATIBILITY).
ROUTE_TERMINAL_COMPATIBILITY: Dict[RouteType, FrozenSet[TerminalType]] = {
    RouteType.Railroad: frozenset({TerminalType.Station}),
    RouteType.Air: frozenset({TerminalType.Airport}),
    RouteType.Sea: frozenset({TerminalType.Port, TerminalType.Platform}),
}

# Fraction of `max_distance` (see _generate_routes) each RouteType is allowed to
# reach -- Air covers the full cap, Sea is trimmed a bit, and Railroad (the
# shortest-hop mode) is trimmed the most.
ROUTE_TYPE_DISTANCE_SCALE: Dict[RouteType, float] = {
    RouteType.Air: 1.0,
    RouteType.Sea: 0.8,
    RouteType.Railroad: 0.5,
}


@dataclass
class Route:
    """
    A single direct connection between two locations, tagged with the
    mode of transport that covers it: Sea, Railroad, or Air. A Route
    doesn't invent a second source of truth for geography -- its
    `distance` is derived once, at construction time, from the same
    synthetic coordinates every other part of the simulation already
    uses (see LOCATION_COORDINATES / distance_between); it's really just
    that distance wrapped up with a transport-mode label.

    Routes are undirected: a Route between A and B also covers the trip
    from B to A, since neither distance nor mode depends on direction in
    this simulation. Use `get_route(a, b)` rather than constructing one
    directly, so lookups work no matter which location is named first.
    """
    origin: str
    destination: str
    route_type: "RouteType"
    distance: float = field(init=False)

    def __post_init__(self):
        self.distance = distance_between(self.origin, self.destination)


def _compatible_route_types(origin: Location, destination: Location) -> List[RouteType]:
    """
    Which RouteType(s) a route between these two locations could use: a
    RouteType is compatible only if BOTH locations have at least one of the
    terminal types it requires (see ROUTE_TERMINAL_COMPATIBILITY). Every
    location always has a Port (see _generate_locations), and Sea accepts
    either Port or Platform, so this is always non-empty.
    """
    return [
        route_type for route_type, required_terminals in ROUTE_TERMINAL_COMPATIBILITY.items()
        if origin.terminal_types & required_terminals and destination.terminal_types & required_terminals
    ]


def _generate_routes(locations: List[Location], seed: int = WORLD_GEN_SEED,
                      max_distance: Optional[float] = None) -> Dict[FrozenSet[str], Route]:
    """
    Build the route network: one Route for every pair of locations that
    share at least one compatible terminal type (see _compatible_route_types)
    -- a pair with no compatible RouteType at all (e.g. one location is
    Station-only and the other is Airport-only, sharing neither a Port/
    Platform, a Station, nor an Airport) gets no Route whatsoever, rather
    than being forced onto a type neither end can actually use. Among a
    pair's compatible types, one is picked at random, and the pair is then
    also skipped if it's farther apart than `max_distance` scaled by that
    chosen type's entry in ROUTE_TYPE_DISTANCE_SCALE (e.g. with
    max_distance=1000, a Railroad connection needs the pair within 500
    units, while an Air connection gets the full 1000). No distance cap at
    all when `max_distance` is None. Uses a dedicated RNG (a third
    independent stream, after the ones used for locations and coordinates)
    so this doesn't consume from -- or get disrupted by -- the
    simulation's own random stream, keeping the network reproducible run to
    run just like _generate_locations and _generate_coordinates already
    are. The type is always drawn before the distance check, so trimming
    the network via `max_distance` doesn't reshuffle which type gets
    assigned to any pair that has one available.
    """
    rng = random.Random(seed + 2)
    routes: Dict[FrozenSet[str], Route] = {}
    for i, origin in enumerate(locations):
        for destination in locations[i + 1:]:
            compatible_types = _compatible_route_types(origin, destination)
            if not compatible_types:
                continue
            route_type = rng.choice(compatible_types)
            if max_distance is not None:
                scale = ROUTE_TYPE_DISTANCE_SCALE.get(route_type, 1.0)
                if distance_between(origin.name, destination.name) > max_distance * scale:
                    continue
            routes[frozenset((origin.name, destination.name))] = Route(
                origin=origin.name, destination=destination.name, route_type=route_type)
    return routes


ROUTES: Dict[FrozenSet[str], Route] = _generate_routes(LOCATIONS)


def get_route(location_a: str, location_b: str) -> Optional[Route]:
    """Look up the direct Route between two (distinct) locations, regardless of argument order."""
    if location_a == location_b:
        return None
    return ROUTES.get(frozenset((location_a, location_b)))
