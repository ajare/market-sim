"""
Location: a trading hub, and the TerminalType kinds of terminal it can have.
"""
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Dict, FrozenSet, List

from .commodity import DEFAULT_BASE_CONSUMPTION_RATE, DEFAULT_BASE_PRICE, DEFAULT_BASE_PRODUCTION_RATE


class TerminalType(Enum):
    Port = auto()
    Station = auto()
    Airport = auto()
    Platform = auto()


@dataclass
class Location:
    """
    A trading hub. A commodity here is either PRODUCED (added to the local
    stockpile every day, sold off as surplus to any Captain who'll take it)
    or CONSUMED (drawn from the stockpile every day, bought from a Captain
    once the stockpile drops below `min_stockpiles`) -- never both at once
    (see __post_init__). Price is driven entirely by how far the current
    stockpile sits from a reference level (see Market._stockpile_price):
    a produced commodity gets cheaper the more of it piles up, a consumed
    commodity gets pricier the further its stockpile falls below its
    minimum, since that's how badly this location wants a Captain to bring
    more of it.
    """
    name: str
    produced_commodities: Dict[str, float]  # commodity_name -> production rate MODIFIER (default 1.0), scaling Commodity.base_production_rate -- see production_rate()
    consumed_commodities: Dict[str, float]  # commodity_name -> consumption rate MODIFIER (default 1.0), scaling Commodity.base_consumption_rate -- see consumption_rate()
    stockpiles: Dict[str, float]            # commodity_name -> current stockpile (produced + consumed)
    min_stockpiles: Dict[str, float]        # commodity_name -> minimum target (consumed commodities only)
    base_price_modifiers: Dict[str, float]  # commodity_name -> price MODIFIER (default 1.0), scaling Commodity.base_price -- see base_price()
    fuel_price: float                       # flat, never-fluctuating Fuel price at this location
    terminal_types: FrozenSet["TerminalType"] = field(default_factory=frozenset)  # which kinds of terminal this location has
    # Fraction of a commodity's live sell price recovered when stolen
    # goods are fenced here (see PirateBrigade._attack in faction.py) --
    # a black-market discount that can vary by location (a lawless port
    # might fence for more than a well-policed one).
    fence_fraction: float = 0.5
    # The stockpile level a PRODUCED commodity's price is measured against
    # (see reference_stockpile) -- frozen at construction time, since the
    # live `stockpiles` value moves every day via production/consumption
    # and trading (see Market.apply_trade) and would otherwise be a moving
    # target to price against.
    _reference_stockpiles: Dict[str, float] = field(init=False, repr=False)

    def __post_init__(self):
        if TerminalType.Platform in self.terminal_types and len(self.terminal_types) > 1:
            raise ValueError(
                f"{self.name}: a Platform terminal can't be combined with any other "
                f"TerminalType, got {sorted(t.name for t in self.terminal_types)}"
            )
        overlap = set(self.produced_commodities) & set(self.consumed_commodities)
        if overlap:
            raise ValueError(
                f"{self.name}: a commodity can't be both produced and consumed "
                f"at the same location, got {sorted(overlap)}"
            )
        self._reference_stockpiles = dict(self.stockpiles)

    def can_buy(self, commodity_name: str) -> bool:
        """A Captain can buy here: commodity is produced here and there's stock to sell."""
        return commodity_name in self.produced_commodities and self.stockpiles.get(commodity_name, 0.0) > 0

    def can_sell(self, commodity_name: str) -> bool:
        """A Captain can sell here: commodity is consumed here and the location is running low."""
        return (commodity_name in self.consumed_commodities
                and self.stockpiles.get(commodity_name, 0.0) < self.min_stockpiles.get(commodity_name, 0.0))

    def production_rate(self, commodity_name: str) -> float:
        """
        This Location's actual units/day production rate for
        commodity_name: the commodity's world_data.COMMODITIES-wide
        base_production_rate times this Location's own modifier (defaults
        to 1.0 if the commodity isn't in produced_commodities at all, or
        falls back to DEFAULT_BASE_PRODUCTION_RATE if the commodity has no
        registry entry at all -- e.g. a custom locations_csv introducing a
        commodity never registered via a matching commodities_csv, mirrors
        Market._stockpile_price's same fallback).
        """
        from . import world_data  # deferred: world_data imports Location, so this must stay a call-time import
        modifier = self.produced_commodities.get(commodity_name, 1.0)
        commodity = world_data.COMMODITIES.get(commodity_name)
        base_rate = commodity.base_production_rate if commodity is not None else DEFAULT_BASE_PRODUCTION_RATE
        return base_rate * modifier

    def consumption_rate(self, commodity_name: str) -> float:
        """This Location's actual units/day consumption rate for commodity_name -- mirrors production_rate()."""
        from . import world_data
        modifier = self.consumed_commodities.get(commodity_name, 1.0)
        commodity = world_data.COMMODITIES.get(commodity_name)
        base_rate = commodity.base_consumption_rate if commodity is not None else DEFAULT_BASE_CONSUMPTION_RATE
        return base_rate * modifier

    def base_price(self, commodity_name: str) -> float:
        """
        This Location's actual reference price for commodity_name: the
        commodity's world_data.COMMODITIES-wide base_price times this
        Location's own modifier (defaults to 1.0 if the commodity isn't in
        base_price_modifiers at all, or falls back to DEFAULT_BASE_PRICE if
        the commodity has no registry entry at all -- mirrors
        production_rate/consumption_rate's same fallback pattern).
        """
        from . import world_data
        modifier = self.base_price_modifiers.get(commodity_name, 1.0)
        commodity = world_data.COMMODITIES.get(commodity_name)
        base = commodity.base_price if commodity is not None else DEFAULT_BASE_PRICE
        return base * modifier

    def reference_stockpile(self, commodity_name: str) -> float:
        """
        The baseline a commodity's price is measured against (see
        Market._stockpile_price): the minimum target for something
        consumed here (falling further below it is what makes the price
        climb), or the starting stockpile for something produced here
        (piling up further above it is what makes the price fall).
        """
        if commodity_name in self.consumed_commodities:
            return self.min_stockpiles.get(commodity_name, 0.0)
        return self._reference_stockpiles.get(commodity_name, 0.0)

    def daily_update(self) -> None:
        """Apply one day of production/consumption to stockpiles (floored at 0)."""
        for commodity in self.produced_commodities:
            self.stockpiles[commodity] = self.stockpiles.get(commodity, 0.0) + self.production_rate(commodity)
        for commodity in self.consumed_commodities:
            self.stockpiles[commodity] = max(0.0, self.stockpiles.get(commodity, 0.0) - self.consumption_rate(commodity))
