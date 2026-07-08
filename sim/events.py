"""
Random external events: market-wide demand/supply shocks (MarketEvent),
per-agent shocks (AgentEvent), and whole-port shutdowns (LocationClosure).
"""
import random
from dataclasses import dataclass, field
from typing import Dict, List, Optional


# ---------------------------------------------------------------------------
# External Events
# ---------------------------------------------------------------------------

@dataclass
class Event:
    """
    Base class for every random external shock in the simulation
    (MarketEvent, AgentEvent, LocationClosure). Each subclass keeps its own
    domain-specific fields (e.g. MarketEvent's `name`/`duration_days`) so
    existing call sites and reporting code don't need to change, but every
    subclass's __post_init__ populates this shared `type`/`subject`/`day`/
    `duration`/`message` view -- `type` categorizes the event (e.g. "Global"/
    "Local" for a MarketEvent, "Agent", "Closure"), `subject` is the
    commodity/location/captain it's about, `day` is when it started,
    `duration` is how many days it lasts, and `message` is the human-readable
    description. The day-by-day `days_remaining` bookkeeping and `tick()`
    are shared here too.
    """
    type: str = field(init=False, default="")
    subject: str = field(init=False, default="")
    message: str = field(init=False, default="")
    duration: int = field(init=False, default=1)
    day: Optional[int] = field(init=False, default=None)
    days_remaining: int = field(init=False, default=0)

    def tick(self) -> bool:
        """Advance the event by one day. Returns True if still active."""
        self.days_remaining -= 1
        return self.days_remaining > 0

    def __str__(self) -> str:
        day_str = f"day {self.day}, " if self.day is not None else ""
        return f"[{self.type}] {self.subject}: {self.message} ({day_str}{self.days_remaining}/{self.duration}d remaining)"


@dataclass
class MarketEvent(Event):
    """
    A random external shock that temporarily modifies demand and/or supply
    for a specific commodity. If `location` is None the event is GLOBAL and
    affects that commodity at every location that trades it; otherwise it is
    LOCAL and only affects that one location's market for the commodity.
    """
    name: str
    demand_multiplier: float = 1.0
    supply_multiplier: float = 1.0
    duration_days: int = 1
    location: Optional[str] = None  # None = affects all locations

    def __post_init__(self):
        self.days_remaining = self.duration_days
        self.message = self.name
        self.duration = self.duration_days
        self.subject = self.location or ""
        self.type = "Local" if self.location else "Global"


# Event templates are commodity-specific since a heatwave affects oil demand
# differently than it affects gold demand, for example.
EVENT_TEMPLATES: Dict[str, List[dict]] = {
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
    "Fuel": [
        dict(name="Refinery outage cuts bunker fuel supply", demand_multiplier=1.0, supply_multiplier=0.6, duration_days=5),
        dict(name="Shipping surge boosts bunker fuel demand", demand_multiplier=1.3, supply_multiplier=1.0, duration_days=4),
        dict(name="OPEC+ supply cut ripples into fuel costs", demand_multiplier=1.0, supply_multiplier=0.75, duration_days=6),
        dict(name="New refining capacity comes online", demand_multiplier=1.0, supply_multiplier=1.25, duration_days=5),
        dict(name="Port congestion drives up local bunkering demand", demand_multiplier=1.2, supply_multiplier=0.9, duration_days=4),
    ],
}


def _make_commodity_events(commodity: str, boom: str, disruption: str, glut: str, slump: str) -> List[dict]:
    """
    Generate a standard 4-event pack (demand boost / supply disruption /
    oversupply / demand slump) for a commodity, using short driver phrases
    to keep the flavor text distinct per commodity without hand-writing
    every line. Used for commodities added beyond the original four, which
    keep their fully bespoke lists above.
    """
    return [
        dict(name=f"{boom} boosts {commodity} demand", demand_multiplier=1.3, supply_multiplier=1.0, duration_days=5),
        dict(name=f"{disruption} disrupts {commodity} supply", demand_multiplier=1.0, supply_multiplier=0.65, duration_days=5),
        dict(name=f"{glut} creates a {commodity} glut", demand_multiplier=1.0, supply_multiplier=1.3, duration_days=5),
        dict(name=f"{slump} dampens {commodity} demand", demand_multiplier=0.8, supply_multiplier=1.0, duration_days=6),
    ]


EVENT_TEMPLATES["Silver"] = _make_commodity_events(
    "Silver", "Surging industrial demand", "Mine strike", "New refining capacity", "Recession fears")
EVENT_TEMPLATES["Natural Gas"] = _make_commodity_events(
    "Natural Gas", "Cold snap", "Pipeline outage", "Mild winter", "Warm winter forecast")
EVENT_TEMPLATES["Coffee"] = _make_commodity_events(
    "Coffee", "Strong consumer demand", "Frost in growing regions", "Bumper harvest", "Weak consumer spending")
EVENT_TEMPLATES["Cotton"] = _make_commodity_events(
    "Cotton", "Textile industry boom", "Drought in growing regions", "Bumper harvest", "Synthetic fiber substitution")
EVENT_TEMPLATES["Iron Ore"] = _make_commodity_events(
    "Iron Ore", "Steel demand surge", "Mine flooding", "New mine coming online", "Steel industry slowdown")
EVENT_TEMPLATES["Aluminum"] = _make_commodity_events(
    "Aluminum", "Aerospace demand surge", "Smelter power outage", "New smelter capacity", "Automotive slowdown")


