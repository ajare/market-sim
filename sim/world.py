"""
World: orchestrates every (location, commodity) market together --
scheduling events/closures, running the day loop, and building/printing/
saving every daily report.
"""
import csv
import os
import random
from typing import Callable, Dict, List, Optional, Tuple

import matplotlib.pyplot as plt

from .events import (
    Event, MarketEvent, EVENT_TEMPLATES, LOCATION_EVENT_TEMPLATES, WORLD_EVENT_TEMPLATES,
    LocationClosure, LOCATION_CLOSURE_TEMPLATES, CompanyEvent, COMPANY_EVENT_TEMPLATES,
)
from .location import Location
from .markets import Market
from .transport import Ship
from .captain import Captain
from .names import ENGLISH_FIRST_NAMES, ENGLISH_LAST_NAMES
from .faction import Faction, Company, PirateBrigade, PoliceFleet
from .pathfinding import prime_route_graph_cache


def random_agent_order(traders: List[Captain], day: int) -> List[Captain]:
    """
    Default act-order strategy: shuffle the fleet freshly each day. With a
    fixed order, whichever agent sits first in the list always gets first
    crack at a shared market before its own trade nudges the price -- a
    structural edge that has nothing to do with strategy. Shuffling removes
    that bias so no agent is systematically favored over a run.
    """
    order = list(traders)
    random.shuffle(order)
    return order


def fixed_agent_order(traders: List[Captain], day: int) -> List[Captain]:
    """Alternative strategy: always act in the same (list) order. Useful for
    debugging or reproducing a specific agent's behavior deterministically,
    at the cost of always giving the same agent first-mover advantage."""
    return list(traders)


