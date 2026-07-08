# Architecture

This document describes the design of the market-sim codebase in depth: the
economic model the simulation implements, and how each piece of that model
is actually built in code. It complements `README.md` (quick start) and
`CLAUDE.md` (terse guidance for coding agents) with a full walkthrough
suitable for someone extending or auditing the system.

## 1. What this simulates

market-sim is an agent-based simulation of commodity trading across a
network of locations. Each **Location** is an economic actor in its own
right: it **produces** some commodities and **consumes** others, keeps a
physical **stockpile** of each, and its willingness to trade — and the price
it trades at — is driven entirely by how full or empty that stockpile is
relative to a reference level. Independent, profit-seeking **Captain**
agents (each running a physical **Transport** — a ship, train, or plane)
discover arbitrage opportunities between locations, buy where a commodity is
in surplus, haul it across a routed geography paying fuel and time costs,
and sell where it's scarce. Some Captains act alone; others belong to a
**Company** that pools capital and actively coordinates its fleet.
**PirateBrigade**s hunt Company shipping for plunder, and an auto-created
**PoliceFleet** patrols to (currently passively) discourage them. A random
**event** system layers demand/supply shocks, per-transport mishaps,
per-company windfalls/setbacks, and whole-port closures on top of the
baseline economy. **World** owns and drives the whole thing one simulated
day at a time, and everything is fully reproducible from a small number of
independent random seeds.

The system can be driven three ways:

- `main.py` / `cli.py` — a scripted end-to-end run (procedurally generated
  world, or a custom world assembled from CSVs) that prints reports and can
  export CSV/JSON/matplotlib artifacts.
- `tests/` — pytest tests exercising a small, hand-authored CSV fixture
  world (`tests/fixtures/*.csv`) rather than the full 30-location procedural
  one.
- `exp-ui/` — a live ImGui/ImPlot desktop viewer (`SimState` wraps a `World`
  with play/pause/step controls; panels render fleet status, per-market
  history, the event log, and faction net worth in real time).

## 2. Module map and dependency chain

`sim/` is a package; `sim/__init__.py` re-exports its public API so
`from sim import X` and `import sim; sim.X` work the way they did when this
was a single `sim.py` file. The dependency chain runs roughly:

```
world_data (Location, geography) -> routes (Route/RouteType) -> markets (Market)
  -> transport (Transport/Ship/Train/Plane) -> crew (Crew/Sailor) -> captain (Captain)
  -> faction (Faction/Company/PirateBrigade) -> world (World, orchestrates everything)
```

| Module | Responsibility |
| --- | --- |
| `location.py` | `Location`, `TerminalType` — a trading hub's produce/consume/stockpile model |
| `commodity.py` | `Commodity` — per-commodity base price/sensitivity/deficit-boost/event-templates, and `build_commodities()` |
| `world_data.py` | The commodity roster (`COMMODITIES: Dict[str, Commodity]`) and procedurally generated geography (`LOCATIONS`, `LOCATION_COORDINATES`, `get_location`, `distance_between`, `travel_days_between`) |
| `routes.py` | `Route`/`RouteType`, the procedurally generated route network (`ROUTES`, `get_route`) |
| `pathfinding.py` | Dijkstra shortest-path routing over the Route network, restricted per-Transport |
| `events.py` | `Event` base class and its four kinds: `MarketEvent`, `TransportEvent`, `CompanyEvent`, `LocationClosure` |
| `markets.py` | `Market` — stockpile-deviation pricing and the day-to-day price update |
| `transport.py` | `Transport`/`Ship`/`Train`/`Plane`, `SHIP_CLASSES` presets |
| `crew.py` | `Crew` (bare identity, base class for anyone operating a Transport) and `Sailor` (generic waged deckhand) |
| `captain.py` | `Captain` — the trading agent, a `Crew` subclass |
| `names.py` | `random_name()` + per-language first/last name pools for naming Captains |
| `faction.py` | `Faction`/`Company`/`SoloTrader`/`PirateBrigade`/`PoliceFleet` |
| `csv_loaders.py` | Optional CSV-driven world/fleet building |
| `world.py` | `World` — orchestrates everything, runs the simulation, builds every report |
| `state.py` | `SimState` — wraps a `World` with play/pause/step controls for the live UI |

`cli.py` (root-level) sits on top of `sim/`: `build_world()` assembles a
`World` either procedurally or from CSVs, and `main()` runs it end to end
with console/CSV/JSON reporting.

### Mutable module-level world state

`world_data.LOCATIONS`/`LOCATION_COORDINATES`/`COMMODITIES` and
`routes.ROUTES` are reassigned wholesale when `cli.build_world()` builds a
world from CSVs, or when tests monkeypatch coordinates for a fixture world.
Any code that needs to observe such a reassignment must read the attribute
off the *owning* submodule (`sim.world_data.LOCATIONS`, `sim.routes.ROUTES`)
— not a copy re-exported on `sim` itself or captured via
`from .world_data import LOCATIONS` at another module's import time — since
every function that reads this state (`distance_between`, `get_route`,
`find_shortest_path`, ...) looks it up via its own defining module's
globals at call time. `pathfinding.py`'s adjacency cache is keyed by
`id(routes.ROUTES)` for the same reason: a reassignment gets a fresh cache
entry automatically.

## 3. Economic design: production, consumption, and stockpile-driven pricing

This is the heart of the simulation's economics, implemented across
`location.py`, `commodity.py`, and `markets.py`.

### 3.1 A Location is a produce/consume/stockpile machine

`Location` (in `location.py`) no longer specifies which commodities it
"buys" and "sells" as two independent hand-authored lists (that was the
model before this refactor). Instead, every commodity a Location deals in
has exactly one of two roles, and the role determines everything about how
that commodity's price and tradeability behave:

- **Produced** (`produced_commodities: Dict[str, float]`, commodity name ->
  units produced per day): added to the local stockpile every day. A
  Location always tries to sell off any positive stockpile of something it
  produces — it never "needs" what it makes, so all of it is surplus. A
  Captain **buys** a produced commodity from the Location.
- **Consumed** (`consumed_commodities: Dict[str, float]`, commodity name ->
  units consumed per day): drawn down from the local stockpile every day.
  A Location maintains a **minimum stockpile** (`min_stockpiles`) of
  anything it consumes, and only wants to buy more of it once its stockpile
  drops below that minimum — i.e. it's "running low." A Captain **sells** a
  consumed commodity to the Location.

A commodity can never be both produced and consumed at the same Location —
`Location.__post_init__` raises `ValueError` if the two dicts share a key.
This mutual exclusivity is what lets `World` build exactly one `Market`
per `(location, commodity)` pair (see §3.3), rather than the old model's
independent bid/ask Markets for the same commodity at the same place.

Fields:

```python
name: str
produced_commodities: Dict[str, float]  # commodity -> production rate/day, added to stockpile
consumed_commodities: Dict[str, float]  # commodity -> consumption rate/day, drawn from stockpile
stockpiles: Dict[str, float]            # commodity -> current stockpile (covers both roles)
min_stockpiles: Dict[str, float]        # commodity -> minimum target (consumed commodities only)
base_prices: Dict[str, float]           # commodity -> reference price (both roles)
fuel_price: float                       # flat, never-fluctuating Fuel price here
terminal_types: FrozenSet[TerminalType] # Port/Station/Airport/Platform
fence_fraction: float = 0.5             # black-market discount when pirates fence stolen cargo here
_reference_stockpiles: Dict[str, float] # snapshot of `stockpiles` at construction (see below)
```

Key methods:

