# market-sim

An agent-based simulation of commodity markets spread across many
locations, connected by a typed route network, and traded by
profit-seeking `Captain` agents crewing `Transport`s owned by `Faction`s
(merchant companies, solo traders, and pirate brigades that hunt them).

Each day, factions direct their fleets, captains weigh candidate trade
routes by daily return (not raw profit), buy and sell into per-location
markets, and the world rolls random events (price shocks, location
closures) before snapshotting everyone's portfolio. The world can be
generated procedurally from fixed seeds, or built entirely from CSVs.

## Getting started

Create the virtual environment and install dependencies (including
`pytest`) from `pyproject.toml`:

```
python -m venv .venv
.venv\Scripts\python.exe -m pip install -e ".[test]"
```

There's no global install -- use the project's venv interpreter directly:

```
.venv\Scripts\python.exe -m pytest              # run the full test suite
.venv\Scripts\python.exe main.py                 # run the default 60-day simulation
.venv\Scripts\python.exe main.py --help          # see CSV-driven world-building flags
```

Running `main.py` with no arguments builds the default procedurally
generated 30-location world, hand-coded fleets (4 companies, 2 pirate
brigades), and runs 60 days of trading, printing location/fleet/route
summaries, arbitrage opportunities, daily agent logs, and end-of-run
portfolio reports to the console.

### Building a custom world from CSVs

Any of the five world-building pieces can be swapped for a file-driven
one by passing its CSV path to `main.py`:

- `--commodities-csv` -- commodity names + base prices
- `--locations-csv` -- locations + coordinates
- `--routes-csv` -- routes between locations
- `--companies-csv` -- companies + their fleets
- `--pirate-brigades-csv` -- pirate brigades + their fleets
- `--json-report-dir` -- write each faction's full daily history as JSON

See `sim/csv_loaders.py` for each file's expected columns, and
`tests/fixtures/*.csv` for worked examples. Passing none of them runs
the default procedural world.

## Architecture

The `sim/` package is organized by concern, one module per major entity.
The dependency chain runs roughly:

```
world_data (Location, geography) -> routes (Route/RouteType) -> markets (Market)
  -> transport (Transport/Ship/Train/Plane) -> crew (Crew/Sailor) -> captain (Captain)
  -> faction (Faction/Company/PirateBrigade) -> world (World, orchestrates everything)
```

| Module | Responsibility |
| --- | --- |
| `events` | `MarketEvent`/`AgentEvent`/`LocationClosure` |
| `location` | `Location`, `TerminalType` |
| `world_data` | commodity roster, geography (`LOCATIONS`, `get_location`, `distance_between`, ...) |
| `routes` | `Route`/`RouteType`, the route network |
| `pathfinding` | Dijkstra shortest-path routing over the route network |
| `markets` | `Market`, stockpile-deviation pricing |
| `transport` | `Transport`/`Ship`/`Train`/`Plane`, `SHIP_CLASSES` |
| `crew` | `Crew` (base class for anyone operating a `Transport`) and `Sailor` (a generic waged deckhand) |
| `captain` | `Captain` (the trading agent, a `Crew` subclass) |
| `names` | `random_name()` + per-language name pools for naming captains |
| `faction` | `Faction`/`Company`/`SoloTrader`/`PirateBrigade`/`PoliceFleet` |
| `csv_loaders` | optional CSV-driven world/fleet building |
| `world` | `World` (orchestrates everything, runs the simulation) |

`cli.py` and `main.py` sit on top, building a `World` either
procedurally or from CSVs and running it end to end.

### Key relationships

- **Location / Route**: `Location` is a trading hub that produces some
  commodities (added to its stockpile daily, sold off as surplus) and
  consumes others (drawn from its stockpile daily, bought once it runs
  below a minimum) -- price moves with how far the stockpile sits from
  that reference level. It also carries a set of `TerminalType`s (Port/
  Station/Airport/Platform). `Route` connects two locations with a typed
  mode (Sea/Railroad/Air); a route only exists where both ends share a compatible
  terminal type. Both are generated procedurally from fixed seeds,
  independent of the simulation's own RNG, so the world stays
  reproducible across runs regardless of trading randomness.
- **Transport / Crew / Captain**: `Transport` is pure hardware --
  cargo capacity, speed, fuel burn, crew requirement -- decoupled from
  the agent that operates it. `Crew` is a bare identity (name +
  transport); `Sailor` is a generic waged `Crew` member; `Captain`
  subclasses `Crew` and adds all trading-agent behavior (strategy,
  cash, route planning, buy/sell execution).
- **Faction / Company / PirateBrigade**: `Faction` owns a fleet built
  from `(Transport, Captain, home_location)` triples. `pools_cash`
  controls whether captains share one balance (`Company`, the
  `Faction` default) or keep individual balances (`PirateBrigade`).
  `Company.direct_fleet()` actively assigns idle ships to their
  best-scoring trade; `PirateBrigade.direct_fleet()` instead chases
  wherever watched `Company` fleets are concentrated.
- **World**: orchestrates the daily loop -- resolves location closures,
  asks each faction to direct its fleet, calls `Captain.act()` for
  every trader, rolls market events, clears every market, and
  snapshots portfolios. Also owns all reporting (print/CSV/JSON
  summaries).

### Route economics

A `Captain` scores each candidate route (`_route_economics`) on cargo
cost, fuel cost at the origin's live price, the transport's fixed
shipment fee, and crew wages owed for every day the trip takes.
Candidates are ranked by *daily return* against `min_daily_return_pct`,
so a captain can fairly compare a short cheap route against a long
expensive one. Transports that track fuel will route through an
intermediate stop to refuel if needed; a faction that can't afford a
transport's wages mid-transit flips it to `Inactive` until it can; and
captains will reposition an empty ship toward a distant opportunity if
nothing local clears the bar, but only past a stiffer threshold since
it's a speculative bet.

## Experimental UI

`exp-ui/` is an [imgui-bundle](https://github.com/pthom/imgui_bundle)
desktop viewer (`python exp-ui/main.py`) for watching a running
simulation -- network map, per-location and per-fleet panels, event
log, and commodity/net-worth history charts. It has its own
`requirements.txt` (`imgui-bundle`, `numpy`) separate from the core
simulation's dependencies.

## Tests

`tests/conftest.py` loads `tests/fixtures/*.csv` into real
`Location`/`Route`/`Company` objects (not mocks) via a `fixture_world`
fixture, plus a `fixture_pirate_crew` fixture for `PirateBrigade`-
specific tests. There is no lint/build step configured.
