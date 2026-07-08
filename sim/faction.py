"""
Faction: owns a fleet of Captains and their money -- and Company (its
actively fleet-directing subclass, with SoloTrader a non-pooling variant)
/ PirateBrigade (a raiding subclass that hunts Company fleets instead of
trading) / PoliceFleet (a currently-passive law-enforcement subclass
that watches PirateBrigades).
"""
import json
import random
from dataclasses import asdict
from enum import Enum
from typing import Dict, List, Optional, Tuple

from .captain import Captain
from .crew import Sailor
from .transport import Ship, Transport, TransportStatus
from .routes import get_route
from .world_data import get_location


class Faction:
    """
    Base class for any group that owns a fleet of Captains AND
    their money: funds live on the Faction as a single shared cash pool
    (`self.cash`), not on each transport individually. Every transport in the
    fleet reads and writes that same pool through its own `cash`
    property (see Captain.cash), so from a transport's point of view
    nothing changes -- `self.cash` still means "what I can currently
    spend" -- it just happens to be the same number its sister ships see
    too.

    On its own, a Faction is purely an ownership/bookkeeping layer: who
    belongs to it, how much money the group collectively holds, and what
    their combined net worth/profit looks like (see total_cash,
    net_worth, print_summary below). It does NOT do anything active with
    that fleet -- ships owned by a plain Faction still plan their own
    routes entirely autonomously, exactly as if they had no owner at all,
    the same way World.run() leaves any transport alone when nothing supplies
    it a `directed_route` (see Captain.act). Company (below) is
    the concrete subclass that adds active daily coordination on top of
    this; a different subclass could model a looser alliance, a
    state-owned fleet, or anything else that pools ships and money
    without Company's specific routing behavior.

    Usage: build a Faction (or a Company) from a list of
    `(Transport, Captain, home_location)` triples and a `starting_cash`
    for the pool, then pass it to World(factions=[...]) instead of (or
    alongside) traders=[...]. Faction owns the fleet's Transports and
    Captains, but doesn't construct the Captains itself -- you build each
    Captain with whatever strategy parameters you want (name,
    min_daily_return_pct, price_impact, ...) and hand it to Faction
    already-built, paired with the Transport it will run and the
    location it starts docked at; Faction just wires those two onto the
    Captain (see __init__). World calls `direct_fleet()` once per day IF
    the object provides one -- a plain Faction doesn't, so its ships
    simply act on their own; Company overrides it to actively steer its
    fleet.
    """

    # Whether captains in this Faction draw from/pay into one shared cash
    # pool (self.cash) or each keep their own private balance
    # (captain._cash). True for a plain Faction/Company; PirateBrigade
    # overrides this to False since raiding ships don't pool loot -- see
    # Captain.cash and PirateBrigade below.
    pools_cash: bool = True

    def __init__(self, name: str, crew: List[Tuple[Transport, Captain, str]], starting_cash: float = 0.0):
        """
        `crew` is a list of `(Transport, Captain, home_location)` triples
        -- one entry per transport/train/plane this Faction owns, paired with
        the already-constructed Captain that will run it. Faction wires
        each Captain's `.transport` and starting `.location` here, rather than
        constructing the Captain itself, so callers retain full control
        over each Captain's own strategy parameters. It also fills out
        each Transport's `.crew` roster to match its `crew_requirement`:
        the Captain always fills one seat, and any remaining seats (if
        `crew_requirement > 1`) are padded out with Sailor instances
        (see crew.py), since there's no other information here about
        who they'd be.
        """
        self.name = name
        self.captains: List[Captain] = []
        for transport, captain, home_location in crew:
            captain.transport = transport
            captain.location = home_location
            self.captains.append(captain)

            transport.crew = [captain]
            extra_seats = max(0, transport.crew_requirement - 1)
            transport.crew += [
                Sailor(name=f"{transport.name} Sailor {i + 2}", transport=transport)
                for i in range(extra_seats)
            ]
        self.starting_cash = starting_cash
        if self.pools_cash:
            self.cash = starting_cash  # the one shared pool every captain's `cash` property reads/writes
            for captain in self.captains:
                # Fold in any cash a captain already happened to be holding
                # (e.g. it was built with its own starting_cash before being
                # assigned to this Faction) so nothing is silently stranded.
                self.cash += captain._cash
                captain._cash = 0.0
                # Captain's attribute is still named `company` for
                # backward compatibility (same reasoning as `transport` staying
                # `transport` after the Transport refactor) -- it now holds
                # whichever Faction owns this captain, Company or otherwise.
                captain.company = self
        else:
            # No pool: `starting_cash`, if given, is split evenly across
            # the fleet and added to whatever each captain already had, so
            # every transport still ends up with its own independent balance.
            if starting_cash and self.captains:
                share = starting_cash / len(self.captains)
                for captain in self.captains:
                    captain._cash += share
            for captain in self.captains:
                captain.company = self

    def total_cash(self) -> float:
        """
        The faction's current combined balance: the shared pool if
        `pools_cash`, otherwise the sum of every captain's own private
        balance.
        """
        if self.pools_cash:
            return self.cash
        return sum(captain.cash for captain in self.captains)

    def net_worth(self, sell_markets: Dict[Tuple[str, str], "Market"]) -> float:
        """
        Combined cash (see total_cash) + mark-to-market value of cargo
        every transport is currently carrying. NOTE: when `pools_cash` is True
        this must NOT sum `t.cash` across captains -- every transport reports
        the SAME pool balance, so that would count it once per transport
        instead of once total; total_cash() already handles that split.
        """
        total = self.total_cash()
        for t in self.captains:
            if t.cargo is not None:
                mark_location = t.location if t.status == TransportStatus.AtLocation else t.cargo["destination"]
                market = sell_markets.get((mark_location, t.cargo["commodity"]))
                total += (market.price if market is not None else t.cargo["unit_cost"]) * t.cargo["quantity"]
        return total

    def direct_fleet(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                      sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
                      closed_locations: frozenset = frozenset()) -> Dict[Captain, dict]:
        """
        A plain Faction has no active routing strategy of its own -- its
        ships plan and execute their own trades entirely autonomously (see
        Captain.act). Subclasses that DO actively steer their fleet
        (Company, PirateBrigade) override this; World.run() calls it for
        every Faction and treats a NotImplementedError the same as a
        Faction with no directives at all, so a plain Faction's ships are
        left alone rather than crashing the simulation.
        """
        raise NotImplementedError

    def print_summary(self, sell_markets: Dict[Tuple[str, str], "Market"]):
        net_worth = self.net_worth(sell_markets)
        cash_label = "Current cash (pool):  " if self.pools_cash else "Current cash (fleet): "
        print(f"\n--- {self.name}: {type(self).__name__} Summary ---")
        print(f"  Ships:                 {len(self.captains)}")
        print(f"  Starting cash (total): {self.starting_cash:,.2f}")
        print(f"  {cash_label} {self.total_cash():,.2f}")
        print(f"  Combined net worth:    {net_worth:,.2f}")
        print(f"  Combined net profit:   {net_worth - self.starting_cash:,.2f}")

    def build_daily_json_report(self) -> List[dict]:
        """
        One entry per simulated day, holding EVERY nested data member of
        this Faction and its fleet as of that day -- not the flattened,
        human-readable summaries build_company_daily_reports() produces
        for CSV. For each day a Captain recorded a portfolio snapshot,
        this includes: the Faction's own pool state (or, for a
        non-pooling Faction like PirateBrigade, each transport's own balance),
        the watched target names if this is a PirateBrigade, and per
        Captain -- every field of its Ship/Train/Plane Transport (via
        dataclasses.asdict), its full portfolio snapshot for that day
        (location, status, cash, cargo_value, total_value,
        realized_profit, total_fuel_spent), and every trade_log /
        agent_event_log entry it recorded that day. There's no separate
        historical cargo record kept per day -- that day's cargo_value
        (inside the snapshot) and trade_log entries are the record of
        what each transport was carrying/doing.

        Meant to be handed straight to save_daily_json_report() (or
        json.dumps(..., default=str) directly) rather than read like the
        CSV reports -- it's a full nested dump, not a table.
        """
        days_seen = sorted({snap["day"] for captain in self.captains for snap in captain.portfolio_history})
        report: List[dict] = []

        for day in days_seen:
            captains_today = []
            for captain in self.captains:
                snapshot = next((s for s in captain.portfolio_history if s["day"] == day), None)
                if snapshot is None:
                    continue
                captains_today.append({
                    "name": captain.name,
                    "min_daily_return_pct": captain.min_daily_return_pct,
                    "price_impact": captain.price_impact,
                    "transport": asdict(captain.transport),
                    "portfolio_snapshot": snapshot,
                    "trades_today": [t for t in captain.trade_log if t["day"] == day],
                    "events_today": [e for e in captain.agent_event_log if e["day"] == day],
                })

            if not captains_today:
                continue

            if self.pools_cash:
                cash_pool = captains_today[0]["portfolio_snapshot"]["cash"]
                net_worth = cash_pool + sum(c["portfolio_snapshot"]["cargo_value"] for c in captains_today)
            else:
                cash_pool = None
                net_worth = sum(c["portfolio_snapshot"]["total_value"] for c in captains_today)

            report.append({
                "day": day,
                "faction": self.name,
                "faction_type": type(self).__name__,
                "pools_cash": self.pools_cash,
                "cash_pool": cash_pool,
                "net_worth": round(net_worth, 2),
                "targets": [company.name for company in self.targets] if hasattr(self, "targets") else None,
                "captains": captains_today,
            })

        return report

    def save_daily_json_report(self, filepath: str):
        """Write build_daily_json_report()'s full nested per-day history to `filepath` as JSON."""
        with open(filepath, "w") as f:
            json.dump(self.build_daily_json_report(), f, indent=2, default=_json_default)
        print(f"Saved {self.name} daily JSON report to {filepath}")


