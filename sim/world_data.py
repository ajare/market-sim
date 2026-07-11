"""
The commodity roster and the world's geography (coordinates, distance,
travel time). Holds the mutable module-level world state (COMMODITIES,
LOCATIONS, LOCATION_COORDINATES) that main() / the CSV loaders may replace
wholesale -- always access these via `world_data.NAME` (not
`from .world_data import NAME`) from other modules so a reassignment here
is actually seen everywhere. See location.py for the Location/TerminalType
classes themselves, and commodity.py for the Commodity class itself.
"""
import math
import random
from typing import Dict, List, Optional, Tuple

from .commodity import Commodity, build_commodities
from .location import Location, TerminalType

# Fuel is tracked separately from the tradeable Commodity roster below --
# it's an input every transport needs, not something arbitraged for its
# own sake, priced per-Location (Location.fuel_price) and never
# fluctuating (see World.__init__, which marks every Fuel market
# fixed_price=True).
FUEL_BASE_PRICE = 1.25

# The full tradeable commodity roster, each carrying its own base price,
# price-reaction sensitivity, deficit-price boost, and random-event
# templates (see commodity.Commodity) -- used to seed every location's
# local price around a common reference point (with per-location variation
# applied below).
COMMODITIES: Dict[str, Commodity] = build_commodities(
    names=["Crude Oil", "Copper", "Wheat", "Gold", "Silver",
           "Natural Gas", "Coffee", "Cotton", "Iron Ore", "Aluminum"],
    base_prices={
        "Crude Oil": 75.0, "Copper": 82.0, "Wheat": 6.5, "Gold": 2300.0,
        "Silver": 28.0, "Natural Gas": 3.5, "Coffee": 1.85, "Cotton": 0.85,
        "Iron Ore": 110.0, "Aluminum": 95.0,
    },
)

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


def _generate_locations(names: List[str], commodities: Dict[str, Commodity], seed: int = WORLD_GEN_SEED,
                         consumed_stockpile_factor: float = 2.0) -> List[Location]:
    """
    Assign each location a handful of produced and consumed commodities
    (never every commodity, and never the same commodity in both roles --
    that keeps the "not everywhere trades everything" flavor at any scale),
    a starting stockpile of each, and per-location base prices scattered
    +/-15% around each commodity's own `Commodity.base_price`, using a
    dedicated RNG so this doesn't consume from (or get disrupted by) the
    simulation's own random stream. Names in FUEL_DEPOT_NAMES are the
    exception: they only ever deal in Fuel, nothing else.

    produced_commodities/consumed_commodities are rate MODIFIERS (scattered
    +/-30% around the default 1.0 -- see Location.production_rate/
    consumption_rate), not absolute rates; stockpile/min_stockpile sizing
    below multiplies each modifier by the commodity's own
    base_production_rate/base_consumption_rate to get the actual units/day
    rate a "days of buffer" target is measured against. base_price_modifiers
    is the same idea applied to price: a MODIFIER (default 1.0) scattered
    +/-15% around 1.0, multiplied by the commodity's own base_price at
    lookup time (see Location.base_price()), not an absolute price.

    `consumed_stockpile_factor` sets a consumed commodity's starting
    stockpile as a straight multiple of its minimum (2x by default, i.e.
    every location starts comfortably above the point where it would buy).
    """
    rng = random.Random(seed)
    commodity_names = list(commodities)
    locations = []
    for name in names:
        if name in FUEL_DEPOT_NAMES:
            # Fuel is priced identically everywhere (see World.__init__,
            # which marks every Fuel market fixed_price=True) -- no
            # per-location randomization, unlike every other commodity.
            locations.append(Location(
                name=name,
                produced_commodities={},
                consumed_commodities={},
                stockpiles={},
                min_stockpiles={},
                base_price_modifiers={},
                fuel_price=FUEL_BASE_PRICE,
                terminal_types=frozenset({TerminalType.Port}),
            ))
            continue

        produced = rng.sample(commodity_names, rng.randint(2, 4))
        remaining = [c for c in commodity_names if c not in produced]
        consumed = rng.sample(remaining, min(rng.randint(2, 4), len(remaining)))

        produced_commodities = {c: round(rng.uniform(0.7, 1.3), 2) for c in produced}
        consumed_commodities = {c: round(rng.uniform(0.7, 1.3), 2) for c in consumed}

        stockpiles: Dict[str, float] = {}
        min_stockpiles: Dict[str, float] = {}
        base_price_modifiers: Dict[str, float] = {}
        for c, modifier in produced_commodities.items():
            # 10-25 days of accumulated output as the starting/reference level.
            effective_rate = commodities[c].base_production_rate * modifier
            stockpiles[c] = round(effective_rate * rng.uniform(10, 25), 2)
            base_price_modifiers[c] = round(rng.uniform(0.85, 1.15), 2)
        for c, modifier in consumed_commodities.items():
            # A 5-10 day buffer as the minimum, with the starting stockpile
            # set as a straight multiple of it (see consumed_stockpile_factor).
            effective_rate = commodities[c].base_consumption_rate * modifier
            min_stockpiles[c] = round(effective_rate * rng.uniform(5, 10), 2)
            stockpiles[c] = round(min_stockpiles[c] * consumed_stockpile_factor, 2)
            base_price_modifiers[c] = round(rng.uniform(0.85, 1.15), 2)

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
            produced_commodities=produced_commodities,
            consumed_commodities=consumed_commodities,
            stockpiles=stockpiles,
            min_stockpiles=min_stockpiles,
            base_price_modifiers=base_price_modifiers,
            fuel_price=FUEL_BASE_PRICE,
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