- `can_buy(commodity)` — True if a Captain can buy here: the commodity is
  produced here **and** the stockpile is > 0 (there's something to sell).
- `can_sell(commodity)` — True if a Captain can sell here: the commodity is
  consumed here **and** the stockpile is below its minimum (the Location is
  running low and wants more).
- `reference_stockpile(commodity)` — the baseline a commodity's price is
  measured against (see §3.2): `min_stockpiles[commodity]` for something
  consumed here, or the **starting** stockpile (frozen at construction time
  in `_reference_stockpiles`, since the live `stockpiles` value moves every
  day) for something produced here.
- `daily_update()` — called once per Location per simulated day by `World`:
  adds each produced commodity's rate to its stockpile, and subtracts each
  consumed commodity's rate from its stockpile (floored at 0).

Why a *frozen* reference for produced commodities but a *live* one
(`min_stockpiles`) for consumed commodities? A consumed commodity's
"comfortable" level genuinely doesn't change over the run — the Location
always wants at least `min_stockpiles[c]` on hand. A produced commodity has
no such fixed target (it never runs out on its own, since production keeps
adding to it); the location's *starting* stockpile is used purely as the
"normal" baseline production levels were tuned around, so price reacts to
deviation from that opening state rather than to an arbitrary constant.

### 3.2 Stockpile-deviation pricing (`Market._stockpile_price`)

Every `Market` (see §3.3) computes its own day's price from how far the
Location's current stockpile sits from its reference level — not from any
order-book or synthetic buyer/seller curve (an earlier design used random
`Buyer`/`Seller` objects and a tatonnement clearing step; that's been
deleted entirely and replaced by this formula):

```python
def _stockpile_price(self) -> float:
    reference = self.location.reference_stockpile(self.commodity_name)
    if reference <= 0:
        return self.base_price
    current = self.location.stockpiles.get(self.commodity_name, 0.0)
    deviation = max(-2.0, min(2.0, (reference - current) / reference))
    commodity = world_data.COMMODITIES.get(self.commodity_name)
    sensitivity = commodity.price_sensitivity if commodity is not None else DEFAULT_PRICE_SENSITIVITY
    if deviation > 0 and self.side == "sell":
        boost = commodity.deficit_price_boost if commodity is not None else DEFAULT_DEFICIT_PRICE_BOOST
        sensitivity *= boost
    return max(0.5, self.base_price * (1 + sensitivity * deviation))
```

Reading this as a story: `deviation` is positive when the stockpile sits
**below** its reference (a produced commodity has been sold down, or a
consumed one has been drawn down toward/past its minimum) and negative when
it sits **above** the reference (a produced surplus is piling up unsold, or
a consumed commodity has just been topped up). Price moves in the same
direction as deviation, scaled by a per-commodity `sensitivity`
(`Commodity.price_sensitivity`, e.g. Crude Oil reacts harder than Gold) —
so scarcity raises price and surplus lowers it, symmetric by default,
clamped to a [-2, 2] deviation range and a $0.50 floor so a completely
depleted or wildly oversupplied commodity can't blow up or invert. The
`world_data.COMMODITIES.get(...)` lookup (rather than direct indexing)
falls back to the `DEFAULT_PRICE_SENSITIVITY`/`DEFAULT_DEFICIT_PRICE_BOOST`
constants for a commodity with no registered `Commodity` at all — e.g. a
custom `--locations-csv` world referencing a name never registered via a
matching `--commodities-csv` — so an unusual world configuration degrades
gracefully rather than crashing every time this market's price is computed.

**Deficit price boost.** On top of the symmetric formula, a location's
BUY side — where a Captain *sells into* the location (`side == "sell"`,
i.e. a consumed commodity) — can get an extra multiplier
(`Commodity.deficit_price_boost`) applied to sensitivity, but *only* while
it's running low (`deviation > 0`). This lets a commodity's shortage
premium climb harder than its glut discount eases off, deliberately
pulling more Captains toward selling it in when a location badly needs it.
Every commodity gets some boost (1.2x-2.0x, Coffee highest); the
surplus/glut side stays symmetric for all of them. This is intentionally
asymmetric and one-sided — it never touches the produced/BUY-from-location
side, and never touches the surplus case.

**`Commodity` (`commodity.py`)** is what actually carries `price_sensitivity`/
`deficit_price_boost` (and, see §7.1, `event_templates`) per commodity now —
previously these lived in three separate dicts (`markets.PRICE_SENSITIVITY`,
`markets.DEFICIT_PRICE_BOOST`, `events.EVENT_TEMPLATES`) all hand-keyed by
the same commodity name. `world_data.COMMODITIES: Dict[str, Commodity]` is
the single roster every one of those pieces of data now lives on, built by
`commodity.build_commodities(names, base_prices)` — which fills in the
ten default commodities' hand-tuned sensitivity/boost/event-template values
(`commodity._PRICE_SENSITIVITY`/`_DEFICIT_PRICE_BOOST`/`_BESPOKE_EVENT_TEMPLATES`/
`_GENERATED_EVENT_DRIVERS`), or the `DEFAULT_PRICE_SENSITIVITY`/
`DEFAULT_DEFICIT_PRICE_BOOST` constants and a generic four-event pack
(`_GENERIC_EVENT_DRIVERS`) for anything else, e.g. a custom
`--commodities-csv` roster. Fuel is deliberately **not** a `Commodity` —
see §3.4.

That raw stockpile price is then combined with the active `MarketEvent`
multipliers for the day (`price *= demand_mult / supply_mult` — see §7.1)
and a small Gaussian noise term, then floored at $0.50 again, in
`Market.simulate_day` (§3.3).

### 3.3 `Market`: one per (location, commodity, side)

`World` builds exactly one `Market` object per commodity a Location
produces (stored in `World.buy_markets`, keyed `(location_name, commodity)`
— `side="buy"`, since that's where a Captain buys) and one per commodity it
consumes (`World.sell_markets`, `side="sell"`, since that's where a Captain
sells). Every Location additionally and unconditionally gets a `Fuel`
entry in `buy_markets` (see §3.4) — Fuel never appears in
`produced_commodities`/`consumed_commodities` at all.

A `Market` holds a **reference to its owning `Location`** (not just its
name) so it can read/write the live stockpile directly:

```python
class Market:
    def __init__(self, commodity_name, location_name, location: Location,
                 starting_price, base_price, side, event_probability=0.10, fixed_price=False):
        ...
        self.location = location       # live link for pricing/availability/trades
        self.side = side               # "buy" or "sell"
        self.price = starting_price    # evolves day to day
        self.base_price = base_price   # fixed reference the stockpile formula measures against
        self.fixed_price = fixed_price # True only for Fuel -- never clears, never moves
        self.active_events: List[MarketEvent] = []
        self._volume_traded_today = 0.0
```

Three properties/methods let `Captain` interact with a Market without
reaching into `Location` directly:

- **`is_available`** — whether a Captain can trade here *today*: always
  `True` for the flat, unlimited Fuel market; otherwise
  `location.can_buy(commodity)` (buy side) or `location.can_sell(commodity)`
  (sell side).
- **`available_quantity`** — how much can actually be bought here today.
  On the buy side, this is a **hard physical cap**: the Location's current
  stockpile (a Captain literally cannot buy more of a produced commodity
  than is sitting there). On the sell side there's no cap — a Location
  always accepts a Captain's *full* cargo while it's in deficit, avoiding
  partial-fill bookkeeping. Fuel is never capped either way.
- **`apply_trade(quantity)`** — the point where a Captain's trade
  **physically moves the Location's stockpile**: buying (`side == "buy"`)
  draws the produced commodity's stockpile down (floored at 0); selling
  (`side == "sell"`) adds to the consumed commodity's stockpile. This is
  what gives the simulation real supply/demand tension: production adds to
  a produced commodity's stockpile and trading removes it; consumption
  removes from a consumed commodity's stockpile and trading replenishes it.
  A no-op for a fixed-price (Fuel) market. Also accumulates
  `_volume_traded_today`, reported in the daily record and reset each day.

`Market.simulate_day(day, is_open)` is called once per Market per day by
`World._run_day` (§4), after every Captain has already acted for the day
(so agents always trade at the *previous* day's closing price — see
§4). Three branches:

1. **Fixed-price** (Fuel): no clearing, no events, price never moves — just
   a flat daily record so its history has the same shape as every other
   Market's.
2. **Closed port** (`is_open=False`): price frozen, no *new* local event
   rolls, but existing active events keep ticking down in the background.
3. **Normal**: maybe roll a new `Local` `MarketEvent` for this Market (see
   §7.1), compute `new_price = _stockpile_price() * demand_mult / supply_mult`,
   apply `random.gauss(0, 0.01)` noise, floor at 0.5, and record.

The per-day record dict includes `day`, `location`, `commodity`, `side`,
`price`, `stockpile`, `reference_stockpile`, `volume_traded`,
`demand_multiplier`, `supply_multiplier`, `active_events`, `new_event`, and
`closed` — this is the shape `World.combined_history`,
`build_location_daily_reports`, and `plot_by_commodity` all consume.

### 3.4 Fuel is deliberately outside this system

Fuel is priced per-location (`Location.fuel_price`, seeded from
`world_data.FUEL_BASE_PRICE`) but **never fluctuates** and is **never**
part of the produce/consume/stockpile model at all — it isn't tracked as a
stockpile, doesn't appear in `produced_commodities`/`consumed_commodities`,
is **not** a `Commodity` (it has no entry in `world_data.COMMODITIES`), and
its `Market` is always constructed with `fixed_price=True`. Every Location,
including the three pure "fuel depot" locations (which trade nothing
else), always has a buyable Fuel market. This mirrors the real intent:
Fuel is an input every Transport needs, not something arbitraged for its
own sake.

### 3.5 Procedural generation (`world_data._generate_locations`)

The default 30-location world is built once, procedurally, from a fixed
seed (`WORLD_GEN_SEED = 2024`) using a dedicated `random.Random` stream —
independent of the simulation's own trading randomness, so the network
layout is reproducible across runs regardless of what agents do. For each
non-depot location:

- Sample 2-4 commodities into `produced_commodities` (rate `U(3, 15)`/day
  each), then sample 2-4 *different* commodities (from what's left) into
  `consumed_commodities` (same rate range) — guaranteeing no overlap.
- For each produced commodity: `stockpiles[c] = rate * U(10, 25)` (10-25
  days of accumulated output as the starting/reference level) and
  `base_prices[c] = COMMODITIES[c].base_price * U(0.85, 1.15)`.
- For each consumed commodity: `min_stockpiles[c] = rate * U(5, 10)` (a
  5-10 day buffer) and `stockpiles[c] = min_stockpiles[c] *
  consumed_stockpile_factor` (default `2.0` — every location starts
  comfortably above the point where it would buy) and the same base-price
  randomization.
- `fuel_price = FUEL_BASE_PRICE` (`1.25`) — identical everywhere in the
  procedural world (still independently overridable per-location via a
  custom CSV).
- Terminal types: always includes `Port`, plus 0-2 random other kinds,
  except `Platform`, which is exclusive (a location drawing it gets *only*
  `Platform`, enforced in `Location.__post_init__`).

Fuel depot locations get empty produce/consume/stockpile dicts and only the
flat `fuel_price` — they exist purely as refueling stops.

Geography (`_generate_coordinates`) scatters every location across a
synthetic 3000x3000 plane using a *different* independent RNG stream
(`seed + 1`), rejecting candidates within 200 units of an already-placed
point so no two locations ever collapse to the same spot. Distance between
any two locations is just Euclidean distance over these coordinates
(`distance_between`); `travel_days_between` converts that to whole days at
a given speed (`ceil(distance / speed)`, minimum 1 day even for the same
location — an instant spread-capture trade still takes a day to settle).

## 4. Geography and routing

### 4.1 Routes (`routes.py`)

A `Route` is an undirected, typed connection between two locations
(`RouteType.Sea` / `Railroad` / `Air`), with `distance` derived once at
construction from the same `LOCATION_COORDINATES` everything else uses — it
never invents a second source of geographic truth. `ROUTE_TERMINAL_COMPATIBILITY`
maps each `RouteType` to the `TerminalType`(s) both endpoints must share at
least one of (`Sea` needs `Port` or `Platform`; `Railroad` needs `Station`;
`Air` needs `Airport`). `_generate_routes` builds one `Route` for every
location pair sharing a compatible terminal type, picking randomly among
the compatible types when more than one applies (a third independent RNG
stream, `seed + 2`), optionally trimming pairs farther apart than
`max_distance * ROUTE_TYPE_DISTANCE_SCALE[route_type]` (Air gets the full
cap, Sea 80%, Railroad 50% — the shortest-hop mode is trimmed the most).
`get_route(a, b)` looks up the direct Route regardless of argument order.

### 4.2 Pathfinding (`pathfinding.py`)

Dijkstra's algorithm, weighted by `Route.distance`, restricted to whichever
edges a `can_use_route` predicate (almost always `Transport.can_use_route`)
accepts — so a landlocked `Train` never gets offered a leg it would have to
sail or fly. The full (unfiltered) adjacency graph is the expensive part to
build and is identical for every Transport, so it's built once and cached
(`prime_route_graph_cache`, called by `World.__init__`) rather than rebuilt
per-lookup; per-Transport restrictions are applied cheaply while walking
the cached graph. The cache key is `id(routes.ROUTES)`, so a wholesale CSV
reassignment gets a fresh cache automatically. `find_shortest_path` can also
`avoid_nodes` (used for currently-closed locations as intermediate stops —
though a *closed* location is still fair game to pass *through*, only
actually docking/refueling there is off-limits) and returns the ordered
list of `Route` edges to traverse, or `None` if no path exists at all for
that Transport.

This is what lets a Captain plan a genuine multi-hop voyage through
intermediate locations when no direct Route exists, not just a single
direct connection.

## 5. Transport and Crew

### 5.1 `Transport` (`transport.py`)

Pure hardware, decoupled from the trading agent that operates it: cargo
capacity, speed, fuel efficiency (loaded and ballast are tracked
separately), a flat per-voyage fixed shipment cost, and a fuel tank
capacity. `TransportStatus` is `AtLocation` / `InTransit` / `Inactive` (the
last one meaning its owning Faction couldn't afford its crew wages for the
day — see §6.3 — so it stops burning fuel or making progress until it can
pay again). By default a `Transport` is **unrestricted**
(`allowed_route_types() -> None`, meaning any `RouteType` is usable) — this
is `Ship`'s behavior. `Train` and `Plane` genuinely override
`allowed_route_types()` to just `{Railroad}` / `{Air}` respectively, so
`Captain.can_use_route` (really `Transport.can_use_route`) naturally
excludes any leg they can't physically travel from every route-planning
method, the same way a closed port is excluded.

`current_fuel: Optional[float]` is the live fuel gauge; `None` (the
default for `Ship`/`Train`/`Plane` base specs) means this Transport doesn't
track fuel at all and never needs refueling regardless of trip length —
used by `SailingVessel` (wind-powered, burns no fuel, never refuels).
`needs_refuel(required)`, `consume_fuel(amount)`, `refuel(amount)` are the
gauge's whole interface.

`SHIP_CLASSES` offers five off-the-shelf presets spanning the
capacity/speed/efficiency trade-off space: `Speedster` (small, fast, cheap
fuel-wise per trip but limited hold), `Handysize`, `Panamax`, `Capesize`
(large, slow, big hold, more capital tied up per voyage), and
`SailingVessel` (zero fuel cost either way, `current_fuel=None`).

### 5.2 `Crew` (`crew.py`)

`Crew` is a bare identity/assignment layer: a name, which `Transport` (if
any) it currently runs, and a `daily_wages` figure owed to its owning
Faction only while that Transport is actually `InTransit` (idle time in
port is free). `Sailor` is a generic waged deckhand with a nonzero default
wage, used to pad a Transport's roster up to its `crew_requirement` beyond
the Captain (who is itself a `Crew` member and costs nothing extra by
default). `Faction.__init__` (§6) is what actually assembles a Transport's
`crew` list.

## 6. Captain: the trading agent

`Captain` (`captain.py`) subclasses `Crew` and adds all trading-agent
behavior on top: cash, risk threshold, price impact, route planning, and
event exposure. It occupies exactly one location at a time and runs a
single `Transport` — there's no teleportation and no parallel shipments;
while `InTransit` it's committed to its destination and can't act again
until it arrives.

### 6.1 Daily action loop (`Captain.act`)

Called once per day by `World._run_day` for every Captain, in an order
decided by `agent_order_fn` (default `random_agent_order`: a fresh shuffle
each day, so first-mover advantage on a shared Market price doesn't
structurally favor whichever agent happens to sit first in a list):

1. Roll for a `TransportEvent` today (§7.2) and tick down any already
   active.
2. If `InTransit`: pay today's crew wages (or go `Inactive` if the Faction
   can't afford them), burn fuel, tick down `days_remaining`. If arrival day,
   call `_arrive` — which either advances to an intermediate stop on a
   multi-hop path (refueling there if needed and not closed) and stays
   `InTransit`, or genuinely docks at the final destination.
3. Once in port (already was, or just arrived): if the current port is
   closed, do nothing further this turn. Otherwise sell any cargo it's
   carrying if the destination Market is `is_available` (§3.3); if it's
   grounded (from a "delay" `TransportEvent`) or this is the very day it
   just arrived, stop here — a Transport always spends at least one night
   in port before departing again, even if a fresh opportunity already
   clears the bar.
4. If empty-handed and not otherwise blocked: either follow a
   `directed_route` a `Faction` supplied (see §8) — a buy-here-and-depart
   trade route, or a bare REPOSITION directive — or plan its own route
   autonomously (`_plan_and_depart`).

### 6.2 Route scoring and the daily-return threshold

`_route_economics` computes the full cost/time picture for shipping
`quantity` units from an origin to a destination: cargo cost at the current
buy price, fuel cost (leg by leg, each priced at *that* leg's origin's live
Fuel price, since a Dijkstra path may be multi-hop), the Transport's flat
`fixed_shipment_cost`, and crew wages for every day the voyage takes
(`Crew.daily_wages`, owed only while `InTransit`). It returns, among other
things, `daily_return_pct = expected_profit / total_cost / total_days` —
**profit per day of capital tied up**, not raw profit. This is what lets a
Captain fairly compare a short cheap route against a long expensive one: it
will pass up a wide-but-slow-and-costly route in favor of a
narrower-but-fast-and-cheap one, and stays in port entirely if fuel and
fixed costs eat the whole spread. A trip is infeasible
(`daily_return_pct = -1.0`) if no path exists at all, or if any single leg
alone needs more fuel than the Transport's tank could ever hold, even
freshly topped up.

`_find_best_local_route` only considers commodities **buyable right where
the Captain is standing now** (i.e. `Location.can_buy` is true there —
produced with positive stockpile) and only candidate destinations that
`is_available` on the sell side (running low on that commodity). Trial
quantity is capped by cargo capacity, cash, **and** `available_quantity`
(the physical stockpile cap on the buy side — §3.3). Only routes clearing
`min_daily_return_pct` (a per-Captain configurable threshold) are
candidates; the single best by daily return is chosen.

`_execute_local_route` re-derives quantity/price/profitability from *live*
market state at execution time (which may have moved since the route was
scored, especially under Company-coordinated dispatch — §8) and skips the
trade entirely if it no longer clears the bar. On success it pays upfront
(cargo + first-leg fuel + fixed fee), calls `origin_market.apply_trade(quantity)`
(physically depleting the Location's stockpile — §3.3), nudges the origin
Market's price via `_apply_price_impact` (see below), and stores the
remaining multi-hop path so the Transport keeps following it leg by leg.

**Repositioning.** If nothing at the current location clears the bar,
`_consider_repositioning` scans the *entire* network for the single best
`(commodity, origin, destination)` opportunity anywhere else. If sailing
there empty (burning ballast fuel, no cargo) and then executing that trade
would still clear a bar — with the extra travel time and ballast fuel
folded in — the agent departs empty toward that origin. Since this is a
speculative bet on an opportunity that might not survive the extra transit
time, the bar for repositioning is stiffer:
`min_daily_return_pct * reposition_return_multiplier`.

**Price impact.** A Captain is a price-taker but its own trades also nudge
the Market price a little: `_apply_price_impact` moves `market.price` by
`price_impact * units / (units + 50)`, up when buying, down when selling —
a no-op for the fixed-price Fuel market. This means the same arbitrage gap
narrows a bit from the agent's own activity, just like a real trader
competing away an inefficiency — and it composes with, but is entirely
separate from, the stockpile-deviation formula that sets the *baseline*
price each day (§3.2).

### 6.3 Crew wages and `Inactive` transports

`_daily_crew_cost` sums `daily_wages` across everyone crewing the
Transport (the Captain included). It's charged every day the Transport is
`InTransit`, on top of fuel/fixed fees, and is factored into
`_route_economics`'s profitability math. If a Faction can't afford a given
day's wages while a Transport is underway, the crew simply stops working:
`status` flips to `Inactive` (no fuel burn, no travel progress) and it's
automatically excluded from `Company`/`PirateBrigade.direct_fleet()`
coordination (`is_idle_in_port` only returns `True` for `AtLocation`) until
it can afford to pay again.

### 6.4 Portfolio tracking

`record_portfolio_snapshot` (called once per Captain per day by `World`)
marks its net worth to market: cash on hand plus cargo value valued at
either the current location (if in port) or the destination's current
price (if mid-voyage), falling back to cost if no sell Market exists to
mark against.

## 7. The event system

`events.py` defines a shared `Event` dataclass base and four concrete
kinds, all logged into `World.event_log` (a flat, chronological list of
every real `Event` object ever generated, of any kind) so a single caller
(e.g. `SimState`, or a report builder) gets one unified feed instead of
stitching several formats together.

Every `Event` carries:

| Field | Meaning |
| --- | --- |
| `type` | Category: `"Local"`/`"Global"`/`"Location"`/`"Worldwide"` (MarketEvent flavors), `"Agent"` (TransportEvent), `"Company"` (CompanyEvent), `"Closure"` (LocationClosure) |
| `scope` | How broadly it applies: a Location's name for anything tied to one location (a Local MarketEvent, a Location-wide MarketEvent, or a LocationClosure); `"Global"` for anything with no single-location focus (a Global commodity-wide MarketEvent or a Worldwide one); `"Transport"` for a TransportEvent; `"Company"` for a CompanyEvent |
| `subject` | The specific thing it's about: a commodity name for a MarketEvent (blank for Location-wide/Worldwide, which aren't about any one commodity), a Captain's name for a TransportEvent, a Company's name for a CompanyEvent, or a Location's name for a LocationClosure |
| `day` / `duration` / `days_remaining` | When it started, how long it lasts, and how much is left — `tick()` advances one day and returns whether it's still active |
| `message` | Human-readable description (the template's `name`) |

`scope` and `subject` intentionally answer two different questions:
*scope* is a coarse bucket (which of a handful of categories), *subject* is
the specific instance within that bucket.

### 7.1 `MarketEvent` — demand/supply shocks

Temporarily multiplies a commodity's `demand_multiplier`/`supply_multiplier`
for `duration_days`. If `location` is set, it's **Local** (one Market at one
location); if `None`, it's either **Global** (one commodity, every location
that trades it) or **Worldwide** (every market everywhere) — `World`
disambiguates and stamps the real `type` after construction, since a bare
`location=None` can't tell the two apart on its own. An optional
`commodity` field (set by the caller when known) drives `subject` — left
`None` for Location-wide/Worldwide events, which by design aren't about any
single commodity.

Four independently-probabilistic scopes, forming a scope-x-specificity
matrix:

|  | one commodity | every commodity |
| --- | --- | --- |
| **one location** | `Commodity.event_templates` (Local, rolled per-`Market` via `event_probability`) | `LOCATION_EVENT_TEMPLATES` (Location-wide, `location_event_probability`) |
| **every location** | `Commodity.event_templates` (Global, `global_event_probability`) | `WORLD_EVENT_TEMPLATES` (Worldwide, `worldwide_event_probability`) |

`Commodity.event_templates` (`commodity.py`, populated by
`build_commodities` — see §3.2) is commodity-specific (a heatwave affects
oil demand differently than gold demand): the four original commodities
(Crude Oil, Copper, Wheat, Gold) have fully bespoke template lists
(`commodity._BESPOKE_EVENT_TEMPLATES`); six more (Silver, Natural Gas,
Coffee, Cotton, Iron Ore, Aluminum) use `_make_commodity_events` with
hand-picked driver phrases (`_GENERATED_EVENT_DRIVERS`) to generate a
standard boom/disruption/glut/slump four-pack rather than hand-writing
every line; anything else (e.g. a custom `--commodities-csv` commodity)
gets the same four-pack generated from fully generic driver phrases
(`_GENERIC_EVENT_DRIVERS`) instead of being left without any events at all.
Both `Market._maybe_trigger_local_event` and `World._maybe_trigger_global_event`
look up `world_data.COMMODITIES.get(commodity)` and skip the roll entirely
(rather than crashing) if that commodity has no registered `Commodity` or
no `event_templates` — the same graceful-degradation the pricing formula
uses (§3.2).

A Global or Worldwide event applies a **separate `MarketEvent` copy** to
every affected Market (so each one ticks its own copy down independently),
plus a `tracking_event` World keeps its own bookkeeping for
(`active_broad_events`, ticked daily and pruned on expiry;
`broad_event_log`, kept forever including finished ones, e.g. for a chart
that wants to mark every day a now-expired event was active).

`Market._maybe_trigger_local_event` (§3.3) rolls the fourth, finest-grained
scope directly, once per Market per day.

### 7.2 `TransportEvent` — per-agent shocks

Hits one specific Transport rather than any market; doesn't move prices,
changes what the Transport can do:

- `"delay"` — adds `magnitude` days to the current voyage (if in transit)
  or to time stuck at the dock (if in port).
- `"cargo_loss"` — loses `magnitude` (a 0-1 fraction) of cargo currently
  held; only rolled if there's cargo to lose.
- `"cash_gain"`/`"cash_loss"` — a one-off dollar amount added to/taken
  from cash (floored at 0 on loss).
- `"fuel_discount"`/`"fixed_cost_discount"` — cuts fuel consumption
  (loaded and ballast) or the flat per-voyage fee by `magnitude` for
  `duration_days`; these two persist in `Captain.active_agent_events` and
  tick down like a Market's active events, capped at 90% total discount
  across stacked events of the same kind (`_active_discount`).

`scope` is always `"Transport"` (set in `__post_init__`); `subject` (the
Captain's name) is stamped by `Captain._apply_agent_event` once the event
is tied to a specific agent, since it's built generically from a template
before that.

### 7.3 `CompanyEvent` — whole-Company cash shocks

A random windfall or setback that moves a whole `Company`'s shared cash
pool directly — not tied to any single Transport or market. `kind` is
`"cash_gain"` (added to the pool) or `"cash_loss"` (subtracted, floored at
0). `scope` is always `"Company"`; `subject` (the Company's name) is
stamped by `World._maybe_trigger_company_events` once it's known.

Rolled by `World` independently, once per plain `Company` per day, at
`company_event_probability` (default 0.05 — 5%). Critically, this uses
`type(faction) is Company` — an *exact* type check, not `isinstance` —
since `SoloTrader` is a `Company` subclass but doesn't pool cash (there's
no single shared balance for a CompanyEvent to move), and `PirateBrigade`/
`PoliceFleet` aren't `Company` at all. `COMPANY_EVENT_TEMPLATES` supplies
six example events (insurance settlements, favorable financing, government
subsidies for gains; regulatory fines, tax audits, embezzlement scandals
for losses), each `duration_days=1` (one-off — there's no notion of an
ongoing Company-wide discount the way `TransportEvent`'s two discount
kinds work per-Transport).

### 7.4 `LocationClosure` — whole-port shutdowns

A binary shock distinct from every demand/supply-multiplier event above:
while active, a location's port is simply **closed** — no buying, selling,
or refueling there at all, for anyone, until it reopens (`World.closed_locations`
tracks these directly and `Market.simulate_day`/`Captain.act` consult
`is_location_open`/`closed_locations` rather than this going through the
`MarketEvent` multiplier system). `scope` and `subject` are both the
Location's name. Ships already docked wait it out; ships en route still
arrive but can't unload until it reopens. A closed port is still a valid
*intermediate* stop for a multi-hop Dijkstra path — a ship can pass
alongside one without docking — only actually refueling/trading there is
off-limits.

Production and consumption (`Location.daily_update`) are **not** gated by
closure — they're physical processes that keep happening regardless of
whether the port can currently load or unload anyone; only actual trading
is blocked.

## 8. Faction hierarchy: ownership, pooling, and coordination

`Faction` (`faction.py`) is the base ownership/bookkeeping layer: who
belongs to a fleet, how much money the group collectively holds
(`self.cash`, a single shared pool every member Transport's `cash` property
reads/writes through — see `Captain.cash`), and combined net worth/profit.
On its own it does nothing active: its ships plan and execute trades
entirely autonomously, exactly as if unowned (`direct_fleet()` raises
`NotImplementedError`, which `World.run()` treats the same as "no
directives at all").

`pools_cash: bool` (class attribute) controls whether captains share one
balance or each keep their own private balance
(`Captain._cash`/`Captain.cash` property dispatches on this). It's `True`
by default (`Faction`, `Company`) and overridden `False` on `SoloTrader`
and `PirateBrigade`.

`Faction.__init__` takes `(Transport, Captain, home_location)` triples —
callers build each Captain themselves (full control over strategy
parameters); `Faction` just wires `captain.transport`/`captain.location`
and pads out each Transport's `crew` roster with `Sailor`s up to its
`crew_requirement`.

### 8.1 `Company` — active coordinated routing

Adds two things on top of plain `Faction`:

- **Coordinated routing** (`direct_fleet`, called once per day by
  `World._run_day`): every currently idle Transport (`is_idle_in_port`) has
  its best local route scored exactly as it would score its own, and
  they're assigned in descending order of daily return. If two idle ships
  would claim the same `(commodity, destination)` pairing, the second is
  offered its next-best *different* option instead (`exclude_routes`)
  rather than piling onto one route while another opportunity elsewhere
  goes unclaimed — spreading fleet coverage.
- **Shared capital**: since every Transport's `cash` *is* the pool, sizing
  a trade already naturally accounts for the fleet's entire cash position,
  no separate transfer step needed.

Repositioning (§6.2) stays autonomous per-Transport even for
Company-owned ships, since it's already a network-wide search.

`SoloTrader` is a `Company` subclass with `pools_cash = False`: same
coordinated dispatch, but each captain keeps their own private balance —
modeling a loose association of independent operators sharing dispatch
without sharing capital.

### 8.2 `PirateBrigade` — raiding

`direct_fleet` moves every idle pirate Transport toward wherever watched
Company Transports are currently most concentrated (re-scanned every
`laziness` days, not necessarily daily, to avoid recomputing an expensive
network-wide scan every single day). If an idle pirate finds itself sharing
a location with a watched Company Transport (`_co_located_target`), it
attacks instead of repositioning — provided its own `carousing` (shore-leave
distraction, see below) isn't over `max_carousing_to_attack` and no watched
`PoliceFleet` has a Ship at that same location (`_police_present_at`).

`_attack` steals `raid_fraction` of the victim's *own* cash — but only if
the victim's Company doesn't pool cash (a pooling Company's shared purse is
untouchable; only `SoloTrader` or similar non-pooling victims lose cash
directly). If the victim carries cargo, the pirate seizes and fences all of
it at the current location's live sell price times that Location's own
`fence_fraction` (a black-market discount) — the victim keeps neither the
goods nor their market value. Logged in the pirate's own `trade_log`
(`"action": "ATTACK"`) and the victim's `agent_event_log`
(`"kind": "cash_loss"`) — not as a structured `Event`; there's no
`Attack`/`Trade` dataclass, so the Event Log UI panel deliberately doesn't
show this activity (see §10).

**Carousing.** Every pirate Ship sitting `AtLocation` (idle or not) spends
`carousing_cost_per_crew` per crew member on shore leave each day, if
affordable; `carousing` then rises by `carousing_increase_per_day`. If that
pushes it over `max_carousing`, the crew blacks out: `carousing` resets to
0 and the Captain is grounded for a day (`grounded_days_remaining`), same as
an agent-event delay — it won't attack, reposition, or do anything else
that day.

A `PirateBrigade` can only crew `Ship`s (constructor raises `ValueError`
naming any non-Ship Transport in its roster).

### 8.3 `PoliceFleet` — passive law enforcement

Currently pure random-wandering patrol: every idle Ship moves to a
uniformly random, open, reachable location every `patrol_interval_days`.
`targets` (the `PirateBrigade`s it watches) exists for a future smarter
`direct_fleet` without needing another constructor change — today its only
effect is deterring nearby pirate attacks via `PirateBrigade._police_present_at`.
Government-funded: always pools cash into a literal `float("inf")` pool
(not caller-configurable, unlike every other Faction subclass) — this is
why the "Faction Net Worth" UI panel explicitly excludes `PoliceFleet`
(§10), and why company daily reports/the JSON exporter show it with
effectively infinite cash.

Every `World` auto-creates its own `PoliceFleet` ("Coast Guard",
`num_police_ships` plain Ships home-ported randomly across the world's
locations) watching every `PirateBrigade` passed into `factions`.

## 9. `World`: orchestration and the daily loop

`World.__init__` builds one `Market` per `(location, commodity, side)`
combination from every Location's produce/consume dicts plus the
unconditional Fuel market (§3.3, §3.4), primes the pathfinding cache
(§4.2), auto-creates the `PoliceFleet` (§8.3), and flattens every Captain
(independent traders plus every Faction's fleet) into `self.captains`.

Six independent, per-day probabilistic event schedulers are configured at
construction time (defaults in parentheses):

- `global_event_probability` (0.06) — Global MarketEvent
- `local_event_probability` (0.08) — per-Market Local MarketEvent, passed
  through to each `Market`
- `location_event_probability` (0.04) — Location-wide MarketEvent
- `worldwide_event_probability` (0.02) — Worldwide MarketEvent
- `location_closure_probability` (0.01, 0.015 in `cli.py`'s default world)
  — LocationClosure
- `company_event_probability` (0.05) — CompanyEvent, rolled independently
  per plain `Company`

### 9.1 `_run_day(day, commodities_present, verbose)` order of operations

1. **Tick location closures** — reopen anything whose duration expired,
   *before* anyone acts today, so agents see today's actual port status.
2. **Tick broad (Global/Location/Worldwide) MarketEvents** down a day.
3. **Maybe trigger a new location closure.**
4. **Maybe trigger CompanyEvents** — independently per plain Company.
5. **Faction direction**: call `direct_fleet()` on every Faction (a plain
   `Faction`'s `NotImplementedError` is swallowed — its ships fall through
   to autonomous behavior); merge every returned directive into
   `directed_routes`.
6. **Agent action loop**: `agent_order_fn(captains, day)` decides today's
   acting order (default: fresh shuffle); each Captain's `act()` is called
   with `directed_routes.get(trader)`. Every trade/event a Captain logged
   today is pulled into `World.event_log`/console output.
7. **Maybe trigger a Global MarketEvent, a Location-wide one, then a
   Worldwide one** (each independently probabilistic).
8. **Apply one day of production/consumption** to every Location
   (`location.daily_update()`) — unconditionally, even for a closed
   location, since it's a physical process that doesn't stop just because
   the port can't load/unload today.
9. **Clear every Market** (`market.simulate_day`) — this is where each
   `(location, commodity, side)`'s price for the day actually updates, and
   where the Local per-Market MarketEvent scope rolls.
10. **Record every Captain's portfolio snapshot** for the day.

Step 6 (agents act) happens *before* step 8/9 (stockpiles update, prices
clear) — so every day, agents make their buy/sell decisions against
**yesterday's closing price**, and the market moves in response to both
today's production/consumption *and* whatever they just traded, ready for
tomorrow.

`World.run(num_days)` calls `_run_day` in a loop; `World.step()` is the
same thing one day at a time, tracking its own internal day counter — used
by the live UI (`SimState.step`) so it isn't committed to a fixed
`run(num_days)` up front.

### 9.2 Reporting

`World` owns every report/export path:

- `combined_history` — every Market's daily record, flat.
- `build_daily_agent_log` / `print_daily_agent_log` /
  `save_daily_agent_log_csv` — one row per (day, Captain): location,
  status, cash, net worth, day's profit, and a plain-English action/event
  summary.
- `build_location_daily_reports` / ...`_csv` — one row per (day, Location):
  prices, total volume traded, open/closed status (and why), events, and
  agent activity there that day.
- `build_company_daily_reports` / ...`_csv` — one row per (day, Faction):
  pool balance (read once, not summed, to avoid double-counting a shared
  pool across every Transport), combined cargo value/net worth, day's
  profit, realized profit, fuel spent, fleet status breakdown, and activity.
- `Faction.build_daily_json_report` / `save_daily_json_report` — a full
  nested per-day dump (every Transport field via `dataclasses.asdict`,
  portfolio snapshot, and that day's trades/events) rather than a flattened
  CSV table.
- `plot_agent_comparison` / `plot_by_commodity` — matplotlib PNG charts.

## 10. CSV-driven world building and the CLI

`csv_loaders.py` mirrors `tests/conftest.py`'s fixture-loading helpers,
generalized to build a whole world (or fleet) rather than a small
hand-authored test one. Five independent pieces can each be swapped for a
file-driven one:

- **`load_commodities_csv`** (`name,base_price`) — returns a
  `Dict[str, Commodity]` directly (built via `commodity.build_commodities`,
  so every loaded name gets a hand-tuned or generic-fallback
  `price_sensitivity`/`deficit_price_boost`/`event_templates` the same way
  `world_data.COMMODITIES` does), used to regenerate the procedural world
  with a different commodity set (`--locations-csv` and `--commodities-csv`
  are mutually exclusive branches in `cli.build_world`; only one, if
  either, is used per run).
- **`load_locations_csv`** — columns
  `name,x,y,produced_commodities,consumed_commodities,stockpiles,min_stockpiles,base_prices,fuel_price,terminal_types`,
  where the five dict-shaped columns are semicolon-joined `"commodity:number"`
  pairs (parsed by a shared `_parse_float_map`/`_float_map` helper in
  `csv_loaders.py` and `tests/conftest.py` respectively — these two files
  intentionally duplicate the same parsing logic, so a column-shape change
  must be mirrored in both). This is fully self-contained — it doesn't need
  a matching `commodities.csv`, since prices are baked directly into the
  locations file.
- **`load_routes_csv`** (`origin,destination,route_type`) — a custom route
  network, bypassing procedural generation entirely.
- **`load_companies_csv`** — one row per Transport, grouped by
  `company_name` into one `Company` (or `SoloTrader`, via an optional
  `company_type` column) each.
- **`load_pirate_brigades_csv`** — same shape, grouped by `brigade_name`
  into `PirateBrigade`s hunting every loaded Company.

`cli.build_world()` assembles a `World` either procedurally (30 locations,
20 ships across 4 companies — 2 pooling `Company`, 2 `SoloTrader` — plus 2
`PirateBrigade`s of 3 `Speedster`s each) or from whichever CSVs were given,
with all the same event probabilities (§9) explicitly configured. `main()`
runs it end to end: prints what each Location produces/consumes (reading
live prices off `world.buy_markets`/`sell_markets`, since `World` is
already built by the time this prints) and a day-0 arbitrage preview, runs
`world.run(num_days=60)`, then prints every summary/report, optionally
exporting JSON per Faction.

## 11. Tests

`tests/conftest.py` loads `tests/fixtures/*.csv` into real `Location`/
`Route`/`Company` objects (not mocks) via a `fixture_world` fixture, plus a
`fixture_pirate_crew` fixture for `PirateBrigade`-specific tests.
`fixture_world` monkeypatches `sim.world_data.LOCATION_COORDINATES` (not
`sim.LOCATION_COORDINATES` — see §2's note on mutable module state) so
`Route.__post_init__`'s distance calculation sees the fixture coordinates.

The four fixture locations (Testport Alpha/Beta/Gamma/Delta) are
deliberately small and hand-tunable: Alpha and Gamma each produce one
commodity (Crude Oil, Gold), Beta and Delta each consume Wheat with
different starting stockpile-vs-minimum positions (Beta starts *above* its
minimum — `can_sell` false at day 0; Delta starts *below* — `can_sell` true
immediately) so the loading tests can assert on both states of the
deficit-gating logic without running a full simulation.

Tests cover: Transport route-type restrictions, fixture loading shape
(locations, routes, companies, commodities), Company cash pooling vs.
`SoloTrader` independence, `PirateBrigade`'s Ship-only crew restriction, and
`Location`'s Platform-terminal exclusivity. `pyproject.toml` sets
`testpaths = ["."]`, so pytest auto-discovers everything under `tests/`.

## 12. Live UI (`exp-ui/`)

A minimal ImGui/ImPlot desktop viewer built on `imgui_bundle`'s
`hello_imgui` runner (`exp-ui/app.py`'s `App`/`Panel`/`AppConfig`): `App`
owns a panel registry and per-frame update/background-render callback
lists, drives the frame loop, and renders each visible `Panel` in its own
floating window.

`sim/state.py`'s `SimState` wraps a live `World` + its Factions with
play/pause/step controls: `reset()` (re-)builds a fresh World via
`cli.build_world(max_route_distance=1000)` — imported lazily to avoid a
circular import, since `cli.py` sits above `sim/`; `step()` advances
exactly one day via `World.step(verbose=False)` (no console-text capture —
every panel reads structured data straight off `self.world`, not printed
output); `tick(delta_time)` auto-steps at `days_per_second` while `playing`.

`exp-ui/main.py` wires up:

- **`NetworkBackground`** (`network_view.py`) — a full-window backdrop
  drawing the location/route network as a map, colored by faction/PirateBrigade
  presence, plus a text list of currently active broad-scope events
  (`World.active_named_events()`).
- **`ControlsPanel`** — play/pause/step/reset, speed slider, faction/trader/location counts.
- **`LocationsPanel`** — one row per Location with Produces/Consumes nested
  tables (commodity, current stock, min stockpile — blank on the Produces
  side, since a minimum only applies to something consumed — daily
  production/consumption rate, and Sell Price/Buy Price respectively).
- **`FleetPanel`** — one row per Captain: ship, faction, location,
  destination, status, cash, net worth.
- **`EventsPanel`** ("Event Log") — every `Event` SimState has recorded
  (`World.event_log`), with Day/Event Type/Scope/Subject/Message columns
  and a type-filter popup plus a subject-text filter. Deliberately shows
  only structured `Event` objects — trade activity
  (BUY/SELL/REFUEL/ATTACK/REPOSITION, from `Captain.trade_log`) is NOT
  shown here, since it isn't (yet) a structured `Event`/`Trade` dataclass.
- **`CommodityHistoryPanel`** — pick a Location + Commodity, plot its Buy
  and/or Sell Market price history (ImPlot line chart, auto-fit axes), with
  scatter markers for every Global/Location-wide/Worldwide event that
  touched it, colored by scope.
- **`StockpileHistoryPanel`** — same Location/Commodity picker, but plots
  `stockpile` and `reference_stockpile` from the Market's daily history
  instead of price — lets you watch a location's stock rise/fall relative
  to its min (consumed) or starting (produced) reference level over time.
- **`FactionNetWorthPanel`** — one line per Faction (colored by exact type:
  PirateBrigade red, SoloTrader purple, Company blue; `PoliceFleet`
  excluded entirely, since its pool is a literal infinity that would blow
  out the Y-axis auto-fit range), plus diamond scatter markers for every
  `CompanyEvent` that hit a plain `Company` (green for a cash windfall, red
  for a setback), positioned at that day's net worth.

None of these panels parse console text or use regular expressions to
derive what to show — every one reads structured data straight off `World`/
`Captain`/`Location`/`Market`/`Event` objects.

## 13. Reproducibility and randomness

The simulation deliberately uses **multiple independent `random.Random`
streams**, so that changing one part of the world (e.g. adding a trading
strategy, or reseeding the simulation's own RNG) never perturbs another
(e.g. the network layout):

- `world_data._generate_locations` — `WORLD_GEN_SEED` (2024)
- `world_data._generate_coordinates` — `WORLD_GEN_SEED + 1`
- `routes._generate_routes` — `WORLD_GEN_SEED + 2`
- The simulation's own trading/event randomness — the global `random`
  module, seeded once via `World(seed=...)` if given (`cli.py`'s default
  world passes `seed=42`)

This is why the network (which locations exist, where they sit, which
routes connect them, what each produces/consumes) is identical run to run
regardless of `World(seed=...)`, while trading behavior, event rolls, and
agent outcomes vary with that seed.

## 14. Where to extend things

- **New commodity**: add its name/base price to `world_data.COMMODITIES`'s
  `build_commodities(...)` call, and optionally a bespoke entry in
  `commodity._PRICE_SENSITIVITY`/`_DEFICIT_PRICE_BOOST`/
  `_BESPOKE_EVENT_TEMPLATES`/`_GENERATED_EVENT_DRIVERS` — or just leave it
  out and let it fall back to `DEFAULT_PRICE_SENSITIVITY`/
  `DEFAULT_DEFICIT_PRICE_BOOST`/a generic-driver event four-pack.
- **New pricing behavior for a specific commodity**: tune that commodity's
  entry in `commodity._PRICE_SENSITIVITY` or `commodity._DEFICIT_PRICE_BOOST`
  rather than touching `Market._stockpile_price` itself.
- **New Transport type**: subclass `Transport`, override
  `allowed_route_types()` if it's physically restricted, add it to
  `SHIP_CLASSES` if it's ship-like, and teach `csv_loaders._build_transport_from_csv`
  (and `tests/conftest.py`'s mirror) about its `ship_class` string if it
  should be CSV-loadable.
- **New Faction behavior**: subclass `Faction` and override `direct_fleet`
  — `World.run()` already treats a plain `Faction`'s `NotImplementedError`
  as "let this fleet act autonomously," so any subclass that supplies a
  real implementation is picked up automatically.
- **New event kind**: add a dataclass subclassing `Event`, give
  `__post_init__` a fixed `type`/`scope`, decide where `subject` gets
  stamped (at construction if known, or externally once tied to a specific
  entity — see `TransportEvent`/`CompanyEvent`'s pattern), and wire a
  trigger into `World._run_day` (or `Market.simulate_day` for something
  finer-grained than per-day).
- **New report/export format**: follow the existing `build_*_daily_reports`
  → `print_*`/`save_*_csv` pattern on `World`/`Faction`, which all already
  share the same "flat rows keyed by day" shape CSV/console output wants.

## 15. Tuning reference: which variables change economic behavior

This is a pure parameter-tuning reference — no code restructuring needed,
just editing the constants/defaults below. Grouped by the effect you're
after; current defaults noted in parentheses.

### 15.1 How sharply prices react to scarcity/surplus

- **`commodity._PRICE_SENSITIVITY`** (per-commodity, e.g. Crude Oil `0.6`,
  Gold `0.25`, feeding `Commodity.price_sensitivity`) / **`commodity.DEFAULT_PRICE_SENSITIVITY`**
  (`0.45`, the fallback `build_commodities` uses for anything not listed) —
  the core lever in `Market._stockpile_price` (§3.2): how many percent a
  commodity's price moves per 100% of deviation from its reference
  stockpile. Raise a commodity's entry to make its price swing harder on
  the same deficit/surplus (more volatile, more dramatic arbitrage
  opportunities); lower it for a duller, more stable commodity.
- **`commodity._DEFICIT_PRICE_BOOST`** (per-commodity, e.g. Coffee `2.0`,
  Gold `1.2`, everything else `1.3`-`1.6`, feeding `Commodity.deficit_price_boost`)
  / **`commodity.DEFAULT_DEFICIT_PRICE_BOOST`** (`1.4`, the fallback for a
  commodity with no explicit entry) — an extra multiplier applied only on
  the location's buy side (a Captain selling *in*) while it's running low,
  on top of `price_sensitivity`. Every commodity currently has some boost;
  push an entry above its neighbors for a commodity whose shortage premium
  should climb harder than its glut discount eases off (pulls more
  Captains toward selling it in during a squeeze); set an entry to `1.0`
  to make that one commodity fully symmetric again.
- **Deviation clamp and price floor** — hardcoded in
  `Market._stockpile_price` as `max(-2.0, min(2.0, ...))` and
  `max(0.5, ...)`. Widening the clamp lets a badly depleted/oversupplied
  commodity's price swing further before it's capped; the floor stops price
  from ever hitting zero or negative.
- **Daily price noise** — `random.gauss(0, 0.01)` in
  `Market.simulate_day`. Raise the standard deviation for a noisier,
  less-predictable day-to-day price on top of the deterministic stockpile
  formula; set to `0` for a fully deterministic price given the same
  stockpile state.
- **Captain's own price impact** — `Captain.price_impact` (default `0.01`,
  a per-Captain constructor argument), used in `_apply_price_impact`
  (`magnitude = price_impact * units / (units + 50)`). Higher values mean a
  single large trade visibly moves the market on top of the stockpile
  formula (faster-eroding arbitrage, more caution needed about trade size);
  `0.0` makes a Captain a pure price-taker with no footprint at all.

### 15.2 How big a stockpile locations start with, and how tight the buy/sell trigger is

All of the below live in `world_data._generate_locations` and only affect
the *procedurally generated* world — a custom `--locations-csv` sets these
figures directly per location instead (§10).

- **Production/consumption rate range** — `rng.uniform(3, 15)` (units/day)
  for both produced and consumed commodities. Raising this raises how fast
  stockpiles move every day, which (via `daily_update` and the reference
  stockpile) raises how fast prices can swing day to day.
- **`consumed_stockpile_factor`** (default `2.0`, a keyword argument on
  `_generate_locations`) — a consumed commodity's starting stockpile as a
  straight multiple of its minimum. Push this toward `1.0` for a world
  where locations start much closer to running out (more immediate
  buy-side arbitrage from day one); raise it well above `2.0` for a world
  that takes longer to develop any deficits at all.
- **Minimum-stockpile buffer** — `rng.uniform(5, 10)` (days of consumption)
  used to compute `min_stockpiles[c] = rate * U(5, 10)`. A smaller range
  means locations tolerate less buffer before wanting to buy (more
  frequent, smaller-scale deficits); a larger range means slower, rarer,
  but potentially larger deficits.
- **Produced-commodity starting stockpile (its price reference)** —
  `rng.uniform(10, 25)` (days of accumulated output) used for
  `stockpiles[c] = rate * U(10, 25)`. Since this doubles as the frozen
  price reference for a produced commodity (`_reference_stockpiles`),
  raising it raises the "normal" level prices are measured against —
  effectively how much surplus has to build up before its price starts
  dropping noticeably.
- **Base price randomization** — `rng.uniform(0.85, 1.15)` applied to
  `commodities[c].base_price` when seeding a Location's own `base_prices`.
  Widen this range for more price variation between locations trading the
  same commodity at day one (bigger baseline arbitrage gaps before any
  stockpile drift even happens).
- **How many commodities each location deals in** —
  `rng.randint(2, 4)` (independently for produced and consumed). More
  commodities per location means more simultaneous trade opportunities
  there but a thinner, more diffuse world; fewer means a sparser network
  with more specialized locations.
- **The `base_prices` dict passed to `commodity.build_commodities(...)`**
  (in `world_data.COMMODITIES`'s own construction) — the actual reference
  price per commodity world-wide. Changing these directly rescales a
  commodity's absolute price level (and, since cargo cost scales with
  price, how much capital a trade in it ties up) without touching how
  *volatile* it is.

### 15.3 How often random shocks happen, and how big they are

All six probabilities below are `World.__init__` keyword arguments (see
§9); `cli.py`'s default world passes them explicitly.

| Probability | Default (`World`) | Default (`cli.py`) | Governs |
| --- | --- | --- | --- |
| `local_event_probability` | 0.08 | 0.08 | Local MarketEvent, per Market per day |
| `global_event_probability` | 0.06 | 0.06 | Global commodity-wide MarketEvent |
| `location_event_probability` | 0.04 | 0.04 | Location-wide MarketEvent |
| `worldwide_event_probability` | 0.02 | 0.02 | Worldwide MarketEvent |
| `location_closure_probability` | 0.01 | 0.015 | Whole-port LocationClosure |
| `company_event_probability` | 0.05 | 0.05 | CompanyEvent, per plain Company per day |

Raise any of these for a rowdier, shock-driven economy; lower them (or set
to `0.0`) to isolate the underlying stockpile-driven pricing with minimal
external noise — useful when tuning §15.1/§15.2 in isolation, since a
MarketEvent's demand/supply multipliers otherwise stack on top of (and can
mask) the stockpile formula's own effect.

The *magnitude* of each shock lives in its template list -- per-commodity
ones in `commodity.py`, commodity-agnostic ones in `events.py`:

- **`Commodity.event_templates`** (`commodity.py`, see §3.2/§7.1) —
  `demand_multiplier`/`supply_multiplier`/`duration_days` per named event,
  feeding both Local and Global MarketEvents. `commodity._make_commodity_events`
  generates a standard four-pack for any commodity without a fully bespoke
  list; edit its multiplier constants (`1.3`/`0.65`/etc.) to change how
  strong a "generic" boom/disruption/glut/slump is across the board, or add
  a bespoke entry to `commodity._BESPOKE_EVENT_TEMPLATES` for a specific
  commodity the way Crude Oil/Copper/Wheat/Gold already have.
- **`LOCATION_EVENT_TEMPLATES`** / **`WORLD_EVENT_TEMPLATES`** (`events.py`) — the
  commodity-agnostic Location-wide/Worldwide shock pool; same
  multiplier/duration shape.
- **`AGENT_EVENT_TEMPLATES`** — `magnitude`/`duration_days` per
  TransportEvent kind (`delay` days, `cargo_loss`/`fuel_discount`/
  `fixed_cost_discount` fractions, `cash_gain`/`cash_loss` dollar amounts).
  Also gated by **`Captain.agent_event_probability`** (default `0.05`, a
  per-Captain constructor argument) — raise it for a Captain that's
  chronically unlucky/lucky relative to the fleet.
- **`COMPANY_EVENT_TEMPLATES`** — `magnitude` dollar amounts per
  CompanyEvent (`cash_gain`/`cash_loss`); all currently one-off
  (`duration_days=1`).
- **`LOCATION_CLOSURE_TEMPLATES`** — `duration_days` per closure reason
  (4-10 days). Longer durations mean a bigger, rarer disruption to a
  location's trade once one does trigger.

### 15.4 Route economics: travel cost, time, and profitability threshold

- **`Captain.min_daily_return_pct`** (default `0.02`, a per-Captain
  constructor argument, varied per-ship in `cli.py`'s default fleet via
  `0.012 + 0.002 * (i % 5)`) — the profitability bar a route must clear
  (§6.2). Lower it for a more aggressive Captain that takes thinner
  margins; raise it for one that only takes fat, obviously-profitable
  trades. This is the single biggest lever on how much trading volume the
  simulation generates overall.
- **`Captain.reposition_return_multiplier`** (default `1.25`) — how much
  stiffer the bar is for a speculative empty repositioning move (§6.2) vs.
  a trade already in hand. Push it toward `1.0` to make Captains reposition
  almost as readily as they trade normally; raise it to make repositioning
  rare and only for very lopsided opportunities.
- **Transport hardware** (`transport.py`, per-instance or via
  `SHIP_CLASSES` presets) — `cargo_capacity` (how much capital/profit one
  voyage can move), `speed_units_per_day` (travel time, and thus how long
  capital and crew wages are tied up), `fuel_consumption_per_unit_distance`
  / `reposition_fuel_consumption_per_distance` (fuel cost per trip, loaded
  vs. empty), `fixed_shipment_cost` (a flat per-voyage tax that punishes
  small/thin trades disproportionately), and `fuel_capacity` (how far a
  Transport can go before needing an intermediate refueling stop). Add a
  new named preset to `SHIP_CLASSES` to give a whole fleet a different
  cost/speed/capacity profile without changing `Captain` at all.
- **Crew wages** — `Crew.daily_wages` (default `0.0`) / `Sailor`'s default
  (`20.0`), owed only while `InTransit` (§6.3). Raising wages makes long
  voyages costlier per day of transit (favoring short, fast routes over
  long, slow ones) and makes an underfunded Faction's ships go `Inactive`
  sooner.

### 15.5 Faction- and fleet-level economics

- **`Company`/`SoloTrader`/`PirateBrigade` `starting_cash`** — how much
  capital a fleet has to work with; a low starting pool means early trades
  are capped by affordability rather than cargo capacity or route
  economics.
- **`PirateBrigade.raid_fraction`** (default `0.10`) — how much of a
  non-pooling victim's cash is stolen per attack (§8.2); `Location.fence_fraction`
  (default `0.5`, per-Location) — how much of a seized cargo's market value
  a pirate actually recovers when fencing it (vary per-location for a
  "lawless port fences for more" flavor).
- **`PirateBrigade.max_carousing_to_attack`** / `carousing_cost_per_crew`
  / `carousing_increase_per_day` / `max_carousing` — how often a pirate
  crew is too distracted by shore leave to raid a co-located victim;
  raising `max_carousing_to_attack` (or lowering the increase rate) makes
  pirates attack more consistently.
- **`PirateBrigade.laziness`** (default `1`) — how many days between
  re-scans of where target Companies' ships are concentrated; higher
  values make a brigade slower to notice a fleet has moved on but cheaper
  to run.
- **`PoliceFleet.patrol_interval_days`** (default `5`) / `num_police_ships`
  (a `World.__init__` argument, default `3`) — since `PoliceFleet` presence
  is what deters a `PirateBrigade` attack at a shared location
  (`_police_present_at`), more ships or a shorter patrol interval indirectly
  suppresses raiding economics without touching `PirateBrigade` itself.

### 15.6 Geography (indirect economic effects via travel time/fuel cost)

- **`world_data.WORLD_GEN_SEED`** (`2024`) — reseeds the *network's*
  independent RNG streams (locations, coordinates, routes — see §13); the
  network layout itself, not trading, changes with this.
  **`World(seed=...)`** (`cli.py` passes `42`) separately reseeds the
  simulation's own trading/event randomness — the one to change for a
  different *run* of the same world.
- **`world_data._generate_coordinates`'s `min_distance`** (default `200.0`)
  — the minimum synthetic-map distance enforced between any two locations;
  raising it spreads the network out (longer average routes, more fuel
  cost and transit time per trade).
- **`routes.ROUTE_TYPE_DISTANCE_SCALE`** (Air `1.0`, Sea `0.8`, Railroad
  `0.5`) and the `max_route_distance` passed to `_generate_routes`/`cli.build_world`
  (`exp-ui`'s `SimState.reset()` uses `1000`) — how far apart two locations
  can be and still get a direct Route of a given type. A smaller cap (or a
  smaller Railroad scale) prunes the network down to a denser web of
  shorter hops, forcing more multi-hop Dijkstra routing and changing which
  arbitrage pairs are even reachable directly.