def _json_default(value):
    """
    json.dump `default=` hook for the value types that show up nested in
    Faction.build_daily_json_report() but aren't natively JSON-serializable:
    Enums (e.g. RouteType inside a trade_log entry) become their member
    name, and frozensets (e.g. Location.terminal_types) become a sorted
    list of their (already-converted) members.
    """
    if isinstance(value, Enum):
        return value.name
    if isinstance(value, frozenset):
        return sorted(_json_default(v) if isinstance(v, Enum) else v for v in value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


class Company(Faction):
    """
    A Faction that actively directs its fleet, on top of everything
    Faction already provides (shared cash pool, net worth, reporting).
    Two concrete things a Company does that a plain Faction (or an
    unmanaged fleet of the same ships) wouldn't:

      - COORDINATED ROUTING: every day, before ships act on their own, the
        Company looks at every currently idle transport it owns (in port, empty
        cargo, not grounded, not stuck in a closed port -- see
        Captain.is_idle_in_port), scores each one's best available
        local route exactly the way it would score its own, and assigns
        them in descending order of daily return. If two idle ships would
        both claim the exact same (commodity, destination) pairing, the
        second one is offered its next-best DIFFERENT option instead (via
        `exclude_routes`) rather than piling both onto one route while
        another profitable route elsewhere in the network goes unclaimed --
        spreading the fleet's coverage instead of concentrating it.
      - SHARED CAPITAL: because every transport's `cash` IS the faction's pool
        (inherited from Faction), a transport can size and afford a trade
        using the fleet's ENTIRE cash position, not just whatever
        happened to be sitting on that one transport. There's no separate
        transfer step -- as soon as one transport spends, every other transport
        immediately sees the reduced balance the next time it checks
        `self.cash`, which is exactly what `_execute_local_route` and
        `_find_best_local_route` already do.

    Ships that are mid-voyage, grounded, carrying cargo, or sitting in a
    closed port are left alone -- the Company only steps in on the "what
    should this idle transport do next" decision, and only for the immediate
    local buy-and-depart choice; repositioning (see
    Captain._consider_repositioning) stays autonomous per-transport even
    for company-owned ships, since it's already a network-wide search.

    Usage: build a Company from a list of Captains and a
    `starting_cash` for the pool (don't also give the individual traders
    their own starting_cash -- see Captain.__init__), then pass it
    to World(factions=[...]) instead of (or alongside) traders=[...];
    World calls direct_fleet() once per day and threads the resulting
    orders into each transport's own act() call.
    """

    def direct_fleet(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                      sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
                      closed_locations: frozenset = frozenset()) -> Dict[Captain, dict]:
        """
        Decide (but don't execute) a route for each idle transport worth
        directing today. Returns {trader: route_dict} for World to hand
        back to each transport's own act() call; ships not in the dict just act
        autonomously as usual (e.g. nothing profitable was found for them,
        or they weren't idle in the first place).

        No explicit capital-pooling step is needed here any more: every
        candidate route is already scored (via `_find_best_local_route`)
        against the shared pool balance, and execution re-checks that same
        live balance, so affordability naturally accounts for the whole
        fleet's cash without a separate transfer.
        """
        idle = [t for t in self.captains if t.is_idle_in_port(closed_locations)]
        if not idle:
            return {}

        candidates = []
        for trader in idle:
            best = trader._find_best_local_route(buy_markets, sell_markets, commodities, closed_locations)
            if best is not None:
                candidates.append((trader, best))
        if not candidates:
            return {}

        candidates.sort(key=lambda pair: pair[1]["daily_return_pct"], reverse=True)

        directives: Dict[Captain, dict] = {}
        claimed_routes = set()
        for trader, best in candidates:
            if trader in directives:
                continue
            route_key = (best["commodity"], best["destination"])
            if route_key in claimed_routes:
                alt = trader._find_best_local_route(buy_markets, sell_markets, commodities,
                                                      closed_locations, exclude_routes=frozenset(claimed_routes))
                if alt is None:
                    continue  # nothing else worth doing; let it idle/reposition on its own
                best = alt
                route_key = (best["commodity"], best["destination"])

            directives[trader] = best
            claimed_routes.add(route_key)

        return directives


class SoloTrader(Company):
    """
    A Company that still gets coordinated routing (see Company.direct_fleet)
    but does NOT pool its fleet's cash into one shared balance -- each
    captain keeps their own private balance (see Faction.pools_cash /
    Captain.cash), the same non-pooling behavior PirateBrigade uses.
    `starting_cash`, if given, is split evenly across the fleet at
    construction time (see Faction.__init__) rather than funding a
    shared pool. Useful for a "company" that's really just a loose
    association of independent operators sharing dispatch, not capital --
    or literally a single captain running their own ship.
    """

    # Each captain keeps their own loot rather than pooling it -- see
    # Faction.pools_cash / Captain.cash.
    pools_cash: bool = False


class PirateBrigade(Faction):
    """
    A raiding Faction. PirateBrigade.direct_fleet() moves every idle
    pirate transport toward wherever Company-owned ships are currently
    most concentrated -- a purely location-based hunting behavior. If an
    idle pirate transport finds itself sharing a location with a watched
    Company's transport (also AtLocation there), it attacks instead of
    repositioning (see _attack): if the victim's Company doesn't pool
    cash (see Faction.pools_cash -- e.g. a SoloTrader), it steals
    `raid_fraction` of the victim's own current cash; a pooling
    Company's shared purse is untouchable. Either way, if the victim is
    carrying cargo, the pirate seizes all of it and fences it on the
    spot at the current location's sell price times that Location's own
    `fence_fraction` (a black-market discount that varies by location,
    since it's stolen goods) -- the victim keeps neither the cargo nor
    its market value. Either way it logs the raid in its own trade_log and the
    victim's agent_event_log, and sits out the rest of that day
    (grounded, same as an agent-event delay) rather than also planning
    an autonomous trade. There's still no sinking modeled.

    `targets` is the list of Company factions this brigade watches --
    pass every Company in the World you want it to hunt. It only counts
    Company instances (not plain Factions or other PirateBrigades):
    "Company Transports" specifically means ships belonging to a
    for-profit shipping Company.

    Unlike Company/plain Faction, a PirateBrigade does NOT pool its
    fleet's cash into one shared balance -- each pirate transport keeps its
    own loot in its own private balance (see Faction.pools_cash /
    Captain.cash). `starting_cash`, if given, is just split evenly
    across the fleet at construction time as everyone's starting stake.

    Usage: build a PirateBrigade from a list of `(Ship, Captain,
    home_location)` triples (see Faction.__init__ -- you build each
    Captain yourself; PirateBrigade just wires the Ship and starting
    location onto it), an optional starting_cash to seed each transport's own
    balance, and the list of Companies to hunt, then pass it into
    World(factions=[...]) alongside whatever Companies (and plain
    Factions) you like. World calls direct_fleet() on it once a day
    exactly like it does for a Company.
    """

    # Pirate ships keep their own loot rather than pooling it -- see
    # Faction.pools_cash / Captain.cash.
    pools_cash: bool = False

    def __init__(self, name: str, crew: List[Tuple[Transport, Captain, str]], targets: List[Company],
                 starting_cash: float = 0.0, laziness: int = 1, raid_fraction: float = 0.10,
                 max_carousing_to_attack: float = 50.0, carousing_cost_per_crew: float = 10.0,
                 carousing_increase_per_day: float = 10.0, max_carousing: float = 100.0,
                 police_fleets: Optional[List["PoliceFleet"]] = None):
        non_ships = [captain.name for transport, captain, _ in crew if not isinstance(transport, Ship)]
        if non_ships:
            raise ValueError(
                f"PirateBrigade '{name}' can only crew Ships -- non-Ship Transports on: "
                f"{', '.join(non_ships)}"
            )
        super().__init__(name=name, crew=crew, starting_cash=starting_cash)
        self.targets = targets
        # How many days the brigade goes between re-scanning target
        # locations (see direct_fleet): 1 rescans every day (the old,
        # default behavior); higher values make it slower to notice a
        # Company fleet has moved on, reusing the last scan's ranking
        # in between instead of recomputing it every single day.
        self.laziness = laziness
        # Fraction of a victim's current cash stolen per attack (see
        # _attack) -- checked fresh every day regardless of `laziness`,
        # since it's just a same-location check, not the expensive
        # network-wide scan repositioning relies on. Fencing seized
        # cargo uses the current Location's own `fence_fraction` (see
        # location.Location) instead of a brigade-wide constant.
        self.raid_fraction = raid_fraction
        # A pirate Captain with carousing above this (see Captain.carousing
        # -- crew too drunk/distracted from shore leave) won't attack a
        # co-located victim (see _co_located_target); it just falls
        # through to its normal repositioning search instead.
        self.max_carousing_to_attack = max_carousing_to_attack
        # Every day a pirate Ship sits AtLocation (see _apply_daily_carousing),
        # its crew spends `carousing_cost_per_crew` per Crew member on
        # shore leave; if the Captain can afford it, carousing rises by
        # `carousing_increase_per_day` -- otherwise neither the charge
        # nor the increase happens.
        self.carousing_cost_per_crew = carousing_cost_per_crew
        self.carousing_increase_per_day = carousing_increase_per_day
        # If a Captain's carousing goes above this (see
        # _apply_daily_carousing), it resets to 0 and the crew is too
        # hungover/blacked out to do anything at all that day -- grounded
        # (see Captain.grounded_days_remaining) the same way an
        # agent-event "delay" or a just-completed attack is.
        self.max_carousing = max_carousing
        # PoliceFleets whose presence deters an attack (see
        # _police_present_at / _co_located_target) -- a pirate Ship won't
        # raid a victim if any of these PoliceFleets has a Ship AtLocation
        # right there too. World wires its auto-created police_fleet onto
        # every PirateBrigade it's given, but this can also be populated
        # (or left empty, for no deterrence) directly.
        self.police_fleets: List["PoliceFleet"] = police_fleets or []
        self._cached_ranked_locations: Optional[List[str]] = None
        self._last_scan_day: Optional[int] = None

    def _target_ship_counts_by_location(self) -> Dict[str, int]:
        """
        How many watched Company ships currently occupy each location --
        counting a transport at its current port if it's in_port, or at its
        DESTINATION (where it's headed) if in_transit, so the brigade
        converges on where targets are about to be, not just where they
        already were.
        """
        counts: Dict[str, int] = {}
        for company in self.targets:
            for captain in company.captains:
                loc = captain.location if captain.status == TransportStatus.AtLocation else captain.destination
                if loc is None:
                    continue
                counts[loc] = counts.get(loc, 0) + 1
        return counts

    def _police_present_at(self, location: str) -> bool:
        """
        True if any watched PoliceFleet (see self.police_fleets) has a
        Ship currently AtLocation at `location` -- pirates won't attack
        under a police Ship's nose (see _co_located_target).
        """
        for police_fleet in self.police_fleets:
            for captain in police_fleet.captains:
                if captain.status == TransportStatus.AtLocation and captain.location == location:
                    return True
        return False

    def _co_located_target(self, pirate_captain: Captain,
                            already_attacked: frozenset = frozenset()) -> Optional[Captain]:
        """
        The first watched Company Captain currently AtLocation in the
        same place as `pirate_captain` (also AtLocation, since a pirate
        can only attack from port, not mid-voyage) and not already in
        `already_attacked`, or None if nobody's there left to raid.
        `already_attacked` is how direct_fleet() enforces one attacker
        per victim per day -- see there. Also returns None outright if
        `pirate_captain.carousing` is over `max_carousing_to_attack`
        (too busy with shore leave to raid today) or if a watched
        PoliceFleet has a Ship at this same location (see
        _police_present_at) -- either way, regardless of who's around.
        """
        if pirate_captain.carousing > self.max_carousing_to_attack:
            return None
        if self._police_present_at(pirate_captain.location):
            return None
        for company in self.targets:
            for captain in company.captains:
                if captain in already_attacked:
                    continue
                if captain.status == TransportStatus.AtLocation and captain.location == pirate_captain.location:
                    return captain
        return None

    def _apply_daily_carousing(self, captain: Captain):
        """
        Called once per day (see direct_fleet) for every pirate Captain
        whose Ship is currently AtLocation, regardless of whether it's
        idle, grounded, or busy raiding today: its crew (see
        Transport.crew) spends `carousing_cost_per_crew` per member on
        shore leave. If the Captain can afford the full cost, it's
        deducted and `carousing` rises by `carousing_increase_per_day`;
        if not, NEITHER happens -- no partial charge, no partial increase.

        If that increase pushes `carousing` above `max_carousing`, the
        crew's blacked out: carousing resets to 0 and the Captain is
        grounded for the day (see Captain.grounded_days_remaining), same
        as being stuck at the dock from an agent-event delay -- it won't
        attack, reposition, or do anything else today (see
        Captain.is_idle_in_port, which direct_fleet's later attack/
        reposition loop already gates on).
        """
        cost = len(captain.transport.crew) * self.carousing_cost_per_crew
        if captain.cash < cost:
            return
        captain.cash -= cost
        captain.carousing += self.carousing_increase_per_day
        if captain.carousing > self.max_carousing:
            captain.carousing = 0.0
            captain.grounded_days_remaining = max(captain.grounded_days_remaining, 1)

    def _attack(self, day: int, pirate_captain: Captain, victim_captain: Captain,
                sell_markets: Dict[Tuple[str, str], "Market"]):
        """
        Steal `raid_fraction` of the victim's current cash -- but only if
        the victim's Company does NOT pool cash (see Faction.pools_cash):
        a pooling Company's cash is untouchable (there's no single
        captain's balance to rob, just the whole fleet's shared purse,
        which raiding one ship shouldn't be able to drain), so only
        SoloTrader (or any other non-pooling) victims lose cash here.
        Then -- if the victim is carrying cargo -- seize all of it and
        fence it immediately at the current location regardless of
        pooling: valued at that location's live sell price for the
        commodity (falling back to the victim's own unit cost if there's
        no sell market for it here, same fallback Faction.net_worth
        uses), times the current Location's own `fence_fraction` (see
        location.Location -- a black-market discount that can vary by
        location) to reflect it being stolen goods sold off-book. The
        victim loses the cargo outright -- it gets neither the goods nor
        their market value. Everything recovered goes straight to the
        attacking pirate's own balance. Logs the raid in the pirate's
        trade_log (action "ATTACK") and the victim's agent_event_log
        (kind "cash_loss"), the same schemas World's report builders
        already know how to read.
        """
        victim_pools_cash = victim_captain.company is not None and victim_captain.company.pools_cash
        stolen_cash = 0.0 if victim_pools_cash else round(victim_captain.cash * self.raid_fraction, 2)

        seized_commodity = None
        seized_quantity = 0.0
        fence_price = None
        fenced_proceeds = 0.0
        if victim_captain.cargo is not None:
            cargo = victim_captain.cargo
            market = sell_markets.get((pirate_captain.location, cargo["commodity"]))
            unit_value = market.price if market is not None else cargo["unit_cost"]
            location = get_location(pirate_captain.location)
            fence_fraction = location.fence_fraction if location is not None else 0.5
            seized_commodity = cargo["commodity"]
            seized_quantity = cargo["quantity"]
            fence_price = round(unit_value * fence_fraction, 2)
            fenced_proceeds = round(fence_price * seized_quantity, 2)
            victim_captain.cargo = None

        total_gain = round(stolen_cash + fenced_proceeds, 2)
        if total_gain <= 0 and seized_commodity is None:
            return  # nothing worth raiding -- victim has no cash and no cargo

        victim_captain.cash -= stolen_cash
        pirate_captain.cash += total_gain

        pirate_captain.trade_log.append({
            "day": day,
            "action": "ATTACK",
            "commodity": seized_commodity,
            "location": pirate_captain.location,
            "destination": victim_captain.name,
            "quantity": round(seized_quantity, 2),
            "price": fence_price,
            "distance": None,
            "route_type": None,
            "travel_days": None,
            "fuel_price": None,
            "fuel_units_consumed": None,
            "fuel_cost_paid": 0.0,
            "profit": total_gain,
        })
        detail = f"-${stolen_cash:,.2f} cash" if stolen_cash > 0 else "cash pooled -- untouchable"
        if seized_commodity is not None:
            detail += f", {seized_quantity:.1f} {seized_commodity} seized and fenced for {fenced_proceeds:,.2f}"
        victim_captain.agent_event_log.append({
            "day": day,
            "location": victim_captain.location,
            "name": f"Pirate attack by {pirate_captain.name} ({self.name})",
            "kind": "cash_loss",
            "detail": detail,
        })

    def direct_fleet(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                      sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
                      closed_locations: frozenset = frozenset()) -> Dict[Captain, dict]:
        """
        Every idle pirate transport (in port, empty cargo, not grounded, not
        stuck in a closed port -- see Captain.is_idle_in_port) first checks
        whether a watched Company transport is AtLocation right there with
        it (see _co_located_target) -- if so, it attacks (see _attack)
        instead of repositioning, and sits out the rest of the day.
        Otherwise, it's pointed toward whichever OPEN location currently
        has the most Company Transports on or heading to it, provided this
        transport's Transport can physically reach it (see
        Transport.can_use_route). A transport that can't reach the busiest
        spot is offered the next-busiest reachable one, and so on down the
        ranking. A transport that's already at the best reachable spot --
        or for which no watched Company has any ships at all -- gets no
        directive and simply falls through to its own default behavior for
        the day (see Captain.act), the same way an unmatched Company
        transport would.

        Unlike Company.direct_fleet, this returns REPOSITION directives
        (see Captain._execute_directed_reposition) rather than
        trade routes -- pirates aren't buying or selling anything, they're
        purely converging on a location (or attacking, once there).

        Every Captain whose Ship is currently AtLocation -- idle,
        grounded, or otherwise -- also racks up a day of shore-leave
        carousing here first (see _apply_daily_carousing), independent
        of everything else this method does today.
        """
        for captain in self.captains:
            if captain.status == TransportStatus.AtLocation:
                self._apply_daily_carousing(captain)

        # Only re-scan where the watched Companies' ships actually are
        # every `laziness` days -- on the days in between, keep hunting
        # toward whatever ranking was last computed instead of redoing
        # the scan (and the sort) every single day.
        needs_scan = (
            self._last_scan_day is None
            or day - self._last_scan_day >= self.laziness
        )
        if needs_scan:
            target_counts = self._target_ship_counts_by_location()
            # Busiest locations first.
            self._cached_ranked_locations = sorted(
                target_counts, key=lambda loc: target_counts[loc], reverse=True)
            self._last_scan_day = day

        ranked_locations = self._cached_ranked_locations
        if not ranked_locations:
            return {}

        directives: Dict[Captain, dict] = {}
        # Tracks victims already claimed by another pirate captain earlier
        # in this same direct_fleet() call, so at most one Pirate Ship
        # attacks a given Company Transport per day -- see
        # _co_located_target.
        already_attacked: set = set()
        for captain in self.captains:
            if not captain.is_idle_in_port(closed_locations):
                continue

            victim = self._co_located_target(captain, frozenset(already_attacked))
            if victim is not None:
                self._attack(day, captain, victim, sell_markets)
                already_attacked.add(victim)
                # Busy raiding today -- don't also hand it a reposition
                # order or let it fall through to autonomous trading
                # once World calls act() (see Captain.act's grounded
                # check, the same mechanic an agent-event "delay" uses).
                captain.grounded_days_remaining = max(captain.grounded_days_remaining, 1)
                continue

            for loc in ranked_locations:
                if loc == captain.location or loc in closed_locations:
                    continue
                if not captain.transport.can_use_route(get_route(captain.location, loc)):
                    continue
                directives[captain] = {"action": "REPOSITION", "destination": loc}
                break  # took the best reachable hotspot; move on to the next pirate transport

        return directives


class PoliceFleet(Faction):
    """
    A law-enforcement Faction -- the natural counterpart to PirateBrigade,
    with a `targets` list of the PirateBrigades it watches. Its patrol
    behavior (see direct_fleet) is currently pure random wandering --
    every idle Ship moves to a randomly chosen, OPEN, reachable Location
    every `patrol_interval_days` days -- rather than any actual
    target-seeking or interception; `targets` is there for a future
    direct_fleet() that does something smarter with it, without needing
    another constructor change.

    Government-funded: always pools cash (pools_cash is redundantly
    explicit here even though it's also Faction's own default, for the
    same self-documenting reason PirateBrigade/SoloTrader declare
    theirs) into a bottomless, infinite pool -- starting_cash isn't
    caller-configurable, unlike every other Faction subclass.

    Usage: build a PoliceFleet from a list of `(Transport, Captain,
    home_location)` triples (see Faction.__init__) and the list of
    PirateBrigades to watch, then pass it into World(factions=[...])
    alongside whatever Companies and PirateBrigades you like.
    """

    pools_cash: bool = True

    def __init__(self, name: str, crew: List[Tuple[Transport, Captain, str]],
                 targets: Optional[List["PirateBrigade"]] = None, patrol_interval_days: int = 5):
        super().__init__(name=name, crew=crew, starting_cash=float("inf"))
        self.targets = targets or []
        # How many days an idle Ship waits between random patrol moves
        # (see direct_fleet) -- a Ship that's never moved yet is treated
        # as due immediately, same as PirateBrigade's first target scan.
        self.patrol_interval_days = patrol_interval_days
        self._last_patrol_day: Dict[Captain, int] = {}

    def _random_patrol_destination(self, captain: Captain, all_locations: set,
                                    closed_locations: frozenset) -> Optional[str]:
        """
        A uniformly random OPEN Location, other than where `captain`
        already is, that its Transport can physically reach (see
        Transport.can_use_route) -- or None if nowhere reachable
        qualifies.
        """
        candidates = [
            loc for loc in all_locations
            if loc != captain.location and loc not in closed_locations
            and captain.transport.can_use_route(get_route(captain.location, loc))
        ]
        if not candidates:
            return None
        return random.choice(candidates)

    def direct_fleet(self, day: int, buy_markets: Dict[Tuple[str, str], "Market"],
                      sell_markets: Dict[Tuple[str, str], "Market"], commodities: List[str],
                      closed_locations: frozenset = frozenset()) -> Dict[Captain, dict]:
        """
        Every idle police Ship (see Captain.is_idle_in_port) that's due
        for a patrol move -- it's been at least `patrol_interval_days`
        since its last one, or it's never moved before -- gets a
        REPOSITION directive (see Captain._execute_directed_reposition)
        toward a uniformly random, OPEN, reachable Location (see
        _random_patrol_destination). Not due yet, or nowhere reachable
        to go, and it gets no directive -- falls through to its own
        default behavior for the day (see Captain.act), same as an
        unmatched PirateBrigade/Company ship.
        """
        all_locations = {loc for (loc, _) in buy_markets} | {loc for (loc, _) in sell_markets}

        directives: Dict[Captain, dict] = {}
        for captain in self.captains:
            if not captain.is_idle_in_port(closed_locations):
                continue

            last_patrol_day = self._last_patrol_day.get(captain)
            if last_patrol_day is not None and day - last_patrol_day < self.patrol_interval_days:
                continue

            destination = self._random_patrol_destination(captain, all_locations, closed_locations)
            if destination is None:
                continue

            directives[captain] = {"action": "REPOSITION", "destination": destination}
            self._last_patrol_day[captain] = day

        return directives
