"""
The commodity roster and the world's geography (coordinates, distance,
travel time). Holds the mutable module-level world state (COMMODITIES,
BASE_PRICES, LOCATIONS, LOCATION_COORDINATES) that main() / the CSV
loaders may replace wholesale -- always access these via
`world_data.NAME` (not `from .world_data import NAME`) from other modules
so a reassignment here is actually seen everywhere. See location.py for
the Location/TerminalType classes themselves.
"""
import math
import random
from typing import Dict, List, Optional, Tuple

from .location import Location, TerminalType


# The full commodity roster (Fuel is tracked separately -- it's an input
# every transport needs, not something arbitraged for its own sake) and a base
# price for each, used to seed every location's local price around a
# common reference point (with per-location variation applied below).
COMMODITIES: List[str] = [
    "Crude Oil", "Copper", "Wheat", "Gold", "Silver",
    "Natural Gas", "Coffee", "Cotton", "Iron Ore", "Aluminum",
]
BASE_PRICES: Dict[str, float] = {
    "Crude Oil": 75.0, "Copper": 82.0, "Wheat": 6.5, "Gold": 2300.0,
    "Silver": 28.0, "Natural Gas": 3.5, "Coffee": 1.85, "Cotton": 0.85,
    "Iron Ore": 110.0, "Aluminum": 95.0, "Fuel": 1.25,
}

# 30 trading hubs. With this many locations and commodities, hand-writing
# every buy/sell list, price, and distance pair (435 of them) stops being
# practical -- so the network is generated procedurally below from a fixed
# seed, which keeps it entirely reproducible without hand-maintaining a
# huge literal table. Real locations map to a synthetic 2D coordinate; the
# distance between any two is just their Euclidean distance, so every pair
# automatically has a sensible distance without needing a lookup table.
LOCATION_NAMES: List[str] = [
    "Rotterdam Port", "Chicago Exchange", "Shanghai Hub", "Sao Paulo Depot",
    "Singapore Terminal", "Dubai Exchange", "Mumbai Hub", "Lagos Port",
    "Sydney Terminal", "Vancouver Port", "Hamburg Exchange", "Busan Hub",
    "Cape Town Port", "Houston Terminal", "Antwerp Exchange", "Santos Port",
    "Jakarta Hub", "Istanbul Exchange", "Los Angeles Port", "Mexico City Hub",
    "London Exchange", "Tokyo Terminal", "Buenos Aires Port", "Cairo Exchange",
    "Bangkok Hub", "Toronto Terminal", "Karachi Port", "Manila Exchange",
    "Lima Hub", "Nairobi Terminal",
]

# Pure fuel depots: refueling-only stops that trade nothing but Fuel -- no
# commodity can be bought or sold there. These exist purely to let a transport
# top up mid-journey; they never show up as an arbitrage opportunity for
# any commodity, and Captain's route search already only ever looks at
# `buy_markets`/`sell_markets`, which for these locations will simply have
# no entries for anything but Fuel.
FUEL_DEPOT_NAMES: List[str] = [
    "Gibraltar Fuel Depot", "Suez Bunkering Station", "Malacca Fuel Depot",
]

ALL_LOCATION_NAMES: List[str] = LOCATION_NAMES + FUEL_DEPOT_NAMES

WORLD_GEN_SEED = 2024  # fixed seed for the static network layout, independent of the simulation's own seed


