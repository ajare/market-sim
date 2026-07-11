"""
Commodity: encapsulates all data about ONE tradeable commodity that's
independent of any particular Location -- its reference price, how
sharply its price reacts to a stockpile deviation, how much extra boost
that reaction gets on the deficit/shortage side, and the pool of random
MarketEvent templates that can hit it. This used to be scattered across
four separate parallel dicts, each hand-keyed by the same commodity name
(world_data.BASE_PRICES, markets.PRICE_SENSITIVITY, markets.DEFICIT_PRICE_BOOST,
events.EVENT_TEMPLATES) -- now it's one object per commodity, built once by
`build_commodities` and held in `world_data.COMMODITIES`.

Fuel is deliberately NOT a Commodity -- it's priced per-Location
(Location.fuel_price), never fluctuates, and isn't part of the produce/
consume/stockpile system at all (see world_data.FUEL_BASE_PRICE).
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

# Fallback sensitivity/deficit-boost for a commodity with no explicit
# hand-tuned value -- lets a custom commodities_csv (see cli.build_world)
# introduce commodities never hand-tuned for without crashing.
DEFAULT_PRICE_SENSITIVITY = 0.45
DEFAULT_DEFICIT_PRICE_BOOST = 1.4

# Fallback base production/consumption rate (units/day, at a Location whose
# rate modifier is the default 1.0 -- see Location.production_rate/
# consumption_rate) for a commodity with no explicit hand-tuned value.
DEFAULT_BASE_PRODUCTION_RATE = 8.0
DEFAULT_BASE_CONSUMPTION_RATE = 8.0

# Fallback reference price for a Location.base_price() lookup whose commodity
# has no registry entry at all (e.g. a custom locations_csv introducing a
# commodity never registered via a matching commodities_csv).
DEFAULT_BASE_PRICE = 1.0


@dataclass
class Commodity:
    """
    name: the commodity's identifier, matching Location.produced_commodities/
        consumed_commodities/stockpiles/min_stockpiles/base_price_modifiers
        keys.
    base_price: the world-wide reference price a Location's own
        base_price_modifiers entry scales (see Location.base_price()).
    price_sensitivity: how strongly this commodity's price reacts to its
        stockpile sitting away from its reference level (see
        Market._stockpile_price) -- e.g. 0.6 means a stockpile fully
        depleted (or, symmetrically, doubled) relative to its reference
        moves price by 60%. Larger values swing harder on the same
        deficit/surplus.
    deficit_price_boost: an extra multiplier applied ON TOP of
        price_sensitivity, but only on the location's BUY side (a Captain
        SELLING into the location) and only while it's running low
        (deviation > 0). Lets this commodity's shortage premium climb
        harder than its glut discount eases off, to pull more Captains
        toward selling it in when it's scarce. 1.0 means fully symmetric.
    event_templates: the pool of random MarketEvent templates that can hit
        this commodity, LOCALLY (one location's market) or GLOBALLY (every
        location that trades it) -- see Market._maybe_trigger_local_event /
        World._maybe_trigger_global_event.
    base_production_rate / base_consumption_rate: this commodity's
        units/day rate at a Location with the default 1.0 rate modifier --
        the actual per-location rate is this times that Location's own
        modifier (see Location.production_rate/consumption_rate), so two
        locations producing the same commodity can still differ (a modifier
        of 1.5 produces 50% faster than the commodity's own baseline).
    """
    name: str
    base_price: float
    price_sensitivity: float = DEFAULT_PRICE_SENSITIVITY
    deficit_price_boost: float = DEFAULT_DEFICIT_PRICE_BOOST
    event_templates: List[dict] = field(default_factory=list)
    base_production_rate: float = DEFAULT_BASE_PRODUCTION_RATE
    base_consumption_rate: float = DEFAULT_BASE_CONSUMPTION_RATE


def _make_commodity_events(commodity: str, boom: str, disruption: str, glut: str, slump: str) -> List[dict]:
    """
    Generate a standard 4-event pack (demand boost / supply disruption /
    oversupply / demand slump) for a commodity, using short driver phrases
    to keep the flavor text distinct per commodity without hand-writing
    every line. Used for every commodity that doesn't have a fully bespoke
    hand-authored list (see the four in `_DEFAULT_COMMODITIES` below, and
    any name introduced via a custom commodities_csv).
    """
    return [
        dict(name=f"{boom} boosts {commodity} demand", demand_multiplier=1.3, supply_multiplier=1.0, duration_days=5),
        dict(name=f"{disruption} disrupts {commodity} supply", demand_multiplier=1.0, supply_multiplier=0.65, duration_days=5),
        dict(name=f"{glut} creates a {commodity} glut", demand_multiplier=1.0, supply_multiplier=1.3, duration_days=5),
        dict(name=f"{slump} dampens {commodity} demand", demand_multiplier=0.8, supply_multiplier=1.0, duration_days=6),
    ]


# The four commodities with fully bespoke event flavor text (kept
# hand-written since they were the original roster); every other
# commodity -- including every one added later, and anything a custom
# commodities_csv introduces -- gets a generated four-pack instead (see
# _make_commodity_events / build_commodities).
_BESPOKE_EVENT_TEMPLATES: Dict[str, List[dict]] = {
    "Crude Oil": [
        dict(name="Heatwave boosts energy demand", demand_multiplier=1.4, supply_multiplier=1.0, duration_days=4),
        dict(name="Port strike disrupts supply chain", demand_multiplier=1.0, supply_multiplier=0.6, duration_days=5),
        dict(name="Geopolitical tension in producing region", demand_multiplier=1.1, supply_multiplier=0.7, duration_days=6),
        dict(name="OPEC+ production cut", demand_multiplier=1.0, supply_multiplier=0.75, duration_days=6),
    ],
    "Copper": [
        dict(name="Construction boom", demand_multiplier=1.3, supply_multiplier=1.0, duration_days=5),
        dict(name="Mine collapse cuts output", demand_multiplier=1.0, supply_multiplier=0.65, duration_days=5),
        dict(name="Technological breakthrough increases efficiency", demand_multiplier=1.0, supply_multiplier=1.3, duration_days=5),
        dict(name="Recession fears dampen demand", demand_multiplier=0.75, supply_multiplier=1.0, duration_days=6),
    ],
    "Wheat": [
        dict(name="Drought reduces harvest", demand_multiplier=1.0, supply_multiplier=0.6, duration_days=6),
        dict(name="Bumper harvest / production surplus", demand_multiplier=1.0, supply_multiplier=1.4, duration_days=4),
        dict(name="Export ban announced", demand_multiplier=1.2, supply_multiplier=0.8, duration_days=5),
        dict(name="New trade agreement lowers tariffs", demand_multiplier=1.15, supply_multiplier=1.0, duration_days=4),
    ],
    "Gold": [
        dict(name="Stock market turmoil drives safe-haven demand", demand_multiplier=1.35, supply_multiplier=1.0, duration_days=5),
        dict(name="Positive economic growth report", demand_multiplier=0.85, supply_multiplier=1.0, duration_days=3),
        dict(name="Central bank buying spree", demand_multiplier=1.25, supply_multiplier=1.0, duration_days=6),
        dict(name="New mine discovery", demand_multiplier=1.0, supply_multiplier=1.2, duration_days=5),
    ],
}

# Generic driver phrases for a generated four-pack (see
# _make_commodity_events) -- (boom, disruption, glut, slump), one tuple per
# commodity. Six of the ten default commodities use this; a commodity
# introduced via a custom commodities_csv (see build_commodities) falls
# back to _GENERIC_EVENT_DRIVERS below instead of appearing here.
_GENERATED_EVENT_DRIVERS: Dict[str, tuple] = {
    "Silver": ("Surging industrial demand", "Mine strike", "New refining capacity", "Recession fears"),
    "Natural Gas": ("Cold snap", "Pipeline outage", "Mild winter", "Warm winter forecast"),
    "Coffee": ("Strong consumer demand", "Frost in growing regions", "Bumper harvest", "Weak consumer spending"),
    "Cotton": ("Textile industry boom", "Drought in growing regions", "Bumper harvest", "Synthetic fiber substitution"),
    "Iron Ore": ("Steel demand surge", "Mine flooding", "New mine coming online", "Steel industry slowdown"),
    "Aluminum": ("Aerospace demand surge", "Smelter power outage", "New smelter capacity", "Automotive slowdown"),
}

# Fallback driver phrases for a commodity with no bespoke or hand-picked
# entry above at all -- e.g. one introduced via a custom commodities_csv.
_GENERIC_EVENT_DRIVERS = ("Strong demand", "Supply disruption", "Oversupply", "Weak demand")

# Hand-tuned price_sensitivity/deficit_price_boost for the ten default
# commodities (see Commodity's docstring); anything not listed here (a
# custom commodities_csv's commodity) uses DEFAULT_PRICE_SENSITIVITY/
# DEFAULT_DEFICIT_PRICE_BOOST instead (see build_commodities).
_PRICE_SENSITIVITY: Dict[str, float] = {
    "Crude Oil": 0.6, "Copper": 0.5, "Wheat": 0.45, "Gold": 0.25, "Silver": 0.35,
    "Natural Gas": 0.55, "Coffee": 0.45, "Cotton": 0.45, "Iron Ore": 0.45, "Aluminum": 0.45,
}

# Every commodity gets some deficit-price boost; Coffee's is highest (a
# perishable agricultural good goes from fine to desperately short fastest).
_DEFICIT_PRICE_BOOST: Dict[str, float] = {
    "Crude Oil": 1.5, "Copper": 1.4, "Wheat": 1.6, "Gold": 1.2, "Silver": 1.4,
    "Natural Gas": 1.6, "Coffee": 2.0, "Cotton": 1.5, "Iron Ore": 1.3, "Aluminum": 1.3,
}

# Hand-tuned base production/consumption rates (units/day) for the ten
# default commodities -- bulkier/cheaper goods (Crude Oil, Natural Gas, Iron
# Ore) move at a higher daily volume than scarce/expensive ones (Gold,
# Silver). Anything not listed here (a custom commodities_csv's commodity)
# uses DEFAULT_BASE_PRODUCTION_RATE/DEFAULT_BASE_CONSUMPTION_RATE instead.
_BASE_PRODUCTION_RATE: Dict[str, float] = {
    "Crude Oil": 14.0, "Copper": 8.0, "Wheat": 10.0, "Gold": 2.0, "Silver": 4.0,
    "Natural Gas": 12.0, "Coffee": 6.0, "Cotton": 7.0, "Iron Ore": 11.0, "Aluminum": 8.0,
}
_BASE_CONSUMPTION_RATE: Dict[str, float] = {
    "Crude Oil": 13.0, "Copper": 7.0, "Wheat": 9.0, "Gold": 2.0, "Silver": 4.0,
    "Natural Gas": 11.0, "Coffee": 6.0, "Cotton": 6.0, "Iron Ore": 10.0, "Aluminum": 7.0,
}


def _event_templates_for(name: str) -> List[dict]:
    """The event-template pack for `name`: bespoke if hand-authored,
    generated from hand-picked driver phrases if not, otherwise generated
    from fully generic ones -- every commodity gets SOME pack."""
    if name in _BESPOKE_EVENT_TEMPLATES:
        return _BESPOKE_EVENT_TEMPLATES[name]
    drivers = _GENERATED_EVENT_DRIVERS.get(name, _GENERIC_EVENT_DRIVERS)
    return _make_commodity_events(name, *drivers)


def build_commodities(
    names: List[str],
    base_prices: Dict[str, float],
    production_rates: Optional[Dict[str, float]] = None,
    consumption_rates: Optional[Dict[str, float]] = None,
) -> Dict[str, Commodity]:
    """
    Build one `Commodity` per name, pulling hand-tuned price_sensitivity/
    deficit_price_boost/event_templates where they exist (the ten default
    commodities) and falling back to the DEFAULT_*/generic-driver values
    otherwise -- so a custom commodities_csv (see cli.build_world) can
    introduce entirely new commodities without needing to also hand-tune
    every one of these. production_rates/consumption_rates are an optional
    per-name CSV override (see load_commodities_csv); any name absent from
    them falls back to the hand-tuned _BASE_PRODUCTION_RATE/
    _BASE_CONSUMPTION_RATE dicts, then DEFAULT_BASE_PRODUCTION_RATE/
    DEFAULT_BASE_CONSUMPTION_RATE.
    """
    production_rates = production_rates or {}
    consumption_rates = consumption_rates or {}
    return {
        name: Commodity(
            name=name,
            base_price=base_prices[name],
            price_sensitivity=_PRICE_SENSITIVITY.get(name, DEFAULT_PRICE_SENSITIVITY),
            deficit_price_boost=_DEFICIT_PRICE_BOOST.get(name, DEFAULT_DEFICIT_PRICE_BOOST),
            event_templates=_event_templates_for(name),
            base_production_rate=production_rates.get(
                name, _BASE_PRODUCTION_RATE.get(name, DEFAULT_BASE_PRODUCTION_RATE)),
            base_consumption_rate=consumption_rates.get(
                name, _BASE_CONSUMPTION_RATE.get(name, DEFAULT_BASE_CONSUMPTION_RATE)),
        )
        for name in names
    }
