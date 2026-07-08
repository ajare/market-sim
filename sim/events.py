"""
Random external events: market-wide demand/supply shocks (MarketEvent),
per-transport shocks (TransportEvent), whole-Company cash shocks
(CompanyEvent), and whole-port shutdowns (LocationClosure).
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
    (MarketEvent, TransportEvent, CompanyEvent, LocationClosure). Each
    subclass keeps its own domain-specific fields (e.g. MarketEvent's
    `name`/`duration_days`) so existing call sites and reporting code don't
    need to change, but every subclass's __post_init__ populates this shared
    `type`/`scope`/`subject`/`day`/`duration`/`message` view -- `type`
    categorizes the event (e.g. "Global"/"Local" for a MarketEvent, "Agent",
    "Company", "Closure"), `scope` is how broadly it applies: a Location's
    name for anything tied to one location (a Local MarketEvent, a
    Location-wide MarketEvent, or a LocationClosure), "Global" for anything
    with no single-location focus (a Global commodity-wide MarketEvent or a
    Worldwide one), "Transport" for a TransportEvent, or "Company" for a
    CompanyEvent. `subject` is the specific thing the event is about: a
    commodity name for a MarketEvent (blank for a Location-wide/Worldwide
    one, which isn't about any single commodity), a Captain's name for a
    TransportEvent, a Company's name for a CompanyEvent, or a Location's
    name for a LocationClosure. `day` is when it started, `duration` is how
    many days it lasts, and `message` is the human-readable description.
    The day-by-day `days_remaining` bookkeeping and `tick()` are shared here
    too.
    """
    type: str = field(init=False, default="")
    scope: str = field(init=False, default="")
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
        return f"[{self.type}] {self.scope}: {self.message} ({day_str}{self.days_remaining}/{self.duration}d remaining)"


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
    # The commodity this event is about -- known (and passed by the caller)
    # for a Local or Global commodity-wide event; left None for a
    # Location-wide or Worldwide one, which isn't about any single
    # commodity (see World._maybe_trigger_location_event/_maybe_trigger_worldwide_event).
    commodity: Optional[str] = None

    def __post_init__(self):
        self.days_remaining = self.duration_days
        self.message = self.name
        self.duration = self.duration_days
        # A Local event is scoped to its one location; a Global commodity
        # event or a Worldwide one (both constructed with location=None,
        # see World._maybe_trigger_global_event/_maybe_trigger_worldwide_event)
        # both scope to "Global" -- neither is about any single location.
        self.scope = self.location if self.location else "Global"
        self.type = "Local" if self.location else "Global"
        self.subject = self.commodity or ""


# Per-commodity event templates now live on Commodity.event_templates (see
# commodity.py / world_data.COMMODITIES) instead of a separate dict here --
# Market._maybe_trigger_local_event / World._maybe_trigger_global_event read
# world_data.COMMODITIES[name].event_templates.


@dataclass
class TransportEvent(Event):
    """
    A random shock that hits a specific TRANSPORT rather than a market --
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
    # NOTE: `subject` (the Captain's name) isn't set here -- a TransportEvent
    # is built generically from a template before it's tied to any
    # particular agent, so Captain._apply_agent_event stamps it once it is.

    def __post_init__(self):
        self.days_remaining = self.duration_days
        self.message = self.name
        self.duration = self.duration_days
        self.day = self.started_day
        self.type = "Agent"
        # Always "Transport" -- a TransportEvent hits one specific Transport,
        # but WHICH one isn't part of scope (see Captain._apply_agent_event/
        # Captain.event_log for that).
        self.scope = "Transport"


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


@dataclass
class CompanyEvent(Event):
    """
    A random shock that hits a whole Company's shared cash pool directly --
    a windfall or a setback that isn't tied to any single Transport or
    market. Only ever rolled for a plain Company (see
    World._maybe_trigger_company_event) -- never a SoloTrader (its captains
    don't share a pool to hit), a PirateBrigade, or a PoliceFleet. `kind`
    determines how the magnitude is applied to the Company's pooled cash:

      - "cash_gain": added to the pool.
      - "cash_loss": subtracted from the pool (floored at 0).
    """
    name: str
    kind: str
    magnitude: float
    duration_days: int = 1

    def __post_init__(self):
        self.days_remaining = self.duration_days
        self.message = self.name
        self.duration = self.duration_days
        self.type = "Company"
        # Always "Company" -- scoped to one Company's shared pool, same way
        # a TransportEvent always scopes to "Transport". `subject` (which
        # Company) is stamped by World._maybe_trigger_company_event once
        # it's known, the same way Captain._apply_agent_event stamps a
        # TransportEvent's subject.
        self.scope = "Company"


# Company-wide cash windfalls/setbacks -- deliberately one-off
# (duration_days=1) since there's no notion of an ongoing discount at the
# whole-Company level the way TransportEvent's "fuel_discount"/
# "fixed_cost_discount" work per-Transport.
COMPANY_EVENT_TEMPLATES: List[dict] = [
    dict(name="Insurance settlement received", kind="cash_gain", magnitude=5000.0, duration_days=1),
    dict(name="Favorable trade financing arranged", kind="cash_gain", magnitude=2500.0, duration_days=1),
    dict(name="Government subsidy for fleet modernization", kind="cash_gain", magnitude=6000.0, duration_days=1),
    dict(name="Regulatory fine for safety violations", kind="cash_loss", magnitude=3000.0, duration_days=1),
    dict(name="Corporate tax audit settlement", kind="cash_loss", magnitude=4000.0, duration_days=1),
    dict(name="Embezzlement scandal costs the company", kind="cash_loss", magnitude=5500.0, duration_days=1),
]


# Commodity.event_templates (see commodity.py / world_data.COMMODITIES) is
# commodity-specific: each event is drawn from a pool tied to one commodity,
# then applied either LOCALLY (one location's market for that commodity) or
# GLOBALLY (that commodity's market at every location that trades it). The
# two pools below complete the picture with commodity-AGNOSTIC shocks --
# broad economic/political events that aren't about any one commodity,
# applied either to every market at ONE location (LOCATION-WIDE) or to
# every market in the entire world (WORLDWIDE):
#
#                       one commodity              every commodity
#   one location        Commodity.event_templates  LOCATION_EVENT_TEMPLATES
#                       (local)                    (location-wide)
#   every location       Commodity.event_templates  WORLD_EVENT_TEMPLATES
#                       (global)                   (worldwide)
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
