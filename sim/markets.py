"""
Per-(location, commodity, side) Market: stockpile-driven pricing and the
day-to-day price update.
"""
import random
from typing import List, Optional

from .events import MarketEvent, EVENT_TEMPLATES
from .location import Location

# How strongly a commodity's price reacts to its stockpile sitting away from
# its reference level (see Market._stockpile_price) -- e.g. 0.6 means a
# stockpile fully depleted (or, symmetrically, doubled) relative to its
# reference moves price by 60%. Larger values make a commodity's price swing
# harder on the same deficit/surplus.
PRICE_SENSITIVITY = {
    "Crude Oil": 0.6, "Copper": 0.5, "Wheat": 0.45, "Gold": 0.25, "Silver": 0.35,
    "Natural Gas": 0.55, "Coffee": 0.45, "Cotton": 0.45, "Iron Ore": 0.45, "Aluminum": 0.45,
}

# Fallback sensitivity for a commodity with no explicit entry above -- lets a
# custom commodities_csv (see main()) introduce commodities this dict was
# never hand-tuned for without crashing.
DEFAULT_PRICE_SENSITIVITY = 0.45


# ---------------------------------------------------------------------------
# Market (a single commodity traded at a single location)
# ---------------------------------------------------------------------------

class Market:
    def __init__(self, commodity_name: str, location_name: str, location: Location,
                 starting_price: float, base_price: float, side: str,
                 event_probability: float = 0.10, fixed_price: bool = False):
        self.commodity_name = commodity_name
        self.location_name = location_name
        # The Location this Market's price/availability is actually derived
        # from (see _stockpile_price/is_available/available_quantity) --
        # `location_name` is kept alongside it purely because so much
        # existing code (reports, dict keys, exp-ui) already reasons about
        # markets by name.
        self.location = location
        self.side = side  # "buy" or "sell" -- which side of trade this market represents
        self.price = starting_price
        # The reference price a commodity's stockpile deviation is measured
        # against (see _stockpile_price) -- distinct from `price`, which
        # moves day to day.
        self.base_price = base_price
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
        # How much was actually bought/sold through this Market today (see
        # apply_trade) -- accumulated as Captains trade, read into the daily
        # record, then reset by simulate_day for the next day.
        self._volume_traded_today = 0.0

    @property
    def is_available(self) -> bool:
        """Whether a Captain can trade here RIGHT NOW: always true for the
        flat, unlimited Fuel market, otherwise driven by the location's
        current stockpile position (see Location.can_buy/can_sell)."""
        if self.fixed_price:
            return True
        if self.side == "buy":
            return self.location.can_buy(self.commodity_name)
        return self.location.can_sell(self.commodity_name)

    @property
    def available_quantity(self) -> float:
        """
        How much can actually be bought here today. A produced commodity's
        surplus is a hard physical cap (a Captain can't buy more than is
        sitting in the stockpile); a consumed commodity's deficit isn't --
        a location will always accept a full delivery while it's running
        low (see apply_trade), so there's no cap on that side. Fuel is
        never stockpile-limited either.
        """
        if self.side == "buy" and not self.fixed_price:
            return self.location.stockpiles.get(self.commodity_name, 0.0)
        return float("inf")

    def apply_trade(self, quantity: float) -> None:
        """
        A Captain's trade physically moves the location's stockpile: buying
        (side == "buy") draws down a produced commodity's surplus; selling
        (side == "sell") fills a consumed commodity's deficit. No-op for a
        fixed-price market -- Fuel isn't tracked as a stockpile.
        """
        if self.fixed_price:
            return
        if self.side == "buy":
            self.location.stockpiles[self.commodity_name] = max(
                0.0, self.location.stockpiles.get(self.commodity_name, 0.0) - quantity)
        else:
            self.location.stockpiles[self.commodity_name] = \
                self.location.stockpiles.get(self.commodity_name, 0.0) + quantity
        self._volume_traded_today += quantity

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

    def _stockpile_price(self) -> float:
        """
        Price is driven by how far the current stockpile sits from its
        reference level (see Location.reference_stockpile): below the
        reference (a consumed commodity running low, or a produced one
        that's been sold down) pushes price up; above it (a consumed
        commodity that's been topped up, or a produced one piling up
        unsold) pushes price down.
        """
        reference = self.location.reference_stockpile(self.commodity_name)
        if reference <= 0:
            return self.base_price
        current = self.location.stockpiles.get(self.commodity_name, 0.0)
        deviation = max(-2.0, min(2.0, (reference - current) / reference))
        sensitivity = PRICE_SENSITIVITY.get(self.commodity_name, DEFAULT_PRICE_SENSITIVITY)
        return max(0.5, self.base_price * (1 + sensitivity * deviation))

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
                "stockpile": 0.0,
                "reference_stockpile": 0.0,
                "volume_traded": round(self._volume_traded_today, 2),
                "demand_multiplier": 0.0,
                "supply_multiplier": 0.0,
                "active_events": "",
                "new_event": "",
                "closed": not is_open,
            }
            self.history.append(record)
            self._volume_traded_today = 0.0
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
                "stockpile": round(self.location.stockpiles.get(self.commodity_name, 0.0), 2),
                "reference_stockpile": round(self.location.reference_stockpile(self.commodity_name), 2),
                "volume_traded": round(self._volume_traded_today, 2),
                "demand_multiplier": 0.0,
                "supply_multiplier": 0.0,
                "active_events": ", ".join(e.name for e in self.active_events) if self.active_events else "",
                "new_event": "",
                "closed": True,
            }
            self.history.append(record)
            self._update_events()
            self._volume_traded_today = 0.0
            return record

        triggered_event = self._maybe_trigger_local_event()
        if triggered_event is not None:
            triggered_event.day = day
            self.last_triggered_event = triggered_event
        demand_mult, supply_mult = self._current_multipliers()

        new_price = self._stockpile_price() * demand_mult / supply_mult
        noise = random.gauss(0, 0.01)
        new_price *= (1 + noise)
        new_price = max(0.5, new_price)

        record = {
            "day": day,
            "location": self.location_name,
            "commodity": self.commodity_name,
            "side": self.side,
            "price": round(self.price, 2),
            "stockpile": round(self.location.stockpiles.get(self.commodity_name, 0.0), 2),
            "reference_stockpile": round(self.location.reference_stockpile(self.commodity_name), 2),
            "volume_traded": round(self._volume_traded_today, 2),
            "demand_multiplier": round(demand_mult, 2),
            "supply_multiplier": round(supply_mult, 2),
            "active_events": ", ".join(e.name for e in self.active_events) if self.active_events else "",
            "new_event": triggered_event.name if triggered_event else "",
            "closed": False,
        }
        self.history.append(record)

        self.price = new_price
        self._update_events()
        self._volume_traded_today = 0.0

        return record