class World:
    """
    Owns one Market per (location, commodity, side) combination -- a "buy"
    market wherever a location lets you acquire that commodity, and a
    separate "sell" market wherever a location lets you offload it.

    Four independent event schedulers cover the full scope x specificity
    matrix (see the comment above LOCATION_EVENT_TEMPLATES):
      - LOCAL commodity events:      one (location, commodity) market only
                                      (rolled per-Market via local_event_probability)
      - GLOBAL commodity events:     one commodity, every location that trades it
                                      (global_event_probability)
      - LOCATION-WIDE events:        every commodity, one location
                                      (location_event_probability)
      - WORLDWIDE events:            every commodity, every location
                                      (worldwide_event_probability)

    On top of those demand/supply shocks, `location_closure_probability`
    governs a fifth, binary kind of event: an entire port can be CLOSED
    (quarantine, war, blockade -- see LocationClosure) for several days.
    While closed, no Market there clears trades at all (price freezes,
    volume is zero) and no agent can buy, sell, or refuel there -- ships
    already docked just wait it out, and ships en route still arrive but
    can't unload until it reopens.

    A sixth, independent kind of event -- `company_event_probability` --
    rolls separately for EACH plain Company (never a SoloTrader,
    PirateBrigade, or PoliceFleet -- see CompanyEvent's docstring) every
    day: a random cash windfall or setback (see COMPANY_EVENT_TEMPLATES)
    that moves that Company's shared pool directly.

    Each day, `agent_order_fn(traders, day)` decides what order the fleet
    acts in before that day's action loop runs; it defaults to
    `random_agent_order` so first-mover advantage on shared prices doesn't
    structurally favor whichever agent happens to be first in the list.
    Pass `fixed_agent_order`, or any `(traders, day) -> traders` callable
    of your own, to change that.

    Every World also auto-creates its own PoliceFleet (`num_police_ships`
    plain Ships, home-ported randomly across `locations`) watching every
    PirateBrigade passed in via `factions` -- see self.police_fleet.
    """

    def __init__(self, locations: List[Location], global_event_probability: float = 0.06,
                 local_event_probability: float = 0.08, location_event_probability: float = 0.04,
                 worldwide_event_probability: float = 0.02, location_closure_probability: float = 0.01,
                 company_event_probability: float = 0.05,
                 seed: Optional[int] = None,
                 traders: Optional[List[Captain]] = None,
                 factions: Optional[List[Faction]] = None,
                 agent_order_fn: Callable[[List[Captain], int], List[Captain]] = random_agent_order,
                 num_police_ships: int = 3):
        if seed is not None:
            random.seed(seed)

        # Builds (or reuses, if routes.ROUTES hasn't changed) the full
        # Route adjacency graph once here, rather than letting it happen
        # lazily/repeatedly the first time some Captain plans a voyage
        # (see sim.pathfinding.prime_route_graph_cache / find_shortest_path).
        prime_route_graph_cache()

        self.locations = locations
        self.global_event_probability = global_event_probability
        self.location_event_probability = location_event_probability
        self.worldwide_event_probability = worldwide_event_probability
        self.location_closure_probability = location_closure_probability
        self.company_event_probability = company_event_probability
        self.closed_locations: Dict[str, LocationClosure] = {}  # location name -> active closure
        self.closure_log: List[dict] = []  # historical record: every closure ever triggered
        self.buy_markets: Dict[Tuple[str, str], Market] = {}
        self.sell_markets: Dict[Tuple[str, str], Market] = {}
        self.combined_history: List[dict] = []
        # Every currently active Global/Location-wide/Worldwide MarketEvent,
        # tracked as its own independent {"scope", "subject", "event"} entry
        # -- NOT the same MarketEvent instances handed to each affected
        # Market (see _maybe_trigger_global_event and friends), since a
        # global/worldwide event is applied as a SEPARATE MarketEvent copy
        # per Market (so each Market can tick its own copy down
        # independently); an event's underlying `location=None` field also
        # can't distinguish "global commodity event" from "worldwide event"
        # on its own (see MarketEvent's docstring), so scope has to be
        # recorded explicitly at trigger time instead of reconstructed
        # later. Ticked once per day in _tick_broad_events -- see
        # active_named_events for the read side (e.g. exp-ui's background).
        self.active_broad_events: List[dict] = []
        # Every Global/Location-wide/Worldwide event ever triggered, kept
        # forever (never pruned as it expires, unlike active_broad_events)
        # -- {"scope", "subject", "name", "start_day", "duration_days"}.
        # For a caller that wants FINISHED events too, not just currently
        # active ones (e.g. exp-ui's commodity history chart, which marks
        # every day a Global event affected a commodity's price, including
        # ones long since expired) -- see active_named_events for the
        # currently-active-only view.
        self.broad_event_log: List[dict] = []
        # Every Event object generated anywhere in the sim -- Global/
        # Location/Worldwide/Local MarketEvents, TransportEvents (every
        # Captain's, picked up from Captain.event_log), and
        # LocationClosures -- appended in chronological order as they're
        # rolled, kept forever. Unlike broad_event_log/closure_log/
        # agent_event_log (plain dicts, one shape per event kind), this is
        # the real Event objects, so a caller (e.g. SimState) gets one
        # unified feed with a consistent type/subject/day/duration/message
        # view (see Event) instead of stitching several report formats
        # together itself.
        self.event_log: List[Event] = []
        # A plain Faction has no direct_fleet, so World.run() simply skips
        # the coordinated-routing step for it (see below) and its ships act
        # entirely autonomously. Copied (not aliased) since the
        # auto-created PoliceFleet below gets appended to it -- callers
        # shouldn't see their own list mutated.
        self.factions: List[Faction] = list(factions) if factions else []

        # Every World always gets its own PoliceFleet, crewed with
        # `num_police_ships` plain Ships and watching every PirateBrigade
        # already among `factions` (see PoliceFleet -- it's currently
        # passive, same as a plain Faction, so this just gets it onto the
        # board ready for a future active patrol/interception behavior).
        # Home ports are drawn from `locations` via the module's own
        # `random` stream (already reseeded above if `seed` was given),
        # same as everything else World rolls per-run. Government-funded,
        # so no starting_cash to pass -- PoliceFleet's pool is infinite.
        police_crew = []
        for i in range(num_police_ships):
            home_location = random.choice(locations).name
            ship = Ship(name=f"Police Ship {i + 1}", crew_requirement=random.randint(1, 5))
            # PoliceFleet captains get randomized English names (see
            # sim/names.py); the Ship itself keeps its "Police Ship N" name.
            captain_name = f"{random.choice(ENGLISH_FIRST_NAMES)} {random.choice(ENGLISH_LAST_NAMES)}"
            captain = Captain(name=captain_name, home_location=home_location)
            police_crew.append((ship, captain, home_location))
        self.police_fleet = PoliceFleet(
            name="Coast Guard",
            crew=police_crew,
            targets=[f for f in self.factions if isinstance(f, PirateBrigade)],
        )
        self.factions.append(self.police_fleet)
        # Deter every PirateBrigade already in play from attacking under
        # this police fleet's nose -- see PirateBrigade._police_present_at.
        for faction in self.factions:
            if isinstance(faction, PirateBrigade):
                faction.police_fleets.append(self.police_fleet)

        # Independent traders plus every transport owned by a Faction, all in one
        # flat list -- World doesn't care which ships are Company-directed
        # when it comes to housekeeping (events, portfolio snapshots, etc.).
        self.captains: List[Captain] = (traders or []) + [t for f in self.factions for t in f.captains]
        self.agent_order_fn = agent_order_fn

        for location in locations:
            for commodity, rate in location.produced_commodities.items():
                base_price = location.base_prices[commodity]
                market = Market(
                    commodity_name=commodity, location_name=location.name, location=location,
                    starting_price=base_price, base_price=base_price, side="buy",
                    event_probability=local_event_probability,
                )
                self.buy_markets[(location.name, commodity)] = market

            for commodity, rate in location.consumed_commodities.items():
                base_price = location.base_prices[commodity]
                market = Market(
                    commodity_name=commodity, location_name=location.name, location=location,
                    starting_price=base_price, base_price=base_price, side="sell",
                    event_probability=local_event_probability,
                )
                self.sell_markets[(location.name, commodity)] = market

            # Fuel is priced identically everywhere (per-location, but never
            # fluctuating -- see world_data._generate_locations) and isn't
            # part of the produce/consume stockpile system at all: every
            # location can always buy fuel, regardless of what it produces
            # or consumes.
            fuel_market = Market(
                commodity_name="Fuel", location_name=location.name, location=location,
                starting_price=location.fuel_price, base_price=location.fuel_price, side="buy",
                event_probability=local_event_probability, fixed_price=True,
            )
            self.buy_markets[(location.name, "Fuel")] = fuel_market

    def _all_markets(self) -> List[Market]:
        return list(self.buy_markets.values()) + list(self.sell_markets.values())

    def is_location_open(self, location_name: str) -> bool:
        return location_name not in self.closed_locations

    def _commodities_present(self) -> List[str]:
        seen = []
        for location in self.locations:
            for c in list(location.produced_commodities) + list(location.consumed_commodities):
                if c not in seen:
                    seen.append(c)
        return seen

    def _maybe_trigger_global_event(self, day: int):
        """A global event hits every buy AND sell market for a given commodity."""
        if random.random() >= self.global_event_probability:
            return None
        commodity = random.choice(self._commodities_present())
        template = random.choice(EVENT_TEMPLATES[commodity])
        affected_markets = [m for m in self._all_markets() if m.commodity_name == commodity]
        if not affected_markets:
            return None
        for market in affected_markets:
            market.apply_event(MarketEvent(**template, location=None, commodity=commodity))
        tracking_event = MarketEvent(**template, location=None, commodity=commodity)
        # Override MarketEvent.__post_init__'s auto-derived type -- it only
        # sees `location` (None here), which can't tell a Global
        # commodity-wide event apart from a Worldwide one; World knows the
        # real type at the point it triggers each kind, so it stamps it
        # itself (scope is already "Global" either way -- see
        # MarketEvent.__post_init__).
        tracking_event.day = day
        tracking_event.type = "Global"
        self.event_log.append(tracking_event)
        self.active_broad_events.append({
            "scope": "Global", "subject": commodity, "start_day": day,
            "event": tracking_event,
        })
        self.broad_event_log.append({
            "scope": "Global", "subject": commodity, "name": template["name"],
            "start_day": day, "duration_days": template["duration_days"],
        })
        affected_labels = [f"{m.location_name} ({m.side})" for m in affected_markets]
        return commodity, template["name"], affected_labels

    def _maybe_trigger_location_event(self, day: int):
        """A location-wide event hits every commodity's market (buy and sell) at one location."""
        if random.random() >= self.location_event_probability:
            return None
        location = random.choice(self.locations).name
        template = random.choice(LOCATION_EVENT_TEMPLATES)
        affected_markets = [m for m in self._all_markets() if m.location_name == location]
        if not affected_markets:
            return None
        for market in affected_markets:
            market.apply_event(MarketEvent(**template, location=location))
        tracking_event = MarketEvent(**template, location=location)
        # See the matching comment in _maybe_trigger_global_event -- the
        # auto-derived type would read "Local" here since `location` is set,
        # same as a per-market local event; override it to the real type
        # (scope is already `location` either way -- see
        # MarketEvent.__post_init__).
        tracking_event.day = day
        tracking_event.type = "Location"
        self.event_log.append(tracking_event)
        self.active_broad_events.append({
            "scope": "Location", "subject": location, "start_day": day,
            "event": tracking_event,
        })
        self.broad_event_log.append({
            "scope": "Location", "subject": location, "name": template["name"],
            "start_day": day, "duration_days": template["duration_days"],
        })
        affected_labels = [f"{m.commodity_name} ({m.side})" for m in affected_markets]
        return location, template["name"], affected_labels

    def _maybe_trigger_worldwide_event(self, day: int):
        """A worldwide event hits every market in the entire simulation, regardless of commodity or location."""
        if random.random() >= self.worldwide_event_probability:
            return None
        template = random.choice(WORLD_EVENT_TEMPLATES)
        affected_markets = self._all_markets()
        if not affected_markets:
            return None
        for market in affected_markets:
            market.apply_event(MarketEvent(**template, location=None))
        tracking_event = MarketEvent(**template, location=None)
        # See the matching comment in _maybe_trigger_global_event -- the
        # auto-derived type would read "Global" here too, since `location`
        # is None either way; override it to the real type (scope is
        # already "Global" either way -- see MarketEvent.__post_init__).
        tracking_event.day = day
        tracking_event.type = "Worldwide"
        self.event_log.append(tracking_event)
        self.active_broad_events.append({
            "scope": "Worldwide", "subject": "Global", "start_day": day,
            "event": tracking_event,
        })
        self.broad_event_log.append({
            "scope": "Worldwide", "subject": "Global", "name": template["name"],
            "start_day": day, "duration_days": template["duration_days"],
        })
        return template["name"], len(affected_markets)

    def _tick_broad_events(self) -> None:
        """Advance every tracked Global/Location-wide/Worldwide event by a
        day, dropping any that have expired -- see active_broad_events."""
        self.active_broad_events = [
            entry for entry in self.active_broad_events if entry["event"].tick()
        ]

    def active_named_events(self) -> List[dict]:
        """
        Every currently active Global/Location-wide/Worldwide MarketEvent
        (see active_broad_events) and per-Captain TransportEvent -- only the
        "fuel_discount"/"fixed_cost_discount" kinds persist over multiple
        days (see TransportEvent's docstring / Captain._apply_agent_event);
        the rest fire-and-resolve instantly in a single day, so there's
        nothing ongoing to report for them here. Each entry is
        {"scope", "subject", "name", "start_day", "days_remaining",
        "duration_days"} -- "scope" is "Global"/"Location"/"Worldwide" for a
        MarketEvent or "Agent" for a TransportEvent, and "subject" is the
        commodity/location/"Global"/Captain name a caller (e.g. exp-ui's
        network background or commodity history chart) would want to label
        it with; `duration_days` (together with `start_day`) lets a caller
        reconstruct every day the event has been/will be active
        (`range(start_day, start_day + duration_days)`), not just how many
        days are left. Sorted oldest-first (smallest start_day), so a
        caller doesn't need to sort it again itself.
        """
        result = [
            {
                "scope": entry["scope"], "subject": entry["subject"], "name": entry["event"].name,
                "start_day": entry["start_day"], "days_remaining": entry["event"].days_remaining,
                "duration_days": entry["event"].duration_days,
            }
            for entry in self.active_broad_events
        ]
        for captain in self.captains:
            for event in captain.active_agent_events:
                result.append({
                    "scope": "Agent", "subject": captain.name, "name": event.name,
                    "start_day": event.started_day, "days_remaining": event.days_remaining,
                    "duration_days": event.duration_days,
                })
        result.sort(key=lambda e: e["start_day"])
        return result

    def _tick_location_closures(self) -> List[str]:
        """Advance every active closure by a day; return the names of any locations that just reopened."""
        reopened = []
        for location_name in list(self.closed_locations.keys()):
            if not self.closed_locations[location_name].tick():
                del self.closed_locations[location_name]
                reopened.append(location_name)
        return reopened

    def _maybe_trigger_location_closure(self, day: int):
        """Roll for a whole port shutting down -- quarantine, war, blockade, etc. Skips locations already closed."""
        if random.random() >= self.location_closure_probability:
            return None
        candidates = [loc.name for loc in self.locations if loc.name not in self.closed_locations]
        if not candidates:
            return None
        location = random.choice(candidates)
        template = random.choice(LOCATION_CLOSURE_TEMPLATES)
        closure = LocationClosure(**template)
        closure.day = day
        closure.scope = location
        closure.subject = location
        self.closed_locations[location] = closure
        self.event_log.append(closure)
        self.closure_log.append({
            "day": day, "location": location, "event": closure.name,
            "duration_days": closure.duration_days,
        })
        return location, closure.name, closure.duration_days

    def _maybe_trigger_company_events(self, day: int) -> List[Tuple[str, str]]:
        """
        Roll an independent `company_event_probability` chance PER plain
        Company (see CompanyEvent's docstring for why `type(faction) is
        Company` -- not `isinstance` -- excludes SoloTrader, which is a
        Company subclass but doesn't pool cash) every day: a random cash
        windfall or setback that moves that Company's shared pool directly.
        Returns a (company_name, event_name) pair for every Company hit
        today, for verbose logging.
        """
        triggered = []
        for faction in self.factions:
            if type(faction) is not Company:
                continue
            if random.random() >= self.company_event_probability:
                continue
            template = random.choice(COMPANY_EVENT_TEMPLATES)
            event = CompanyEvent(**template)
            event.day = day
            event.subject = faction.name
            if event.kind == "cash_gain":
                faction.cash += event.magnitude
            else:  # cash_loss
                faction.cash = max(0.0, faction.cash - event.magnitude)
            self.event_log.append(event)
            triggered.append((faction.name, event.name))
        return triggered

    def run(self, num_days: int, verbose: bool = True):
        commodities_present = self._commodities_present()

        for day in range(1, num_days + 1):
            self._run_day(day, commodities_present, verbose)

        return self.combined_history

    def step(self, verbose: bool = False):
        """
        Advance the simulation by exactly one day, tracking its own day
        counter across calls -- lets a caller (e.g. a live UI) drive the
        sim one day at a time instead of committing to `run(num_days)`
        up front. Not meant to be mixed with `run()` on the same World.
        """
        self._next_day = getattr(self, "_next_day", 1)
        commodities_present = self._commodities_present()
        self._run_day(self._next_day, commodities_present, verbose)
        self._next_day += 1
        return self._next_day - 1

    def _run_day(self, day: int, commodities_present: List[str], verbose: bool = True):
            # Location closures are resolved before anyone acts today: any
            # closure that ran its course reopens, and a new one may begin,
            # so agents make today's decisions against today's actual port
            # status rather than yesterday's.
            reopened = self._tick_location_closures()
            if verbose:
                for location in reopened:
                    print(f"\n*** Day {day}: {location} has reopened to shipping ***\n")

            self._tick_broad_events()

            closure_event = self._maybe_trigger_location_closure(day)
            if verbose and closure_event:
                location, event_name, duration = closure_event
                print(f"\n*** Day {day}: PORT CLOSURE - {event_name} @ {location}, "
                      f"closed for {duration} day(s) ***\n")

            company_events = self._maybe_trigger_company_events(day)
            if verbose:
                for company_name, event_name in company_events:
                    print(f"\n*** Day {day}: COMPANY EVENT - {event_name} @ {company_name} ***\n")

            # Traders act first, using the previous day's closing prices:
            # each one advances its own journey (ticking down travel time,
            # arriving and selling if today's the day), then -- if it's in
            # port with empty cargo -- plans and departs on its next route
            # (or, for company-owned ships, follows that Company's order
            # for the day if it has one). The order they act in today is
            # decided by agent_order_fn, which defaults to a fresh shuffle
            # so no agent structurally gets first crack at a shared market
            # every single day.
            closed_locations = frozenset(self.closed_locations.keys())
            directed_routes: Dict[Captain, dict] = {}
            for faction in self.factions:
                try:
                    directives = faction.direct_fleet(day, self.buy_markets, self.sell_markets,
                                                       commodities_present, closed_locations)
                except NotImplementedError:
                    continue  # a plain Faction doesn't actively route -- its ships act fully autonomously
                directed_routes.update(directives)

            todays_order = self.agent_order_fn(self.captains, day)
            for trader in todays_order:
                trader.act(day, self.buy_markets, self.sell_markets, commodities_present,
                           closed_locations, directed_routes.get(trader))
                self.event_log.extend(e for e in trader.event_log if e.day == day)
                if verbose:
                    for e in trader.agent_event_log:
                        if e["day"] == day:
                            print(f"Day {day:3d} | {trader.name:<10} EVENT {e['name']} "
                                  f"@ {e['location']:<17} ({e['detail']})")
                    for t in trader.trade_log:
                        if t["day"] == day:
                            if t["action"] == "BUY":
                                print(f"Day {day:3d} | {trader.name:<10} BUY  {t['quantity']:6.1f} "
                                      f"{t['commodity']:<10} @ {t['location']:<17} price={t['price']:.2f} "
                                      f"-> {t['destination']:<17} via {t['route_type']:<4} fuel={t['fuel_cost_paid']:.2f} "
                                      f"(@{t['fuel_price']:.2f}/unit) eta={t['travel_days']}d")
                            elif t["action"] == "SELL":
                                print(f"Day {day:3d} | {trader.name:<10} SELL {t['quantity']:6.1f} "
                                      f"{t['commodity']:<10} @ {t['location']:<17} price={t['price']:.2f} "
                                      f"profit={t['profit']:+.2f}")
                            elif t["action"] == "REFUEL":
                                print(f"Day {day:3d} | {trader.name:<10} REFUEL {t['commodity']:<10} "
                                      f"@ {t['location']:<17} fuel={t['fuel_cost_paid']:.2f} "
                                      f"(@{t['fuel_price']:.2f}/unit) -- continuing to {t['destination']}")
                            elif t["action"] == "ATTACK":
                                print(f"Day {day:3d} | {trader.name:<10} ATTACK @ {t['location']:<17} "
                                      f"raided {t['destination']} for {t['profit']:+.2f}")
                            else:  # REPOSITION
                                reason = t["commodity"] if t["commodity"] is not None else "targets"
                                print(f"Day {day:3d} | {trader.name:<10} MOVE  (empty) {t['location']:<17} "
                                      f"-> {t['destination']:<17} via {t['route_type']:<4} chasing {reason:<10} "
                                      f"fuel={t['fuel_cost_paid']:.2f} eta={t['travel_days']}d")

            global_event = self._maybe_trigger_global_event(day)
            if verbose and global_event:
                commodity, event_name, affected = global_event
                print(f"\n*** Day {day}: GLOBAL COMMODITY EVENT - {event_name} ({commodity}) "
                      f"affecting: {', '.join(affected)} ***\n")

            location_event = self._maybe_trigger_location_event(day)
            if verbose and location_event:
                location, event_name, affected = location_event
                print(f"\n*** Day {day}: LOCATION-WIDE EVENT - {event_name} @ {location} "
                      f"affecting: {', '.join(affected)} ***\n")

            worldwide_event = self._maybe_trigger_worldwide_event(day)
            if verbose and worldwide_event:
                event_name, num_markets = worldwide_event
                print(f"\n*** Day {day}: WORLDWIDE EVENT - {event_name} "
                      f"affecting all {num_markets} markets ***\n")

            # Production/consumption are physical processes that keep
            # happening regardless of whether the port can currently load or
            # unload anyone -- only actual trading is blocked by a closure
            # (see Market.simulate_day's is_open branch), so this runs
            # unconditionally for every location, closed or not.
            for location in self.locations:
                location.daily_update()

            for market in self._all_markets():
                record = market.simulate_day(day, is_open=self.is_location_open(market.location_name))
                self.combined_history.append(record)
                if market.last_triggered_event is not None:
                    self.event_log.append(market.last_triggered_event)
                if verbose:
                    if record["closed"]:
                        print(f"Day {day:3d} | {record['location']:<17} | {record['commodity']:<10} "
                              f"({record['side']:<4}) | CLOSED -- no trading today")
                    else:
                        event_note = f"  [EVENT] {record['new_event']}" if record["new_event"] else ""
                        print(
                            f"Day {day:3d} | {record['location']:<17} | {record['commodity']:<10} "
                            f"({record['side']:<4}) | Price: {record['price']:8.2f} | "
                            f"Stockpile: {record['stockpile']:8.1f} (ref {record['reference_stockpile']:8.1f}) | "
                            f"Traded: {record['volume_traded']:6.1f}{event_note}"
                        )

            for trader in self.captains:
                trader.record_portfolio_snapshot(day, self.sell_markets)

    def save_history_csv(self, filepath: str):
        if not self.combined_history:
            return
        fieldnames = list(self.combined_history[0].keys())
        with open(filepath, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(self.combined_history)
        print(f"\nSaved combined daily history to {filepath}")

    def print_summary(self):
        print("\n--- Summary (final day price by location) ---")
        for commodity in self._commodities_present():
            print(f"\n{commodity}:")
            for (loc, com), market in self.buy_markets.items():
                if com != commodity:
                    continue
                prices = [r["price"] for r in market.history]
                print(f"  {loc:<17} [BUY ]  start={prices[0]:8.2f}  end={prices[-1]:8.2f}  "
                      f"min={min(prices):8.2f}  max={max(prices):8.2f}")
            for (loc, com), market in self.sell_markets.items():
                if com != commodity:
                    continue
                prices = [r["price"] for r in market.history]
                print(f"  {loc:<17} [SELL]  start={prices[0]:8.2f}  end={prices[-1]:8.2f}  "
                      f"min={min(prices):8.2f}  max={max(prices):8.2f}")

    def build_daily_agent_log(self) -> List[dict]:
        """
        One row per (day, agent): where it ended up, what it was doing,
        cash and net worth, that day's profit (change in net worth), and a
        plain-English summary of every trade/reposition and every
        agent-specific event that hit it that day. Every day gets a row --
        even a quiet one where the agent just sat in port -- so the log is
        a complete diary, not just a highlight reel.
        """
        log = []
        for trader in self.captains:
            # A company-owned transport has no individual starting_cash (funds
            # live on the Company pool -- see Captain.__init__),
            # so fall back to its first recorded net worth as the baseline
            # for day-over-day profit instead.
            if trader.starting_cash is not None:
                prev_value = trader.starting_cash
            elif trader.company is not None:
                prev_value = trader.company.starting_cash
            else:
                prev_value = 0.0
            for snapshot in trader.portfolio_history:
                day = snapshot["day"]
                actions_today = [t for t in trader.trade_log if t["day"] == day]
                events_today = [e for e in trader.agent_event_log if e["day"] == day]

                action_parts = []
                for t in actions_today:
                    if t["action"] == "BUY":
                        action_parts.append(
                            f"BUY {t['quantity']:.1f} {t['commodity']} @ {t['location']} "
                            f"-> {t['destination']} via {t['route_type']} (fuel {t['fuel_cost_paid']:.2f})"
                        )
                    elif t["action"] == "SELL":
                        action_parts.append(
                            f"SELL {t['quantity']:.1f} {t['commodity']} @ {t['location']} "
                            f"(profit {t['profit']:+.2f})"
                        )
                    elif t["action"] == "REFUEL":
                        action_parts.append(
                            f"REFUEL {t['commodity']} @ {t['location']} "
                            f"(fuel {t['fuel_cost_paid']:.2f}) -- continuing to {t['destination']}"
                        )
                    elif t["action"] == "ATTACK":
                        action_parts.append(
                            f"ATTACK @ {t['location']} raided {t['destination']} for {t['profit']:+.2f}"
                        )
                    else:  # REPOSITION
                        reason = t["commodity"] if t["commodity"] is not None else "targets"
                        action_parts.append(
                            f"REPOSITION {t['location']} -> {t['destination']} via {t['route_type']} "
                            f"(chasing {reason})"
                        )
                event_parts = [f"{e['name']} ({e['detail']})" for e in events_today]

                day_profit = snapshot["total_value"] - prev_value
                prev_value = snapshot["total_value"]

                log.append({
                    "day": day,
                    "agent": trader.name,
                    "location": snapshot["location"],
                    "status": snapshot["status"],
                    "cash": snapshot["cash"],
                    "net_worth": snapshot["total_value"],
                    "day_profit": round(day_profit, 2),
                    "actions": "; ".join(action_parts) if action_parts else "-",
                    "events": "; ".join(event_parts) if event_parts else "-",
                })
        return log

    def print_daily_agent_log(self):
        log = self.build_daily_agent_log()
        if not log:
            return
        print("\n--- Daily Agent Log ---")
        for row in log:
            print(
                f"Day {row['day']:3d} | {row['agent']:<10} | {row['location']:<17} "
                f"({row['status']:<10}) | cash={row['cash']:>10,.2f} | "
                f"net_worth={row['net_worth']:>10,.2f} | day_profit={row['day_profit']:>+9.2f} | "
                f"actions: {row['actions']} | events: {row['events']}"
            )

    def save_daily_agent_log_csv(self, filepath: str):
        log = self.build_daily_agent_log()
        if not log:
            return
        fieldnames = list(log[0].keys())
        with open(filepath, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(log)
        print(f"Saved daily agent log to {filepath}")

    def build_location_daily_reports(self) -> Dict[str, List[dict]]:
        """
        One row per (location, day): every commodity's buy/sell price
        there, total volume traded, whether the port was open or closed
        (and why, if closed), every event touching any of its markets that
        day, and a plain-English summary of what agents did there. Grouped
        by location name so each location's history reads as its own diary,
        the same way build_daily_agent_log() does per agent.
        """
        reports: Dict[str, List[dict]] = {loc.name: [] for loc in self.locations}
        if not self.combined_history:
            return reports

        max_day = max(r["day"] for r in self.combined_history)

        by_loc_day: Dict[Tuple[str, int], List[dict]] = {}
        for r in self.combined_history:
            by_loc_day.setdefault((r["location"], r["day"]), []).append(r)

        for location in self.locations:
            loc_name = location.name
            for day in range(1, max_day + 1):
                entries = by_loc_day.get((loc_name, day))
                if not entries:
                    continue

                is_closed = any(e["closed"] for e in entries)
                closure_note = ""
                if is_closed:
                    active = [c for c in self.closure_log
                              if c["location"] == loc_name and c["day"] <= day < c["day"] + c["duration_days"]]
                    if active:
                        closure_note = active[-1]["event"]

                price_parts = [f"{e['commodity']} ({e['side']})={e['price']:.2f}" for e in entries]
                total_volume = sum(e["volume_traded"] for e in entries)

                events = []
                for e in entries:
                    if e["new_event"] and e["new_event"] not in events:
                        events.append(e["new_event"])
                for e in entries:
                    if e["active_events"]:
                        for name in e["active_events"].split(", "):
                            if name and name not in events:
                                events.append(name)

                agent_parts = []
                for trader in self.captains:
                    for t in trader.trade_log:
                        if t["day"] != day or t["location"] != loc_name:
                            continue
                        if t["action"] == "BUY":
                            agent_parts.append(f"{trader.name} BUY {t['quantity']:.1f} {t['commodity']} "
                                                f"-> {t['destination']} via {t['route_type']}")
                        elif t["action"] == "SELL":
                            agent_parts.append(f"{trader.name} SELL {t['quantity']:.1f} {t['commodity']} "
                                                f"(profit {t['profit']:+.2f})")
                        elif t["action"] == "REFUEL":
                            agent_parts.append(f"{trader.name} REFUEL {t['commodity']} "
                                                f"(fuel {t['fuel_cost_paid']:.2f}) -- continuing to {t['destination']}")
                        elif t["action"] == "ATTACK":
                            agent_parts.append(f"{trader.name} ATTACK raided {t['destination']} "
                                                f"for {t['profit']:+.2f}")
                        else:
                            reason = t["commodity"] if t["commodity"] is not None else "targets"
                            agent_parts.append(f"{trader.name} REPOSITION -> {t['destination']} "
                                                f"via {t['route_type']} (chasing {reason})")
                    for e in trader.agent_event_log:
                        if e["day"] == day and e["location"] == loc_name:
                            agent_parts.append(f"{trader.name} EVENT {e['name']} ({e['detail']})")

                reports[loc_name].append({
                    "day": day,
                    "location": loc_name,
                    "status": "CLOSED" if is_closed else "OPEN",
                    "closure_reason": closure_note,
                    "prices": "; ".join(price_parts) if price_parts else "-",
                    "total_volume_traded": round(total_volume, 2),
                    "events": "; ".join(events) if events else "-",
                    "agent_activity": "; ".join(agent_parts) if agent_parts else "-",
                })

        return reports

    def print_location_daily_report(self, location_name: Optional[str] = None):
        """Print the daily report for one location, or every location if none is given."""
        reports = self.build_location_daily_reports()
        names = [location_name] if location_name else list(reports.keys())
        for name in names:
            rows = reports.get(name, [])
            if not rows:
                continue
            print(f"\n--- Daily Report: {name} ---")
            for row in rows:
                status = row["status"] if row["status"] == "OPEN" else f"CLOSED ({row['closure_reason']})"
                print(
                    f"Day {row['day']:3d} | {status:<40} | vol={row['total_volume_traded']:7.1f} | "
                    f"prices: {row['prices']} | events: {row['events']} | activity: {row['agent_activity']}"
                )

    def save_location_daily_reports_csv(self, output_dir: str):
        """Write one CSV per location -- e.g. rotterdam_port_daily_report.csv."""
        reports = self.build_location_daily_reports()
        os.makedirs(output_dir, exist_ok=True)
        for name, rows in reports.items():
            if not rows:
                continue
            slug = name.lower().replace(" ", "_")
            filepath = os.path.join(output_dir, f"{slug}_daily_report.csv")
            fieldnames = list(rows[0].keys())
            with open(filepath, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)
            print(f"Saved {name} daily report to {filepath}")

    def build_company_daily_reports(self) -> Dict[str, List[dict]]:
        """
        One row per (company, day): the shared cash pool balance that day,
        the combined mark-to-market cargo value and net worth across every
        transport the company owns, that day's profit (change in combined net
        worth), a fleet status breakdown (how many ships were in port vs.
        in transit), and a plain-English summary of every
        trade/reposition/agent-event any of its ships had that day.
        Grouped by company name so each company's history reads as its
        own diary, the same way build_daily_agent_log() does per transport and
        build_location_daily_reports() does per location.

        Since a Company's ships all share one cash pool (see Company.cash
        and Captain.cash), every transport's portfolio snapshot for a
        given day already carries the SAME cash figure -- so the pool
        balance for the day is read off just one transport rather than summed
        (summing would double-count it once per transport). Only cargo value
        is summed across the fleet, since each transport can be carrying
        something different (or nothing).

        Independent traders that don't belong to any Company aren't
        covered here (there's no shared pool to report on) -- see
        build_daily_agent_log() for a per-transport view that includes them.
        """
        reports: Dict[str, List[dict]] = {c.name: [] for c in self.factions}

        for company in self.factions:
            if not company.captains:
                continue

            days_seen = sorted({snap["day"] for t in company.captains for snap in t.portfolio_history})
            prev_net_worth = company.starting_cash

            for day in days_seen:
                day_snapshots = []
                for trader in company.captains:
                    snap = next((s for s in trader.portfolio_history if s["day"] == day), None)
                    if snap is not None:
                        day_snapshots.append((trader, snap))
                if not day_snapshots:
                    continue

                cash = day_snapshots[0][1]["cash"]  # identical across every transport in the company today
                cargo_value = sum(snap["cargo_value"] for _, snap in day_snapshots)
                net_worth = cash + cargo_value

                status_counts: Dict[str, int] = {}
                for _, snap in day_snapshots:
                    status_counts[snap["status"]] = status_counts.get(snap["status"], 0) + 1
                fleet_status = ", ".join(
                    f"{count} {status}" for status, count in sorted(status_counts.items(), key=lambda kv: kv[0].name)
                )

                action_parts = []
                event_parts = []
                realized_profit_today = 0.0
                fuel_spent_today = 0.0
                for trader, _ in day_snapshots:
                    for t in trader.trade_log:
                        if t["day"] != day:
                            continue
                        if t["action"] == "BUY":
                            action_parts.append(
                                f"{trader.name} BUY {t['quantity']:.1f} {t['commodity']} @ {t['location']} "
                                f"-> {t['destination']} via {t['route_type']} (fuel {t['fuel_cost_paid']:.2f})"
                            )
                            fuel_spent_today += t["fuel_cost_paid"]
                        elif t["action"] == "SELL":
                            action_parts.append(
                                f"{trader.name} SELL {t['quantity']:.1f} {t['commodity']} @ {t['location']} "
                                f"(profit {t['profit']:+.2f})"
                            )
                            realized_profit_today += t["profit"] or 0.0
                        elif t["action"] == "REFUEL":
                            action_parts.append(
                                f"{trader.name} REFUEL {t['commodity']} @ {t['location']} "
                                f"(fuel {t['fuel_cost_paid']:.2f}) -- continuing to {t['destination']}"
                            )
                            fuel_spent_today += t["fuel_cost_paid"]
                        elif t["action"] == "ATTACK":
                            action_parts.append(
                                f"{trader.name} ATTACK @ {t['location']} raided {t['destination']} "
                                f"for {t['profit']:+.2f}"
                            )
                            realized_profit_today += t["profit"] or 0.0
                        else:  # REPOSITION
                            reason = t["commodity"] if t["commodity"] is not None else "targets"
                            action_parts.append(
                                f"{trader.name} REPOSITION {t['location']} -> {t['destination']} "
                                f"via {t['route_type']} (chasing {reason})"
                            )
                            fuel_spent_today += t["fuel_cost_paid"]
                    for e in trader.agent_event_log:
                        if e["day"] == day:
                            event_parts.append(f"{trader.name}: {e['name']} ({e['detail']})")

                day_profit = net_worth - prev_net_worth
                prev_net_worth = net_worth

                reports[company.name].append({
                    "day": day,
                    "company": company.name,
                    "cash": round(cash, 2),
                    "cargo_value": round(cargo_value, 2),
                    "net_worth": round(net_worth, 2),
                    "day_profit": round(day_profit, 2),
                    "realized_profit_today": round(realized_profit_today, 2),
                    "fuel_spent_today": round(fuel_spent_today, 2),
                    "fleet_status": fleet_status,
                    "actions": "; ".join(action_parts) if action_parts else "-",
                    "events": "; ".join(event_parts) if event_parts else "-",
                })

        return reports

    def print_company_daily_report(self, company_name: Optional[str] = None):
        """Print the daily report for one company, or every company if none is given."""
        reports = self.build_company_daily_reports()
        names = [company_name] if company_name else list(reports.keys())
        for name in names:
            rows = reports.get(name, [])
            if not rows:
                continue
            print(f"\n--- Daily Report: {name} ---")
            for row in rows:
                print(
                    f"Day {row['day']:3d} | cash={row['cash']:>10,.2f} | cargo={row['cargo_value']:>9,.2f} | "
                    f"net_worth={row['net_worth']:>10,.2f} | day_profit={row['day_profit']:>+9.2f} | "
                    f"fleet: {row['fleet_status']:<24} | actions: {row['actions']} | events: {row['events']}"
                )

    def save_company_daily_reports_csv(self, output_dir: str):
        """Write one CSV per company -- e.g. atlas_shipping_daily_report.csv."""
        reports = self.build_company_daily_reports()
        os.makedirs(output_dir, exist_ok=True)
        for name, rows in reports.items():
            if not rows:
                continue
            slug = name.lower().replace(" ", "_")
            filepath = os.path.join(output_dir, f"{slug}_daily_report.csv")
            fieldnames = list(rows[0].keys())
            with open(filepath, "w", newline="") as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(rows)
            print(f"Saved {name} daily report to {filepath}")

    def plot_agent_comparison(self, filepath: str):
        """One chart comparing every agent's net worth over time -- useful
        once there's more than one transport in play."""
        if not self.captains:
            return
        fig, ax = plt.subplots(figsize=(10, 5.5))
        for trader in self.captains:
            if not trader.portfolio_history:
                continue
            days = [r["day"] for r in trader.portfolio_history]
            total_value = [r["total_value"] for r in trader.portfolio_history]
            ax.plot(days, total_value, linewidth=1.8, label=trader.name)
        # Only draw a starting-capital baseline if at least one trader has
        # its own standalone starting_cash; company-owned ships share a
        # pool (see Company.starting_cash) rather than an individual figure.
        baseline_candidates = [t.starting_cash for t in self.captains if t.starting_cash is not None]
        if baseline_candidates:
            ax.axhline(baseline_candidates[0], color="black", linestyle=":", alpha=0.5, label="Starting Capital")

        ax.set_title("Fleet Comparison: Net Worth Over Time")
        ax.set_xlabel("Day")
        ax.set_ylabel("Net Worth ($)")
        ax.grid(alpha=0.3)
        ax.legend(loc="best")

        plt.tight_layout()
        plt.savefig(filepath, dpi=150)
        plt.close(fig)
        print(f"Saved fleet comparison chart to {filepath}")

    def plot_by_commodity(self, output_dir: str):
        """One chart per commodity: a line per (location, side) that trades it."""
        os.makedirs(output_dir, exist_ok=True)
        for commodity in self._commodities_present():
            buy_relevant = [(loc, m) for (loc, com), m in self.buy_markets.items() if com == commodity]
            sell_relevant = [(loc, m) for (loc, com), m in self.sell_markets.items() if com == commodity]

            fig, ax = plt.subplots(figsize=(10, 5.5))
            for loc_name, market in buy_relevant:
                days = [r["day"] for r in market.history]
                prices = [r["price"] for r in market.history]
                ax.plot(days, prices, linewidth=1.8, linestyle="-", label=f"{loc_name} (Buy)")
            for loc_name, market in sell_relevant:
                days = [r["day"] for r in market.history]
                prices = [r["price"] for r in market.history]
                ax.plot(days, prices, linewidth=1.8, linestyle="--", label=f"{loc_name} (Sell)")

            ax.set_title(f"{commodity} Price by Location (Buy vs Sell)")
            ax.set_xlabel("Day")
            ax.set_ylabel("Price ($/unit)")
            ax.grid(alpha=0.3)
            ax.legend(loc="best")

            plt.tight_layout()
            safe_name = commodity.lower().replace(" ", "_")
            filepath = os.path.join(output_dir, f"{safe_name}_price_chart.png")
            plt.savefig(filepath, dpi=150)
            plt.close(fig)
            print(f"Saved {commodity} price chart to {filepath}")
