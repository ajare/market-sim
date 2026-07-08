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
    A trading hub. The commodities you can BUY here and the commodities you
    can SELL here are tracked separately -- a location might produce/export
    a commodity (so it's buyable there) without also being a market willing
    to take it off your hands (so it might not be sellable there), and vice
    versa. Where a commodity is both buyable and sellable at the same
    location, the two sides can still carry different prices (a local
    bid/ask spread), since `buy_prices` and `sell_prices` are independent
    dictionaries.
    """
    name: str
    buyable_commodities: List[str]
    sellable_commodities: List[str]
    buy_prices: Dict[str, float]   # commodity_name -> local price to ACQUIRE it here
    sell_prices: Dict[str, float]  # commodity_name -> local price received when OFFLOADING it here
    terminal_types: FrozenSet["TerminalType"] = field(default_factory=frozenset)  # which kinds of terminal this location has
    # Fraction of a commodity's live sell price recovered when stolen
    # goods are fenced here (see PirateBrigade._attack in faction.py) --
    # a black-market discount that can vary by location (a lawless port
    # might fence for more than a well-policed one).
    fence_fraction: float = 0.5

    def __post_init__(self):
        if TerminalType.Platform in self.terminal_types and len(self.terminal_types) > 1:
            raise ValueError(
                f"{self.name}: a Platform terminal can't be combined with any other "
                f"TerminalType, got {sorted(t.name for t in self.terminal_types)}"
            )

    def can_buy(self, commodity_name: str) -> bool:
        return commodity_name in self.buyable_commodities

    def can_sell(self, commodity_name: str) -> bool:
        return commodity_name in self.sellable_commodities
