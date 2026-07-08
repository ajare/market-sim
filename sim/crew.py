"""
Crew: base class for anyone who operates a Transport.
"""
from typing import Optional

from .transport import Transport


class Crew:
    """
    Bare identity/assignment layer: just a name and which Transport (if
    any) this Crew member currently runs. Holds nothing about strategy,
    money, or physical location -- Captain (see captain.py) subclasses
    this and adds all of that trading-agent behavior on top.
    """

    def __init__(self, name: str, transport: Optional[Transport] = None, daily_wages: float = 0.0):
        self.name = name
        self.transport = transport
        # Per-day cost to the Faction that owns this Crew member's
        # Transport, owed only while that Transport is actually underway
        # (see Captain._daily_crew_cost / Captain.act -- idle time in
        # port is free) -- and factored into route profitability
        # alongside fuel and fixed fees (see Captain._route_economics).
        # If the Faction can't afford it on a given day, the Transport
        # goes TransportStatus.Inactive until it can.
        self.daily_wages = daily_wages


class Sailor(Crew):
    """
    A generic deckhand: fills out a Transport's crew_requirement beyond
    its Captain (who is itself a Crew member and costs nothing extra by
    default). Used by Faction.__init__ to pad out a Transport's roster
    when crew_requirement > 1, since there's no other information there
    about who these additional Crew members are.
    """

    def __init__(self, name: str, transport: Optional[Transport] = None, daily_wages: float = 20.0):
        super().__init__(name, transport=transport, daily_wages=daily_wages)
