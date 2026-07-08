"""
Per-(location, commodity, side) Market: buyer/seller generation and the
day-to-day price-clearing (tatonnement) mechanism.
"""
import random
from typing import List, Optional, Tuple

from .events import Buyer, Seller, MarketEvent, EVENT_TEMPLATES

COMMODITY_PROFILES = {
    "Crude Oil":    dict(demand_qty=(20, 45), supply_qty=(20, 45), price_spread=0.35, sensitivity=(0.8, 1.8)),
    "Copper":       dict(demand_qty=(15, 40), supply_qty=(15, 40), price_spread=0.30, sensitivity=(0.8, 1.8)),
    "Wheat":        dict(demand_qty=(30, 60), supply_qty=(30, 60), price_spread=0.25, sensitivity=(0.8, 2.0)),
    "Gold":         dict(demand_qty=(3, 10),  supply_qty=(3, 10),  price_spread=0.15, sensitivity=(0.6, 1.5)),
    "Fuel":         dict(demand_qty=(50, 120), supply_qty=(50, 120), price_spread=0.20, sensitivity=(0.7, 1.6)),
    "Silver":       dict(demand_qty=(10, 25), supply_qty=(10, 25), price_spread=0.20, sensitivity=(0.7, 1.7)),
    "Natural Gas":  dict(demand_qty=(40, 90), supply_qty=(40, 90), price_spread=0.30, sensitivity=(0.8, 1.8)),
    "Coffee":       dict(demand_qty=(25, 55), supply_qty=(25, 55), price_spread=0.25, sensitivity=(0.8, 1.9)),
    "Cotton":       dict(demand_qty=(30, 60), supply_qty=(30, 60), price_spread=0.25, sensitivity=(0.8, 1.9)),
    "Iron Ore":     dict(demand_qty=(15, 35), supply_qty=(15, 35), price_spread=0.25, sensitivity=(0.8, 1.8)),
    "Aluminum":     dict(demand_qty=(20, 45), supply_qty=(20, 45), price_spread=0.25, sensitivity=(0.8, 1.8)),
}

# Fallback profile for a commodity with no explicit entry above -- lets a
# custom commodities_csv (see load_commodities_csv / main()) introduce
# commodities this dict was never hand-tuned for without crashing.
DEFAULT_COMMODITY_PROFILE = dict(demand_qty=(20, 45), supply_qty=(20, 45), price_spread=0.25, sensitivity=(0.8, 1.8))

BUYER_ROLE_NAMES = ["Industrial Buyer", "Retail Distributor", "Export Trader", "Speculative Fund"]
SELLER_ROLE_NAMES = ["Primary Producer", "Independent Supplier", "State Reserve", "Cooperative"]


def generate_buyers_and_sellers(commodity_name: str, base_price: float,
                                 location_name: str, num_buyers: int = 3,
                                 num_sellers: int = 3) -> Tuple[List[Buyer], List[Seller]]:
    """Auto-generate a handful of buyers/sellers around a commodity's local base price."""
    profile = COMMODITY_PROFILES.get(commodity_name, DEFAULT_COMMODITY_PROFILE)
    spread = profile["price_spread"]
    lo_sens, hi_sens = profile["sensitivity"]

    buyers = []
    for i in range(num_buyers):
        role = BUYER_ROLE_NAMES[i % len(BUYER_ROLE_NAMES)]
        max_price = base_price * random.uniform(1.05, 1 + spread * 1.5)
        demand = random.uniform(*profile["demand_qty"])
        sensitivity = random.uniform(lo_sens, hi_sens)
        buyers.append(Buyer(
            name=f"{location_name} {role} {i + 1}",
            max_price=round(max_price, 2),
            base_demand=round(demand, 1),
            price_sensitivity=round(sensitivity, 2),
        ))

    sellers = []
    for i in range(num_sellers):
        role = SELLER_ROLE_NAMES[i % len(SELLER_ROLE_NAMES)]
        min_price = base_price * random.uniform(1 - spread * 1.5, 0.95)
        supply = random.uniform(*profile["supply_qty"])
        sensitivity = random.uniform(lo_sens, hi_sens)
        sellers.append(Seller(
            name=f"{location_name} {role} {i + 1}",
            min_price=round(max(0.5, min_price), 2),
            base_supply=round(supply, 1),
            price_sensitivity=round(sensitivity, 2),
        ))

    return buyers, sellers


# ---------------------------------------------------------------------------
# Market (a single commodity traded at a single location)
# ---------------------------------------------------------------------------