def _generate_locations(names: List[str], commodities: List[str], seed: int = WORLD_GEN_SEED) -> List[Location]:
    """
    Assign each location a handful of buyable and sellable commodities
    (never every commodity -- that keeps the "not everywhere trades
    everything" flavor at any scale) and per-location prices scattered
    +/-15% around each commodity's base price, using a dedicated RNG so
    this doesn't consume from (or get disrupted by) the simulation's own
    random stream. Names in FUEL_DEPOT_NAMES are the exception: they only
    ever buy/sell Fuel, nothing else.
    """
    rng = random.Random(seed)
    locations = []
    for name in names:
        if name in FUEL_DEPOT_NAMES:
            # Fuel is priced identically everywhere (see World.__init__,
            # which marks every Fuel market fixed_price=True) -- no
            # per-location randomization, unlike every other commodity.
            locations.append(Location(
                name=name,
                buyable_commodities=["Fuel"],
                sellable_commodities=[],
                buy_prices={"Fuel": BASE_PRICES["Fuel"]},
                sell_prices={},
                terminal_types=frozenset({TerminalType.Port}),
            ))
            continue

        buyable = rng.sample(commodities, rng.randint(3, 5))
        sellable = rng.sample(commodities, rng.randint(2, 4))
        buy_prices = {c: round(BASE_PRICES[c] * rng.uniform(0.85, 1.15), 2) for c in buyable}
        buy_prices["Fuel"] = BASE_PRICES["Fuel"]
        sell_prices = {c: round(BASE_PRICES[c] * rng.uniform(0.85, 1.15), 2) for c in sellable}
        # Every location has a Port, plus a random subset of the other
        # terminal kinds so the network has room to grow into land/air/rail
        # routes -- except Platform, which is exclusive (see
        # Location.__post_init__): a location drawing Platform gets ONLY
        # Platform, never Port or anything else alongside it.
        other_terminals = rng.sample(
            [t for t in TerminalType if t is not TerminalType.Port], rng.randint(0, 2))
        if TerminalType.Platform in other_terminals:
            terminal_types = frozenset({TerminalType.Platform})
        else:
            terminal_types = frozenset([TerminalType.Port] + other_terminals)
        locations.append(Location(
            name=name,
            buyable_commodities=buyable + ["Fuel"],
            sellable_commodities=sellable,
            buy_prices=buy_prices,
            sell_prices=sell_prices,
            terminal_types=terminal_types,
        ))
    return locations


def _generate_coordinates(names: List[str], seed: int = WORLD_GEN_SEED,
                           min_distance: float = 200.0) -> Dict[str, Tuple[float, float]]:
    """
    Scatter locations across a synthetic map, rejecting any candidate point
    closer than `min_distance` to one already placed -- keeps two locations
    from ever landing on (or right next to) each other, which would collapse
    their distance/travel time to ~0 and make them read as one dot on the
    network view. Distance = Euclidean distance between two points. Falls
    back to the last-tried candidate if 1000 attempts can't find a spot far
    enough from everything already placed, rather than looping forever --
    with 3000x3000 units of space this only matters if `min_distance` is set
    unreasonably large for how many `names` there are.
    """
    rng = random.Random(seed + 1)  # different stream than _generate_locations, still fully reproducible
    coordinates: Dict[str, Tuple[float, float]] = {}
    for name in names:
        candidate = (rng.uniform(0, 3000), rng.uniform(0, 3000))
        for _ in range(1000):
            if all(math.hypot(candidate[0] - x, candidate[1] - y) >= min_distance
                   for x, y in coordinates.values()):
                break
            candidate = (rng.uniform(0, 3000), rng.uniform(0, 3000))
        coordinates[name] = candidate
    return coordinates


LOCATIONS: List[Location] = _generate_locations(ALL_LOCATION_NAMES, COMMODITIES)
LOCATION_COORDINATES: Dict[str, Tuple[float, float]] = _generate_coordinates(ALL_LOCATION_NAMES)


def get_location(name: str) -> Optional[Location]:
    """
    Look up a Location by name. Scans the current LOCATIONS (read fresh
    each call, like ROUTES-based get_route) rather than a cached dict, so
    it stays correct after main()/CSV loading reassigns world_data.LOCATIONS
    wholesale.
    """
    for location in LOCATIONS:
        if location.name == name:
            return location
    return None

# ---------------------------------------------------------------------------
# Geography: distances and travel time between locations
# ---------------------------------------------------------------------------
#
# Distance is expressed in arbitrary "distance units"; ships cover
# SHIP_SPEED_UNITS_PER_DAY of those units per day, and any leftover partial
# day is rounded UP (a transport that needs 2.1 days takes 3 calendar days, not
# 2). Every location pair automatically has a well-defined distance via
# LOCATION_COORDINATES, so there's no fallback default needed even as the
# network grows.

SHIP_SPEED_UNITS_PER_DAY = 500  # how much distance a shipment covers per day


def distance_between(location_a: str, location_b: str) -> float:
    if location_a == location_b:
        return 0.0
    x1, y1 = LOCATION_COORDINATES[location_a]
    x2, y2 = LOCATION_COORDINATES[location_b]
    return math.hypot(x2 - x1, y2 - y1)


def travel_days_between(location_a: str, location_b: str,
                         speed: float = SHIP_SPEED_UNITS_PER_DAY) -> int:
    """
    Travel time in whole days. Always at least 1 day, even when origin and
    destination are the same location (an instant local spread-capture
    trade still takes a day to settle in this simulation).
    """
    dist = distance_between(location_a, location_b)
    return max(1, math.ceil(dist / speed))
