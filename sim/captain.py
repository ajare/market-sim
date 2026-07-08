"""
Captain: a profit-seeking agent that buys low and sells high, running a
single Transport between locations.
"""
import csv
import random
from typing import Dict, List, Optional, Tuple

import matplotlib.pyplot as plt

from .events import AgentEvent, AGENT_EVENT_TEMPLATES
from .transport import Transport, Ship, TransportStatus
from .world_data import distance_between, travel_days_between
from .routes import get_route, Route
from .pathfinding import find_shortest_path, path_node_sequence
from .crew import Crew


class Captain(Crew):
    """
    A speculative agent modeled as a captain running a single Transport
    (see Transport / Ship above) that occupies exactly one location at a
    time. It can only BUY a commodity at the location it is currently
    sitting in, and can only SELL a commodity once it has physically
    traveled to a location that will take it. There is no teleportation
    and no parallel shipments: while `status == TransportStatus.InTransit` the agent
    is committed to its chosen destination and can't act again until it
    arrives.

    The Transport (Ship today; any other Transport subclass works too)
    supplies all the physical/mechanical numbers -- cargo capacity,
    speed, and fuel efficiency (loaded and ballast) -- while this class
    holds the trading strategy: cash, risk threshold, price impact, and
    event exposure. Swap in a different Transport to see how the same
    strategy performs with different hardware, or share one Transport
    preset across many agents without duplicating its specs.

    Each time the agent is in port with empty cargo, it plans its next
    route: it looks ONLY at commodities buyable right where it's standing,
    checks every OTHER location that would buy that commodity from it, and
    picks whichever (commodity, destination) pairing clears its return
    threshold with the best expected daily return. It then buys as much as
    it can afford/carry, departs, and cannot do anything else until the
    voyage completes -- at which point it sells immediately and plans its
    next route from the new location. If nothing at the current location
    clears the bar, the agent simply waits in port and re-evaluates the
    next day (it does not reposition empty-handed).

    Two real-world frictions are modeled explicitly:

      - TRAVEL TIME: locations are not equally far apart (see distance_between).
        The voyage takes `travel_days_between(...)` days at the transport's own
        speed, during which the agent is unavailable to trade and its
        capital is tied up.
      - FUEL COST: Fuel is itself a tradeable commodity with its own local
        market (and its own events, e.g. refinery outages or bunkering
        demand surges) at every location. A voyage consumes
        `distance * transport.fuel_consumption_per_unit_distance * quantity`
        units of fuel, purchased at the ORIGIN's *current* fuel price -- so
        the same route gets cheaper or pricier over time as local fuel
        supply/demand shifts. Buying that fuel also nudges the local fuel
        price up, the same way buying the cargo commodity does. A flat
        `transport.fixed_shipment_cost` (loading/customs fee) is charged on top,
        regardless of quantity. Fuel, purchase price, and the fixed fee are
        all paid upfront when the voyage departs.

    Because a long, expensive route can still look attractive on raw price
    gap alone, the agent ranks candidate routes by *expected profit per day
    of capital tied up* (a simple daily return rate) rather than by the
    price gap itself, and only departs on routes that clear
    `min_daily_return_pct`. This means it will pass up a wide-but-slow-and-
    costly route in favor of a narrower-but-fast-and-cheap one, and will
    stay in port entirely if fuel and fixed costs eat the whole spread.

    The agent is a price-taker: it buys/sells at the market's current
    price, but its trades also nudge that price a little (buying pushes
    price up, selling pushes price down) so its own activity narrows the
    gap it is exploiting -- just like a real arbitrageur competing away
    an inefficiency. The sale price actually realized on arrival may differ
    from the price observed at departure, since the market keeps moving
    during transit -- that risk is part of what the daily-return threshold
    is meant to compensate for.

    REPOSITIONING: if nothing at the current port clears the return bar,
    the agent doesn't just idle -- it scans the *entire* network for the
    single best (commodity, origin, destination) opportunity anywhere else
    and, if sailing there empty and then executing that trade would still
    clear a return bar once the extra travel and ballast fuel are priced
    in, it departs empty toward that origin instead of waiting. Because
    this is a bet on an opportunity that might not survive the extra transit
    time, the bar for repositioning (`min_daily_return_pct *
    reposition_return_multiplier`) is set higher than for a trade it could
    execute immediately.

    AGENT-SPECIFIC EVENTS: separately from market-wide events, the agent
    itself can be hit by its own random shocks each day -- see AgentEvent /
    AGENT_EVENT_TEMPLATES. These don't move any market price; they change
    what the SHIP can do: mechanical trouble or customs holds cost it days,
    piracy or spoilage costs it cargo, windfalls and repair bills move cash
    directly, and temporary discounts make its next several voyages cheaper
    to fuel or fix a price on. They're rolled independently of MarketEvents
    and of any other agent in the simulation.
    """

    def __init__(self, name: str, home_location: str,
                 starting_cash: Optional[float] = None,
                 reposition_return_multiplier: float = 1.25,
                 min_daily_return_pct: float = 0.02, price_impact: float = 0.01,
                 agent_event_probability: float = 0.05, carousing: float = 0.0):
        super().__init__(name)
        # How distracted/incapacitated this Captain's crew currently is
        # from carousing in port (drinking, gambling, general shore
        # leave) -- purely decorative for most agents, but a
        # PirateBrigade-owned Captain won't attack a co-located victim
        # while it's too high (see PirateBrigade.max_carousing_to_attack
        # / _co_located_target). Nothing in this class raises or lowers
        # it automatically; callers own that.
        self.carousing = carousing
        # Funds now belong to whichever Company owns this transport, not the
        # transport itself -- see the `cash` property below. `self._cash` is
        # only ever read/written directly when this trader has NO Company
        # (a fully independent agent), in which case it behaves exactly
        # like the old per-trader cash. `starting_cash` is therefore
        # optional: pass it for an independent trader; leave it out (or
        # pass None) for a transport that will be handed to a Company, since
        # the Company is given its own `starting_cash` instead.
        self._cash = starting_cash if starting_cash is not None else 0.0
        self.starting_cash = starting_cash  # None if funds live on a Company instead
        # How much more attractive a distant opportunity must look (vs.
        # min_daily_return_pct) before the agent will gamble on chasing it.
        self.reposition_return_multiplier = reposition_return_multiplier
        self.min_daily_return_pct = min_daily_return_pct
        self.price_impact = price_impact
        self.agent_event_probability = agent_event_probability
        self.company: Optional["Faction"] = None  # set by Faction/Company, if one owns this transport

        # Physical state: where the agent is, what it's doing, and what
        # (if anything) it's carrying. Only ONE journey/cargo at a time --
        # for a fleet, create multiple Captain instances instead.
        self.location = home_location
        # Where along `self.path` the ship currently sits (or has most
        # recently departed from) -- kept equal to `self.location` at all
        # times (see _arrive / _execute_local_route), tracked as its own
        # attribute since it's specifically the anchor `self.path` is
        # measured from, distinct from `self.location`'s general use
        # throughout this class as "where the agent is right now."
        self.current_node: str = home_location
        self.destination: Optional[str] = None
        self.days_remaining: int = 0
        self.cargo: Optional[dict] = None
        # The remaining Route edges of the current Dijkstra-planned voyage
        # (see sim.pathfinding.find_shortest_path / _route_economics),
        # NOT including the leg currently being traveled (that one's
        # already committed to via self.destination/days_remaining) --
        # popped one at a time as each intermediate node is reached (see
        # _arrive). Empty once only the final leg remains.
        self.path: List[Route] = []
        # This leg's fuel burn per day of travel, applied to
        # self.transport.current_fuel once per day while in transit (see
        # act()) -- set whenever a voyage (loaded or empty) departs, and
        # irrelevant for a Transport that doesn't track fuel (current_fuel
        # is None, see Transport.consume_fuel).
        self._daily_fuel_burn: float = 0.0

        # Agent-specific events: instantaneous ones (delay/cargo_loss/cash)
        # are applied the moment they're rolled; the two discount kinds stay
        # active here and tick down like MarketEvents do on a Market.
        self.active_agent_events: List[AgentEvent] = []
        # Every AgentEvent ever rolled for this Captain, instantaneous or
        # persisting alike, kept forever (unlike active_agent_events, which
        # only tracks the still-ongoing discount kinds) -- lets a caller
        # (e.g. World.event_log) see the full history of what happened to
        # this agent, not just what's still in effect.
        self.event_log: List[AgentEvent] = []
        self.grounded_days_remaining: int = 0  # extra days stuck at the dock
        self.agent_event_log: List[dict] = []  # every agent event that fired

        self.trade_log: List[dict] = []   # every buy/sell/reposition action taken
        self.realized_profit = 0.0
        self.total_fuel_spent = 0.0
        self.total_fuel_units_consumed = 0.0
        self.total_fixed_fees_spent = 0.0
        self.total_repositions = 0
        self.portfolio_history: List[dict] = []  # daily snapshot of net worth

    @property
    def cash(self) -> float:
        """
        Available funds. A transport owned by a Faction (Company or otherwise)
        draws from and pays into that Faction's single shared pool
        (self.company.cash); an independent transport (no Faction) keeps its
        own private balance in self._cash. Every existing
        buy/sell/reposition/event code path just reads and writes
        `self.cash` as before, so this swap is transparent to them --
        pooling now happens automatically, since sister ships literally
        share the same underlying number.
        """
        if self.company is not None and self.company.pools_cash:
            return self.company.cash
        return self._cash

    @cash.setter
    def cash(self, value: float):
        if self.company is not None and self.company.pools_cash:
            self.company.cash = value
        else:
            self._cash = value

    @property
    def status(self) -> TransportStatus:
        """
        TransportStatus.AtLocation or TransportStatus.InTransit. This
        lives on the Transport (see Transport.status), not the Captain,
        since it's physical state of the vehicle itself -- the agent's
        trading strategy has no bearing on whether the ship is currently
        docked or underway. Kept as a Captain property so every existing
        read/write of `self.status` throughout this class stays unchanged.
        """
        return self.transport.status

    @status.setter
    def status(self, value: TransportStatus):
        self.transport.status = value

    def _apply_price_impact(self, market: "Market", units: float, direction: str):
        """Buying nudges price up; selling nudges price down, proportional to size.
        No-op for a fixed_price market (e.g. Fuel) -- see Market.fixed_price --
        which never moves regardless of how much of it gets bought or sold."""
        if market.fixed_price:
            return
        magnitude = self.price_impact * units / (units + 50.0)
        if direction == "buy":
            market.price = market.price * (1 + magnitude)
        else:
            market.price = max(0.5, market.price * (1 - magnitude))

    def _active_discount(self, kind: str) -> float:
        """Sum of magnitudes from currently-active agent events of one kind, capped at 90%."""
        total = sum(e.magnitude for e in self.active_agent_events if e.kind == kind)
        return min(0.9, total)

    def _current_fuel_consumption_rate(self) -> float:
        return self.transport.fuel_consumption_per_unit_distance * (1 - self._active_discount("fuel_discount"))

    def _current_reposition_fuel_rate(self) -> float:
        return self.transport.reposition_fuel_consumption_per_distance * (1 - self._active_discount("fuel_discount"))

    def _current_fixed_shipment_cost(self) -> float:
        return self.transport.fixed_shipment_cost * (1 - self._active_discount("fixed_cost_discount"))

    def _daily_crew_cost(self) -> float:
        """
        Total per-day wages owed across everyone crewing this Transport
        (see Crew.daily_wages) -- the Captain included, since Captain is
        itself a Crew member. Paid every day regardless of whether the
        Transport is idle, in port, or mid-voyage (see act()), and
        factored into route profitability alongside fuel and fixed fees
        (see _route_economics / _consider_repositioning), since a longer
        trip ties up not just capital but a crew that must be paid for
        every day it's away.
        """
        return sum(member.daily_wages for member in self.transport.crew)

    def _route_economics(self, origin: str, destination: str, buy_price: float,
                          sell_price_estimate: float, quantity: float, fuel_price: float,
                          buy_markets: Optional[Dict[Tuple[str, str], "Market"]] = None,
                          closed_locations: frozenset = frozenset()):
        """
        Compute the cost/time picture for shipping `quantity` units from
        origin to destination, given current buy/sell price estimates and
        the CURRENT fuel price at the origin (where the transport refuels before
        departure). Fuel consumption and the fixed fee reflect any active
        agent-event discounts (see _current_fuel_consumption_rate /
        _current_fixed_shipment_cost). Crew salaries (see
        Captain._daily_crew_cost) are charged for every day the voyage
        takes, on top of fuel and fixed fees -- a longer trip ties up a
        crew that must be paid the whole time, not just capital. Returns
        a dict of everything the decision (and later bookkeeping) needs.

        The trip is planned with Dijkstra's algorithm (see
        sim.pathfinding.find_shortest_path), weighted by each Route's
        distance, over every Route this Transport can physically use (see
        Transport.can_use_route) -- so a voyage with no DIRECT route
        between origin and destination can still be taken via
        intermediate stops, as long as SOME multi-hop path exists. A
        CLOSED location is still fair game as an intermediate stop on the
        path (a ship can pass through/alongside one without needing to
        dock there) -- only actually refueling there is off-limits (see
        _refuel_at_stop), so `closed_locations` isn't used to restrict
        the pathfinding itself. The resulting path is returned as `path`
        (a list of Route edges, empty only if origin == destination): the
        caller (see _execute_local_route) stores it on the Captain so the
        ship actually follows it leg by leg, refueling at intermediate
        stops without otherwise "docking" there (see _arrive).

        Fuel for the whole voyage is estimated leg by leg, each priced at
        that leg's own origin's CURRENT price (a look-ahead the agent is
        entitled to, since `buy_markets` already holds live prices
        everywhere, not just where it's standing) -- the amount actually
        bought at each intermediate stop is re-priced when the transport
        gets there (see _refuel_at_stop), the same way a sale price can
        drift from what was estimated at departure. If no path exists at
        all, or any single leg needs more fuel than this Transport's tank
        can ever hold (`fuel_capacity`, regardless of topping up along the
        way), the trip is marked infeasible via `daily_return_pct=-1.0`,
        which the same profitability threshold every caller already
        checks (`daily_return_pct < min_daily_return_pct`) naturally
        rejects.
        """
        infeasible = {
            "distance": 0.0, "route_type": "unreachable", "travel_days": 0,
            "fuel_price": fuel_price, "fuel_units_consumed": 0.0, "fuel_cost_per_unit": 0.0,
            "total_cost": 0.0, "expected_revenue": 0.0, "expected_profit": -1.0,
            "daily_return_pct": -1.0, "path": None, "crew_cost": 0.0,
        }

        path = find_shortest_path(origin, destination, self.transport.can_use_route)
        if path is None:
            return infeasible

        nodes = path_node_sequence(origin, path)
        fuel_rate = self._current_fuel_consumption_rate()
        total_distance = 0.0
        total_days = 0
        total_fuel_units = 0.0
        total_fuel_cost = 0.0
        route_types: List["RouteType"] = []

        for leg_origin, leg_destination, route in zip(nodes, nodes[1:], path):
            leg_fuel_units = route.distance * fuel_rate * quantity
            if leg_fuel_units > self.transport.fuel_capacity:
                # This leg alone needs more fuel than the tank can ever hold,
                # no matter how full it starts -- not a voyage this Transport
                # can actually complete, regardless of how many times it refuels.
                return infeasible

            if buy_markets is not None:
                leg_fuel_market = buy_markets.get((leg_origin, "Fuel"))
                leg_fuel_price = leg_fuel_market.price if leg_fuel_market is not None else fuel_price
            else:
                leg_fuel_price = fuel_price

            total_distance += route.distance
            total_days += travel_days_between(leg_origin, leg_destination, self.transport.speed_units_per_day)
            total_fuel_units += leg_fuel_units
            total_fuel_cost += leg_fuel_units * leg_fuel_price
            if route.route_type not in route_types:
                route_types.append(route.route_type)

        crew_cost = self._daily_crew_cost() * total_days
        total_cost = quantity * buy_price + total_fuel_cost + self._current_fixed_shipment_cost() + crew_cost
        expected_revenue = quantity * sell_price_estimate
        expected_profit = expected_revenue - total_cost

        # Daily return: profit earned per day per dollar of capital tied up.
        # This is what lets the agent compare a short cheap route against a
        # long expensive one on equal footing, rather than just chasing the
        # biggest raw price gap.
        daily_return_pct = (expected_profit / total_cost / total_days) \
            if total_cost > 0 and total_days > 0 else -1.0

        return {
            "distance": total_distance,
            "route_type": "+".join(rt.name for rt in route_types) if route_types else "none",
            "travel_days": total_days,
            "fuel_price": fuel_price,
            "fuel_units_consumed": total_fuel_units,
            "fuel_cost_per_unit": total_fuel_cost / quantity if quantity > 0 else 0.0,
            "total_cost": total_cost,
            "expected_revenue": expected_revenue,
            "expected_profit": expected_profit,
            "daily_return_pct": daily_return_pct,
            "path": path,
            "crew_cost": crew_cost,
        }

    def act(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
            sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
            closed_locations: frozenset = frozenset(), directed_route: Optional[dict] = None):
        """
        Advance the agent by one day. First rolls for an agent-specific
        event and ticks any ongoing ones. If mid-voyage, this may just tick
        down the travel clock -- or, if today is arrival day, it also sells
        any cargo it's carrying (a sale is unloading, not a new departure),
        but it does NOT plan or depart on a new route until the FOLLOWING
        day: a transport always spends at least one night in port before
        heading out again, even if a new opportunity already clears the
        bar the moment it docks. If the agent is stuck at the dock (from a
        "delay" event), it burns down that time instead of planning a new
        route. If the port it's sitting in is CLOSED (quarantine, war,
        blockade -- see LocationClosure), it can't load, unload, or refuel
        there at all, and just waits it out.

        If `directed_route` is given (a Faction telling this transport what to
        do -- see Company.direct_fleet / PirateBrigade.direct_fleet), it's
        used instead of the agent's own autonomous local search once it's
        confirmed idle; otherwise the agent decides for itself exactly as
        before. Two shapes of directive are recognized: the usual
        buy-here-and-depart trade route (a dict with "commodity" and
        "destination", as Company produces), or a bare reposition-only
        move (a dict with `"action": "REPOSITION"` and "destination", as
        PirateBrigade produces) that just sails the transport there empty
        without buying anything.
        """
        self._maybe_trigger_agent_event(day)
        self.active_agent_events = [e for e in self.active_agent_events if e.tick()]

        just_arrived = False
        if self.status == TransportStatus.InTransit:
            # Crew wages are only owed while actually underway -- idle
            # time in port doesn't cost anything (see _daily_crew_cost /
            # Crew.daily_wages). If the Faction can't afford today's
            # wages, the crew stops working: no fuel burn, no travel
            # progress, and the Transport goes Inactive (excluded from
            # Company/PirateBrigade.direct_fleet() via is_idle_in_port)
            # until it can afford to pay again.
            crew_cost = self._daily_crew_cost()
            if crew_cost > self.cash:
                self.transport.status = TransportStatus.Inactive
                return
            self.cash -= crew_cost
            self.transport.consume_fuel(self._daily_fuel_burn)
            self.days_remaining -= 1
            if self.days_remaining > 0:
                return
            if not self._arrive(day, buy_markets, closed_locations):
                return  # just refueled at an intermediate stop; still en route to the real destination
            just_arrived = True  # docked for the FIRST time today -- see below

        # Now definitely in port (either already was, or just arrived).
        # A closed port means no unloading, no loading, no refueling --
        # the transport just sits there (with cargo, if it has any) until it
        # reopens, whether it's been stuck for a while or just pulled in.
        if self.location in closed_locations:
            return

        if self.cargo is not None:
            self._sell_cargo_if_possible(day, sell_markets)

        if self.grounded_days_remaining > 0:
            self.grounded_days_remaining -= 1
            return  # stuck at the dock; can't plan a new departure today

        if just_arrived:
            return  # always spends at least one night in port before departing again

        if self.cargo is None:
            if directed_route is not None:
                if directed_route.get("action") == "REPOSITION":
                    self._execute_directed_reposition(directed_route["destination"], day, buy_markets)
                else:
                    self._execute_local_route(directed_route, day, buy_markets, sell_markets, closed_locations)
            else:
                self._plan_and_depart(day, buy_markets, sell_markets, commodities, closed_locations)

    def _maybe_trigger_agent_event(self, day: int):
        """Roll for a random shock hitting this agent specifically today."""
        if random.random() >= self.agent_event_probability:
            return
        # A cargo_loss event with no cargo to lose would be a no-op; filter
        # it out rather than wasting the roll.
        eligible = [t for t in AGENT_EVENT_TEMPLATES if t["kind"] != "cargo_loss" or self.cargo is not None]
        if not eligible:
            return
        template = random.choice(eligible)
        event = AgentEvent(**template)
        self._apply_agent_event(event, day)

    def _apply_agent_event(self, event: "AgentEvent", day: int):
        event.started_day = day
        event.day = day
        event.subject = self.name
        self.event_log.append(event)
        detail = ""
        if event.kind == "delay":
            days = int(event.magnitude)
            if self.status == TransportStatus.InTransit:
                self.days_remaining += days
                detail = f"voyage delayed {days}d (now {self.days_remaining}d out)"
            else:
                self.grounded_days_remaining += days
                detail = f"grounded at {self.location} for {days}d"
        elif event.kind == "cargo_loss" and self.cargo is not None:
            lost_qty = self.cargo["quantity"] * event.magnitude
            self.cargo["quantity"] = max(0.0, self.cargo["quantity"] - lost_qty)
            detail = f"lost {lost_qty:.1f} units of {self.cargo['commodity']}"
        elif event.kind == "cash_gain":
            self.cash += event.magnitude
            detail = f"+${event.magnitude:,.2f} cash"
        elif event.kind == "cash_loss":
            paid = min(event.magnitude, self.cash)
            self.cash = max(0.0, self.cash - event.magnitude)
            detail = f"-${paid:,.2f} cash"
        elif event.kind in ("fuel_discount", "fixed_cost_discount"):
            self.active_agent_events.append(event)
            detail = f"{event.magnitude:.0%} off for {event.duration_days}d"

        self.agent_event_log.append({
            "day": day,
            "location": self.location,
            "name": event.name,
            "kind": event.kind,
            "detail": detail,
        })

    def _arrive(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                closed_locations: frozenset = frozenset()) -> bool:
        """
        Advance the transport to the node its current leg was heading to --
        one hop of a (possibly multi-hop) Dijkstra path (see
        sim.pathfinding.find_shortest_path / _route_economics). Returns
        True for a genuine arrival at the voyage's FINAL destination (the
        transport is now in port, ready to sell/plan its next move) -- or
        False if this was only an intermediate stop along `self.path`: the
        ship does NOT dock there in the normal sense (no selling, no
        idling, no new route planning) -- it only refuels if the next leg
        needs it AND this stop isn't currently CLOSED (see
        _refuel_at_stop) and immediately continues, still `in_transit`.
        """
        self.location = self.destination
        self.current_node = self.location

        if self.cargo is not None and self.path:
            next_route = self.path.pop(0)
            next_node = next_route.destination if next_route.origin == self.current_node else next_route.origin
            leg_fuel_units = self._refuel_at_stop(day, buy_markets, next_route.distance, closed_locations)
            self.transport.refuel(leg_fuel_units)
            self.destination = next_node
            self.days_remaining = travel_days_between(
                self.current_node, next_node, self.transport.speed_units_per_day)
            self._daily_fuel_burn = leg_fuel_units / self.days_remaining if self.days_remaining > 0 else 0.0
            return False

        self.status = TransportStatus.AtLocation
        self.destination = None
        self._daily_fuel_burn = 0.0
        return True

    def _refuel_at_stop(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                         next_leg_distance: float, closed_locations: frozenset = frozenset()) -> float:
        """
        Refuel at an intermediate stop along a multi-hop path (see
        _route_economics / _arrive) with exactly enough fuel for the NEXT
        leg (`next_leg_distance` units away), priced at THIS location's
        CURRENT fuel price -- which may differ from the estimate used when
        the route was planned, the same way a sale price can drift from
        what was expected at departure. Returns the number of fuel units
        just bought (0.0 if this Transport doesn't track fuel, the next
        leg needs none, or this stop is currently CLOSED -- a closed port
        won't sell fuel any more than it'll buy/sell cargo, even though
        the ship can still pass through it on its way elsewhere), which
        the caller (_arrive) feeds into Transport.refuel to update the
        live fuel gauge.
        """
        if self.location in closed_locations:
            return 0.0
        fuel_units = next_leg_distance * self._current_fuel_consumption_rate() * self.cargo["quantity"]
        if fuel_units <= 0:
            return 0.0
        fuel_market = buy_markets.get((self.location, "Fuel"))
        fuel_price = fuel_market.price if fuel_market else 0.0
        fuel_cost = fuel_units * fuel_price

        self.cash -= fuel_cost
        self.total_fuel_spent += fuel_cost
        self.total_fuel_units_consumed += fuel_units
        self.cargo["fuel_units_consumed"] += fuel_units
        self.cargo["fuel_cost_total"] += fuel_cost
        self.cargo["total_cost"] += fuel_cost
        if fuel_market is not None:
            self._apply_price_impact(fuel_market, fuel_units, direction="buy")

        self.trade_log.append({
            "day": day,
            "action": "REFUEL",
            "commodity": self.cargo["commodity"],
            "location": self.location,
            "destination": self.cargo["destination"],
            "quantity": 0.0,
            "price": None,
            "distance": None,
            "route_type": None,
            "travel_days": None,
            "fuel_price": round(fuel_price, 3),
            "fuel_units_consumed": round(fuel_units, 2),
            "fuel_cost_paid": round(fuel_cost, 2),
            "profit": None,
        })
        return fuel_units

    def is_idle_in_port(self, closed_locations: frozenset = frozenset()) -> bool:
        """True if this transport could be given a fresh route order right now."""
        return (self.status == TransportStatus.AtLocation and self.cargo is None
                and self.grounded_days_remaining == 0 and self.location not in closed_locations)

    def _sell_cargo_if_possible(self, day: int, sell_markets: Dict[Tuple[str, str], "Market"]):
        if self.cargo is None:
            return
        market = sell_markets.get((self.location, self.cargo["commodity"]))
        if market is None:
            return  # can't offload here; keep carrying it until somewhere will take it

        sell_price = market.price
        proceeds = sell_price * self.cargo["quantity"]
        profit = proceeds - self.cargo["total_cost"]

        self.cash += proceeds
        self.realized_profit += profit
        self._apply_price_impact(market, self.cargo["quantity"], direction="sell")

        self.trade_log.append({
            "day": day,
            "action": "SELL",
            "commodity": self.cargo["commodity"],
            "location": self.location,
            "destination": None,
            "quantity": round(self.cargo["quantity"], 2),
            "price": round(sell_price, 2),
            "distance": self.cargo["distance"],
            "route_type": self.cargo["route_type"],
            "travel_days": self.cargo["travel_days"],
            "fuel_price": round(self.cargo["fuel_price_paid"], 3),
            "fuel_units_consumed": round(self.cargo["fuel_units_consumed"], 2),
            "fuel_cost_paid": round(self.cargo["fuel_cost_total"], 2),
            "profit": round(profit, 2),
        })
        self.cargo = None

    def _find_best_local_route(self, buy_markets: Dict[Tuple[str, str], "Market"],
                                sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
                                closed_locations: frozenset = frozenset(),
                                exclude_routes: frozenset = frozenset()) -> Optional[dict]:
        """
        Pure evaluation, no side effects: only commodities buyable at THIS
        location are considered, but every other (open) location that
        would buy that commodity is a candidate destination -- reachability
        (including a genuine multi-hop voyage via Dijkstra's algorithm when
        no direct Route exists -- see sim.pathfinding.find_shortest_path)
        is resolved by _route_economics itself, which reports an
        unreachable destination as a -1.0 `daily_return_pct` that the
        profitability check below naturally rejects, so no separate
        can_use_route prefilter is needed here. Returns the single best
        (commodity, destination) pairing by daily return that clears
        `min_daily_return_pct`, or None if nothing does. `exclude_routes`
        -- a set of (commodity, destination) pairs -- lets a Company ask
        "what would this transport do if its top choice were already
        spoken for by a sister transport?" without needing a second,
        near-duplicate method.
        """
        best = None
        for commodity in commodities:
            buy_market = buy_markets.get((self.location, commodity))
            if buy_market is None or buy_market.price <= 0:
                continue  # not buyable here

            sell_candidates = [
                (loc, m) for (loc, com), m in sell_markets.items()
                if com == commodity and loc != self.location and loc not in closed_locations
                and (commodity, loc) not in exclude_routes
            ]
            if not sell_candidates:
                continue  # nowhere open will take it

            trial_quantity = min(self.transport.cargo_capacity, self.cash / buy_market.price)
            if trial_quantity < 1:
                continue

            fuel_market = buy_markets.get((self.location, "Fuel"))
            fuel_price = fuel_market.price if fuel_market else 0.0

            for dest_loc, sell_market in sell_candidates:
                econ = self._route_economics(self.location, dest_loc, buy_market.price,
                                              sell_market.price, trial_quantity, fuel_price,
                                              buy_markets=buy_markets, closed_locations=closed_locations)
                if econ["expected_profit"] <= 0 or econ["daily_return_pct"] < self.min_daily_return_pct:
                    continue
                if best is None or econ["daily_return_pct"] > best["daily_return_pct"]:
                    best = {
                        "commodity": commodity,
                        "destination": dest_loc,
                        "fuel_price": fuel_price,
                        **econ,
                    }
        return best

    def _execute_local_route(self, route: dict, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                              sell_markets: Dict[Tuple[str, str], "Market"],
                              closed_locations: frozenset = frozenset()):
        """
        Buy `route["commodity"]` here and depart for `route["destination"]`.
        Only the commodity/destination pairing is trusted from `route` --
        quantity, prices, and profitability are all re-derived from LIVE
        market state at execution time (which may have moved since the
        route was scored, especially if a Company evaluated it earlier in
        the day before other ships acted), and the trade is skipped
        entirely if it no longer clears the bar.

        The voyage may be a genuine multi-hop path (see _route_economics /
        sim.pathfinding.find_shortest_path) rather than a single direct
        Route. Only the FIRST leg's fuel is paid for now, at ORIGIN's
        current price; `self.path` is stored with every remaining leg so
        the transport keeps following it -- refueling at each intermediate
        stop for whatever THAT leg needs, at whatever the price turns out
        to be then (see _refuel_at_stop) -- without otherwise "docking"
        there, until the final destination in `econ["path"]` is reached
        (see _arrive).
        """
        commodity, destination = route["commodity"], route["destination"]
        origin_market = buy_markets.get((self.location, commodity))
        sell_market = sell_markets.get((destination, commodity))
        if origin_market is None or sell_market is None:
            return

        quantity = min(self.transport.cargo_capacity, self.cash / origin_market.price)
        if quantity < 1:
            return

        fuel_market = buy_markets.get((self.location, "Fuel"))
        fuel_price = fuel_market.price if fuel_market else 0.0
        econ = self._route_economics(self.location, destination, origin_market.price,
                                      sell_market.price, quantity, fuel_price,
                                      buy_markets=buy_markets, closed_locations=closed_locations)
        if econ["expected_profit"] <= 0 or econ["daily_return_pct"] < self.min_daily_return_pct:
            return
        if econ["total_cost"] > self.cash:
            return

        path = econ["path"]
        if not path:
            # Shouldn't happen -- a profitable econ implies a real path --
            # but guard defensively against a stale or externally-supplied
            # `route` dict pointing at an unreachable/self destination.
            return

        first_leg = path[0]
        origin_location = self.location
        leg1_fuel_units = first_leg.distance * self._current_fuel_consumption_rate() * quantity
        leg1_fuel_cost = leg1_fuel_units * fuel_price
        upfront_cost = quantity * origin_market.price + leg1_fuel_cost + self._current_fixed_shipment_cost()

        buy_price = origin_market.price
        self.cash -= upfront_cost
        self.total_fuel_spent += leg1_fuel_cost
        self.total_fuel_units_consumed += leg1_fuel_units
        self.total_fixed_fees_spent += self.transport.fixed_shipment_cost
        self._apply_price_impact(origin_market, quantity, direction="buy")
        # Refueling at the origin draws down local fuel supply too, so it
        # pushes that location's fuel price up a little, just like buying
        # the cargo commodity does.
        if fuel_market is not None:
            self._apply_price_impact(fuel_market, leg1_fuel_units, direction="buy")

        self.cargo = {
            "commodity": commodity,
            "quantity": quantity,
            "unit_cost": buy_price,
            "origin": origin_location,
            "destination": destination,
            "distance": econ["distance"],
            "route_type": econ["route_type"],
            "travel_days": econ["travel_days"],
            "fuel_price_paid": fuel_price,
            "fuel_units_consumed": leg1_fuel_units,
            "fuel_cost_total": leg1_fuel_cost,
            "total_cost": upfront_cost,
            "departure_day": day,
        }
        self.status = TransportStatus.InTransit
        self.transport.refuel(leg1_fuel_units)

        self.current_node = origin_location
        self.path = path[1:]  # every leg after this first one
        next_node = first_leg.destination if first_leg.origin == origin_location else first_leg.origin
        self.destination = next_node
        self.days_remaining = travel_days_between(
            origin_location, next_node, self.transport.speed_units_per_day)
        self._daily_fuel_burn = leg1_fuel_units / self.days_remaining if self.days_remaining > 0 else 0.0

        self.trade_log.append({
            "day": day,
            "action": "BUY",
            "commodity": commodity,
            "location": origin_location,
            "destination": destination,
            "quantity": round(quantity, 2),
            "price": round(buy_price, 2),
            "distance": econ["distance"],
            "route_type": econ["route_type"],
            "travel_days": econ["travel_days"],
            "fuel_price": round(fuel_price, 3),
            "fuel_units_consumed": round(leg1_fuel_units, 2),
            "fuel_cost_paid": round(leg1_fuel_cost, 2),
            "profit": None,
        })

    def _plan_and_depart(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                          sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
                          closed_locations: frozenset = frozenset()):
        """Autonomous path (no Company directing this transport): find the best
        local route and execute it, or fall back to repositioning."""
        best = self._find_best_local_route(buy_markets, sell_markets, commodities, closed_locations)
        if best is None:
            self._consider_repositioning(day, buy_markets, sell_markets, commodities, closed_locations)
            return
        self._execute_local_route(best, day, buy_markets, sell_markets, closed_locations)

    def _consider_repositioning(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                                 sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
                                 closed_locations: frozenset = frozenset()):
        """
        Called only when nothing at the CURRENT location clears the return
        bar. Scans every OTHER (open) location as a potential origin,
        paired with every (open) location that would buy that commodity, to
        find the single best opportunity in the whole network -- closed
        ports are excluded on both sides, since the agent can't dock to
        load there and nobody there can take a delivery either, and both
        legs (the empty repositioning hop to the origin, and the loaded
        hop from origin to destination) are restricted to connections
        this trader's Transport can actually use (see
        Transport.can_use_route -- a Train, for instance, will never be
        offered a leg that isn't a land route). If sailing there empty
        (burning ballast fuel, no cargo) and then executing that trade
        would still clear a return bar -- once the extra travel time and
        that ballast fuel are folded in -- the agent departs empty toward
        it. Otherwise it stays put; this is deliberately speculative, so
        a stiffer bar (`min_daily_return_pct * reposition_return_multiplier`)
        applies than for a trade already in hand.
        """
        best = None
        for commodity in commodities:
            buy_candidates = [
                (loc, m) for (loc, com), m in buy_markets.items()
                if com == commodity and loc != self.location and loc not in closed_locations
                and self.transport.can_use_route(get_route(self.location, loc))
            ]
            sell_candidates = [
                (loc, m) for (loc, com), m in sell_markets.items()
                if com == commodity and loc not in closed_locations
            ]
            if not buy_candidates or not sell_candidates:
                continue

            for target_loc, target_buy_market in buy_candidates:
                if target_buy_market.price <= 0:
                    continue
                trial_quantity = min(self.transport.cargo_capacity, self.cash / target_buy_market.price)
                if trial_quantity < 1:
                    continue

                fuel_market_at_target = buy_markets.get((target_loc, "Fuel"))
                fuel_price_at_target = fuel_market_at_target.price if fuel_market_at_target else 0.0

                for dest_loc, dest_sell_market in sell_candidates:
                    if dest_loc == target_loc:
                        continue
                    if not self.transport.can_use_route(get_route(target_loc, dest_loc)):
                        continue  # can't physically carry cargo on this leg
                    econ = self._route_economics(target_loc, dest_loc, target_buy_market.price,
                                                  dest_sell_market.price, trial_quantity, fuel_price_at_target,
                                                  buy_markets=buy_markets, closed_locations=closed_locations)
                    if econ["expected_profit"] <= 0:
                        continue
                    if best is None or econ["daily_return_pct"] > best["econ"]["daily_return_pct"]:
                        best = {"commodity": commodity, "target_loc": target_loc,
                                "dest_loc": dest_loc, "econ": econ}

        if best is None:
            return  # nowhere in the network looks better than sitting tight

        fuel_market_here = buy_markets.get((self.location, "Fuel"))
        fuel_price_here = fuel_market_here.price if fuel_market_here else 0.0
        reposition_distance = distance_between(self.location, best["target_loc"])
        reposition_days = travel_days_between(self.location, best["target_loc"], self.transport.speed_units_per_day)
        reposition_fuel_units = reposition_distance * self._current_reposition_fuel_rate()
        reposition_fuel_cost = reposition_fuel_units * fuel_price_here
        # The crew still has to be paid during the empty repositioning hop
        # too, on top of whatever _route_economics already charged for
        # the loaded leg that follows it.
        reposition_crew_cost = self._daily_crew_cost() * reposition_days

        opp = best["econ"]
        total_days = reposition_days + opp["travel_days"]
        total_cost = reposition_fuel_cost + reposition_crew_cost + opp["total_cost"]
        total_profit = opp["expected_profit"] - reposition_fuel_cost - reposition_crew_cost
        adjusted_daily_return = (total_profit / total_cost / total_days) if total_cost > 0 and total_days > 0 else -1.0

        required_return = self.min_daily_return_pct * self.reposition_return_multiplier
        if total_profit <= 0 or adjusted_daily_return < required_return:
            return

        self._depart_empty_to(best["target_loc"], day, buy_markets, reason_commodity=best["commodity"])

    def _depart_empty_to(self, destination: str, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                          reason_commodity: Optional[str] = None) -> bool:
        """
        Shared mechanics for sailing empty (ballast, no cargo) from the
        current location to `destination`: works out distance/days/fuel
        via the route network, confirms this Transport can physically
        make the trip (see Transport.can_use_route) and can afford the
        fuel, deducts that fuel cost, nudges the local fuel price, and
        puts the transport en route. Returns True if the departure happened,
        False if it was skipped (already there, unreachable, or
        unaffordable) -- callers that need to know whether the move
        actually happened (rather than just firing and forgetting) can
        check this.

        `reason_commodity` is purely cosmetic -- it's what shows up in
        the trade log/reports as the reason for the move: a specific
        commodity for _consider_repositioning's own opportunity-chasing,
        or None for a directive with no single commodity behind it (e.g.
        a PirateBrigade converging on wherever its targets are).
        """
        if destination == self.location:
            return False
        route = get_route(self.location, destination)
        if not self.transport.can_use_route(route):
            return False

        fuel_market_here = buy_markets.get((self.location, "Fuel"))
        fuel_price_here = fuel_market_here.price if fuel_market_here else 0.0
        reposition_distance = distance_between(self.location, destination)
        reposition_days = travel_days_between(self.location, destination, self.transport.speed_units_per_day)
        reposition_route_type = route.route_type if route is not None else "unknown"
        reposition_fuel_units = reposition_distance * self._current_reposition_fuel_rate()
        reposition_fuel_cost = reposition_fuel_units * fuel_price_here
        if reposition_fuel_cost > self.cash:
            return False

        self.cash -= reposition_fuel_cost
        self.total_fuel_spent += reposition_fuel_cost
        self.total_fuel_units_consumed += reposition_fuel_units
        self.total_repositions += 1
        if fuel_market_here is not None:
            self._apply_price_impact(fuel_market_here, reposition_fuel_units, direction="buy")

        origin_location = self.location
        self.status = TransportStatus.InTransit
        self.transport.refuel(reposition_fuel_units)
        self.destination = destination
        self.days_remaining = reposition_days
        self._daily_fuel_burn = reposition_fuel_units / reposition_days if reposition_days > 0 else 0.0
        # cargo stays None -- the transport is sailing empty.

        self.trade_log.append({
            "day": day,
            "action": "REPOSITION",
            "commodity": reason_commodity,
            "location": origin_location,
            "destination": destination,
            "quantity": 0.0,
            "price": None,
            "distance": reposition_distance,
            "route_type": reposition_route_type,
            "travel_days": reposition_days,
            "fuel_price": round(fuel_price_here, 3),
            "fuel_units_consumed": round(reposition_fuel_units, 2),
            "fuel_cost_paid": round(reposition_fuel_cost, 2),
            "profit": None,
        })
        return True

    def _execute_directed_reposition(self, destination: str, day: int,
                                      buy_markets: Dict[Tuple[str, str], "Market"]):
        """
        Move empty to an externally-chosen `destination` -- e.g. a
        PirateBrigade telling this transport where to converge (see
        PirateBrigade.direct_fleet) -- bypassing this transport's own
        profit-seeking search entirely. Used when `directed_route`
        carries {"action": "REPOSITION", "destination": ...} instead of
        the buy-and-depart trade directive `_execute_local_route` expects.
        """
        self._depart_empty_to(destination, day, buy_markets, reason_commodity=None)

    def record_portfolio_snapshot(self, day: int, sell_markets: Dict[Tuple[str, str], "Market"]):
        """
        Net worth = cash on hand + mark-to-market value of any cargo
        currently held (valued at the current location if in port, or at
        the destination's current price if mid-voyage; falls back to cost
        if no sell market is available to mark against).
        """
        cargo_value = 0.0
        if self.cargo is not None:
            mark_location = self.location if self.status == TransportStatus.AtLocation else self.cargo["destination"]
            market = sell_markets.get((mark_location, self.cargo["commodity"]))
            if market is not None:
                cargo_value = market.price * self.cargo["quantity"]
            else:
                cargo_value = self.cargo["unit_cost"] * self.cargo["quantity"]

        total_value = self.cash + cargo_value
        self.portfolio_history.append({
            "day": day,
            "location": self.location,
            "status": self.status,
            "cash": round(self.cash, 2),
            "cargo_value": round(cargo_value, 2),
            "total_value": round(total_value, 2),
            "realized_profit": round(self.realized_profit, 2),
            "total_fuel_spent": round(self.total_fuel_spent, 2),
        })

    def print_summary(self):
        print(f"\n--- {self.name}: Captain Summary ---")
        print(f"  Ship:                {self.transport.name} (cap={self.transport.cargo_capacity:.1f}, "
              f"speed={self.transport.speed_units_per_day:.0f}/day)")
        final_value = self.portfolio_history[-1]["total_value"] if self.portfolio_history else self.cash
        if self.company is not None and self.company.pools_cash:
            print(f"  Funds:               shared pool owned by {self.company.name} "
                  f"(current pool balance: {self.company.cash:,.2f}) -- see company summary for profit")
        elif self.company is not None:
            print(f"  Funds:               own balance (owned by {self.company.name}, "
                  f"current balance: {self.cash:,.2f}) -- see faction summary for combined profit")
        else:
            print(f"  Starting cash:       {self.starting_cash:,.2f}")
            print(f"  Final net worth:     {final_value:,.2f}")
            print(f"  Net profit:          {final_value - self.starting_cash:,.2f}")
        print(f"  Final location:      {self.location} ({self.status})")
        num_buys = sum(1 for t in self.trade_log if t["action"] == "BUY")
        num_sells = sum(1 for t in self.trade_log if t["action"] == "SELL")
        print(f"  Trades executed:     {num_buys} buys, {num_sells} sells")
        print(f"  Repositioning trips: {self.total_repositions}")
        print(f"  Total fuel spent:    {self.total_fuel_spent:,.2f} ({self.total_fuel_units_consumed:,.1f} units)")
        print(f"  Total fixed fees:    {self.total_fixed_fees_spent:,.2f}")
        if num_buys:
            avg_days = sum(t["travel_days"] for t in self.trade_log if t["action"] == "BUY") / num_buys
            print(f"  Avg. travel time:    {avg_days:.1f} days")
        if self.agent_event_log:
            print(f"  Agent events:        {len(self.agent_event_log)}")
            for kind in ("delay", "cargo_loss", "cash_gain", "cash_loss", "fuel_discount", "fixed_cost_discount"):
                count = sum(1 for e in self.agent_event_log if e["kind"] == kind)
                if count:
                    print(f"    {kind:<18} x{count}")

    def save_trade_log_csv(self, filepath: str):
        if not self.trade_log:
            return
        fieldnames = list(self.trade_log[0].keys())
        with open(filepath, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(self.trade_log)
        print(f"Saved {self.name} trade log to {filepath}")

    def save_agent_event_log_csv(self, filepath: str):
        if not self.agent_event_log:
            return
        fieldnames = list(self.agent_event_log[0].keys())
        with open(filepath, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(self.agent_event_log)
        print(f"Saved {self.name} agent event log to {filepath}")

    def plot_portfolio(self, filepath: str):
        if not self.portfolio_history:
            return
        days = [r["day"] for r in self.portfolio_history]
        total_value = [r["total_value"] for r in self.portfolio_history]
        cash = [r["cash"] for r in self.portfolio_history]

        fig, ax = plt.subplots(figsize=(10, 5.5))
        ax.plot(days, total_value, linewidth=2.0, color="tab:green", label="Total Net Worth")
        ax.plot(days, cash, linewidth=1.2, color="tab:gray", linestyle="--",
                label="Cash on Hand (shared company pool)"
                if self.company is not None and self.company.pools_cash else "Cash on Hand")
        if self.starting_cash is not None:
            ax.axhline(self.starting_cash, color="black", linestyle=":", alpha=0.5, label="Starting Capital")

        for t in self.trade_log:
            if t["action"] == "BUY":
                ax.axvline(t["day"], color="tab:blue", alpha=0.08)
            elif t["action"] == "REPOSITION":
                ax.axvline(t["day"], color="tab:orange", alpha=0.15, linestyle=":")

        ax.set_title(f"{self.name}: Portfolio Value Over Time")
        ax.set_xlabel("Day")
        ax.set_ylabel("Value ($)")
        ax.grid(alpha=0.3)
        ax.legend(loc="best")

        plt.tight_layout()
        plt.savefig(filepath, dpi=150)
        plt.close(fig)
        print(f"Saved {self.name} portfolio chart to {filepath}")
