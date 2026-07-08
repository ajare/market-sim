"""
Location: a trading hub, and the TerminalType kinds of terminal it can have.
"""
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Dict, FrozenSet, List


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
    produced_commodities: Dict[str, float]  # commodity_name -> production rate/day, added to stockpile
    consumed_commodities: Dict[str, float]  # commodity_name -> consumption rate/day, drawn from stockpile
    stockpiles: Dict[str, float]            # commodity_name -> current stockpile (produced + consumed)
    min_stockpiles: Dict[str, float]        # commodity_name -> minimum target (consumed commodities only)
    base_prices: Dict[str, float]           # commodity_name -> reference price (produced + consumed)
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
        for commodity, rate in self.produced_commodities.items():
            self.stockpiles[commodity] = self.stockpiles.get(commodity, 0.0) + rate
        for commodity, rate in self.consumed_commodities.items():
            self.stockpiles[commodity] = max(0.0, self.stockpiles.get(commodity, 0.0) - rate)