class Market:
    def __init__(self, commodity_name: str, location_name: str, buyers: List[Buyer],
                 sellers: List[Seller], starting_price: float, side: str,
                 event_probability: float = 0.10, fixed_price: bool = False):
        self.commodity_name = commodity_name
        self.location_name = location_name
        self.side = side  # "buy" or "sell" -- which side of trade this market represents
        self.buyers = buyers
        self.sellers = sellers
        self.price = starting_price
        self.event_probability = event_probability
        # Fuel is priced identically everywhere and never fluctuates (see
        # World.__init__, which sets this True only for Fuel's buy market) --
        # simulate_day skips clearing/events entirely for a fixed-price
        # market, so self.price never moves from its starting value.
        self.fixed_price = fixed_price
        self.active_events: List[MarketEvent] = []
        self.history = []  # list of dicts, one per day
        # The MarketEvent (if any) _maybe_trigger_local_event rolled on the
        # most recent simulate_day() call -- None otherwise. Lets a caller
        # (e.g. World.event_log) pick up just-triggered LOCAL events without
        # re-deriving them from `active_events`, which also holds events
        # rolled on earlier days that are still ticking down.
        self.last_triggered_event: Optional[MarketEvent] = None

    def _current_multipliers(self):
        demand_mult = 1.0
        supply_mult = 1.0
        for event in self.active_events:
            demand_mult *= event.demand_multiplier
            supply_mult *= event.supply_multiplier
        return demand_mult, supply_mult

    def apply_event(self, event: MarketEvent):
        if self.fixed_price:
            return  # a fixed-price market never clears, so an event here would sit forever
        self.active_events.append(event)

    def _maybe_trigger_local_event(self):
        """Randomly trigger a LOCAL event (scoped to this location only)."""
        if random.random() < self.event_probability:
            template = random.choice(EVENT_TEMPLATES[self.commodity_name])
            event = MarketEvent(**template, location=self.location_name)
            self.apply_event(event)
            return event
        return None

    def _update_events(self):
        self.active_events = [e for e in self.active_events if e.tick()]

    def _clear_market(self, demand_mult: float, supply_mult: float):
        """
        Compute aggregate demand/supply at the current price, then nudge the
        price toward equilibrium based on the imbalance (a simple tatonnement
        process rather than a full order book).
        """
        total_demand = sum(b.quantity_demanded(self.price, demand_mult) for b in self.buyers)
        total_supply = sum(s.quantity_supplied(self.price, supply_mult) for s in self.sellers)

        volume_traded = min(total_demand, total_supply)

        if total_demand + total_supply > 0:
            imbalance = (total_demand - total_supply) / (total_demand + total_supply)
        else:
            imbalance = 0.0

        adjustment_speed = 0.08
        new_price = self.price * (1 + adjustment_speed * imbalance)

        noise = random.gauss(0, 0.01)
        new_price *= (1 + noise)

        new_price = max(0.5, new_price)

        return new_price, total_demand, total_supply, volume_traded

    def simulate_day(self, day: int, is_open: bool = True):
        self.last_triggered_event = None
        if self.fixed_price:
            # No clearing, no events, no price movement -- just a flat daily
            # record so this market's history reads the same shape as every
            # other market's (see build_*_daily_reports / plot_by_commodity).
            record = {
                "day": day,
                "location": self.location_name,
                "commodity": self.commodity_name,
                "side": self.side,
                "price": round(self.price, 2),
                "demand": 0.0,
                "supply": 0.0,
                "volume_traded": 0.0,
                "demand_multiplier": 0.0,
                "supply_multiplier": 0.0,
                "active_events": "",
                "new_event": "",
                "closed": not is_open,
            }
            self.history.append(record)
            return record

        if not is_open:
            # Port closed: no trading happens here today. Price is frozen,
            # no new local event rolls (nothing new is "happening" at a
            # shuttered port), but any events already active keep ticking
            # down in the background -- they'll matter again once it reopens.
            record = {
                "day": day,
                "location": self.location_name,
                "commodity": self.commodity_name,
                "side": self.side,
                "price": round(self.price, 2),
                "demand": 0.0,
                "supply": 0.0,
                "volume_traded": 0.0,
                "demand_multiplier": 0.0,
                "supply_multiplier": 0.0,
                "active_events": ", ".join(e.name for e in self.active_events) if self.active_events else "",
                "new_event": "",
                "closed": True,
            }
            self.history.append(record)
            self._update_events()
            return record

        triggered_event = self._maybe_trigger_local_event()
        if triggered_event is not None:
            triggered_event.day = day
            self.last_triggered_event = triggered_event
        demand_mult, supply_mult = self._current_multipliers()

        new_price, total_demand, total_supply, volume_traded = self._clear_market(demand_mult, supply_mult)

        record = {
            "day": day,
            "location": self.location_name,
            "commodity": self.commodity_name,
            "side": self.side,
            "price": round(self.price, 2),
            "demand": round(total_demand, 2),
            "supply": round(total_supply, 2),
            "volume_traded": round(volume_traded, 2),
            "demand_multiplier": round(demand_mult, 2),
            "supply_multiplier": round(supply_mult, 2),
            "active_events": ", ".join(e.name for e in self.active_events) if self.active_events else "",
            "new_event": triggered_event.name if triggered_event else "",
            "closed": False,
        }
        self.history.append(record)

        self.price = new_price
        self._update_events()

        return record