@dataclass
class AgentEvent(Event):
    """
    A random shock that hits a specific AGENT (transport) rather than a market --
    mechanical trouble, piracy, paperwork delays, windfalls, and so on.
    Unlike MarketEvents these don't move prices; they change what the transport
    itself can do. `kind` determines how Captain interprets
    `magnitude`:

      - "delay":               add `magnitude` days to the current voyage
                                (if in transit) or to time stuck at the dock
                                (if in port).
      - "cargo_loss":          lose `magnitude` (a 0-1 fraction) of cargo
                                currently held. Only rolled if cargo exists.
      - "cash_gain"/"cash_loss": a one-off $ amount added to / taken from cash.
      - "fuel_discount":       cuts fuel consumption (loaded and ballast) by
                                `magnitude` (a 0-1 fraction) for `duration_days`.
      - "fixed_cost_discount": cuts the flat per-voyage fee by `magnitude`
                                (a 0-1 fraction) for `duration_days`.
    """
    name: str
    kind: str
    magnitude: float
    duration_days: int = 1
    # Set by Captain._apply_agent_event when a persisting ("fuel_discount"/
    # "fixed_cost_discount") event is added to Captain.active_agent_events --
    # None for the instantaneous kinds, which are never tracked there.
    # Lets a caller (e.g. exp-ui's active-events display) report when a
    # still-ongoing event actually started, not just how much is left.
    started_day: Optional[int] = None

    def __post_init__(self):
        self.days_remaining = self.duration_days
        self.message = self.name
        self.duration = self.duration_days
        self.day = self.started_day
        self.type = "Agent"


# Instantaneous events ("delay", "cargo_loss", "cash_gain", "cash_loss") take
# effect the moment they're rolled and don't need to persist; the two
# ongoing discount types stay active in the agent's active_agent_events list
# for their full duration_days.
AGENT_EVENT_TEMPLATES: List[dict] = [
    dict(name="Engine trouble slows the transport", kind="delay", magnitude=2, duration_days=1),
    dict(name="Customs hold at the dock", kind="delay", magnitude=1, duration_days=1),
    dict(name="Cargo spoilage in transit", kind="cargo_loss", magnitude=0.15, duration_days=1),
    dict(name="Piracy incident", kind="cargo_loss", magnitude=0.4, duration_days=1),
    dict(name="Insurance payout received", kind="cash_gain", magnitude=400.0, duration_days=1),
    dict(name="Unexpected repair bill", kind="cash_loss", magnitude=250.0, duration_days=1),
    dict(name="Favorable tailwinds improve fuel efficiency", kind="fuel_discount", magnitude=0.25, duration_days=6),
    dict(name="Preferred customer rate at the port", kind="fixed_cost_discount", magnitude=0.5, duration_days=8),
]


# EVENT_TEMPLATES above is commodity-specific: each event is drawn from a
# pool tied to one commodity, then applied either LOCALLY (one location's
# market for that commodity) or GLOBALLY (that commodity's market at every
# location that trades it). The two pools below complete the picture with
# commodity-AGNOSTIC shocks -- broad economic/political events that aren't
# about any one commodity, applied either to every market at ONE location
# (LOCATION-WIDE) or to every market in the entire world (WORLDWIDE):
#
#                       one commodity          every commodity
#   one location        EVENT_TEMPLATES        LOCATION_EVENT_TEMPLATES
#                       (local)                (location-wide)
#   every location       EVENT_TEMPLATES        WORLD_EVENT_TEMPLATES
#                       (global)               (worldwide)
LOCATION_EVENT_TEMPLATES: List[dict] = [
    dict(name="Port strike halts local trade", demand_multiplier=1.0, supply_multiplier=0.5, duration_days=5),
    dict(name="Regional economic boom", demand_multiplier=1.3, supply_multiplier=1.0, duration_days=5),
    dict(name="Local political instability", demand_multiplier=0.85, supply_multiplier=0.85, duration_days=6),
    dict(name="Infrastructure upgrade boosts throughput", demand_multiplier=1.0, supply_multiplier=1.25, duration_days=5),
    dict(name="Regional tax holiday spurs local demand", demand_multiplier=1.2, supply_multiplier=1.0, duration_days=4),
]

WORLD_EVENT_TEMPLATES: List[dict] = [
    dict(name="Global recession dampens demand everywhere", demand_multiplier=0.85, supply_multiplier=1.0, duration_days=7),
    dict(name="Worldwide economic boom lifts demand", demand_multiplier=1.2, supply_multiplier=1.0, duration_days=6),
    dict(name="Global shipping crisis squeezes supply chains", demand_multiplier=1.0, supply_multiplier=0.8, duration_days=6),
    dict(name="Landmark global trade agreement", demand_multiplier=1.1, supply_multiplier=1.1, duration_days=5),
    dict(name="Worldwide interest rate hike cools demand", demand_multiplier=0.9, supply_multiplier=1.0, duration_days=6),
]


@dataclass
class LocationClosure(Event):
    """
    A binary shock, distinct from the demand/supply-multiplier events
    above: while active, a location's port is simply CLOSED -- no buying,
    selling, or refueling there at all, for anyone, until it reopens.
    Unlike a MarketEvent this doesn't get attached to a Market; World keeps
    one of these per closed location and consults it directly.
    """
    name: str
    duration_days: int = 1

    def __post_init__(self):
        self.days_remaining = self.duration_days
        self.message = self.name
        self.duration = self.duration_days
        self.type = "Closure"


# Reasons a whole port might shut down completely, regardless of commodity --
# these don't move any price, they just stop all trading there cold until
# the closure runs its course.
LOCATION_CLOSURE_TEMPLATES: List[dict] = [
    dict(name="Quarantine shuts the port to all shipping", duration_days=6),
    dict(name="War disrupts port operations", duration_days=10),
    dict(name="Naval blockade seals the harbor", duration_days=8),
    dict(name="Labor strike halts all port activity", duration_days=4),
    dict(name="Catastrophic storm damage closes the port", duration_days=5),
]
