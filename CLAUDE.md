# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Use the project's venv interpreter directly (there's no global install):

```
.venv\Scripts\python.exe -m pytest              # run the full test suite
.venv\Scripts\python.exe -m pytest -v            # verbose
.venv\Scripts\python.exe -m pytest tests/test_sim.py::TestFixtureLoading::test_companies_load_with_expected_fleets  # single test
.venv\Scripts\python.exe main.py                 # run the default 60-day simulation
.venv\Scripts\python.exe main.py --help          # see CSV-driven world-building flags
```

`pyproject.toml` sets `testpaths = ["."]`, so pytest auto-discovers `tests/`. There is no lint/build step configured.

### Running a custom world from CSVs

`main.py` accepts `--commodities-csv`, `--locations-csv`, `--routes-csv`, `--companies-csv`, `--pirate-brigades-csv`, and `--json-report-dir`, each swapping one piece of the default procedurally-generated world for a file-driven one (see `sim/csv_loaders.py` for expected columns, and `tests/fixtures/*.csv` for worked examples). Passing none of them runs the default 30-location procedural world with hand-coded fleets.

## Architecture

This is an agent-based simulation of commodity markets across many locations, connected by a typed route network, traded by profit-seeking `Captain` agents running `Transport`s owned by `Faction`s. The `sim/` package is organized by concern, one module per major entity — read `sim/__init__.py`'s docstring for the module map. The dependency chain runs roughly:

```
world_data (Location, geography) -> routes (Route/RouteType) -> markets (Market)
  -> transport (Transport/Ship/Train/Plane) -> crew (Crew/Sailor) -> captain (Captain)
  -> faction (Faction/Company/PirateBrigade) -> world (World, orchestrates everything)
```

`csv_loaders.py` and the root-level `cli.py`/`main.py` sit on top, building a `World` either procedurally or from CSVs.

### Key relationships

- **Location / Route**: `Location` is a trading hub with per-commodity buy/sell prices and a set of `TerminalType`s (Port/Station/Airport/Platform). `Route` connects two locations with a typed mode (Sea/Railroad/Air); a route is only generated where both ends share a compatible `TerminalType` (`ROUTE_TERMINAL_COMPATIBILITY`). Both are generated procedurally from fixed seeds in `world_data.py`/`routes.py`, using dedicated `random.Random` streams independent of the simulation's own RNG — this keeps the world reproducible across runs regardless of trading randomness.
- **Transport / Crew / Captain**: `Transport` (see `transport.py`) is pure hardware — cargo capacity, speed, fuel burn, `crew_requirement`, `current_fuel` — decoupled from the agent that operates it. `Crew` (see `crew.py`) is a bare identity (name + transport); `Sailor` is a generic waged `Crew` member; `Captain` subclasses `Crew` and adds all trading-agent behavior (strategy, cash, route planning, buy/sell execution). A `Transport`'s `.crew` list is filled by `Faction.__init__`, not by `Transport` itself.
- **Faction / Company / PirateBrigade**: `Faction` owns a fleet built from `(Transport, Captain, home_location)` triples — callers construct each `Captain` themselves (full control over strategy params); `Faction` just wires `captain.transport`/`captain.location` and fills out the `Transport.crew` roster. `pools_cash` (class attribute) controls whether captains share one balance (`Company`, `Faction` default) or keep individual balances (`PirateBrigade`). `Company.direct_fleet()` actively assigns idle ships to their best-scoring trade; `PirateBrigade.direct_fleet()` instead chases wherever watched `Company` fleets are concentrated. A plain `Faction.direct_fleet()` raises `NotImplementedError`, which `World.run()` catches to mean "let this fleet act autonomously."
- **World**: orchestrates the daily loop — resolves location closures, asks each `Faction.direct_fleet()` for directives, calls `Captain.act()` for every trader, rolls global/local/location-wide/worldwide `MarketEvent`s, clears every `Market`, and snapshots portfolios. Also owns all reporting (print/CSV/JSON summaries).

### Economics a Captain weighs when picking a route (`captain.py`)

Route scoring (`_route_economics`) bakes in, per candidate route: cargo cost, fuel cost (at the origin's live price), the transport's fixed shipment fee, and crew wages (`Crew.daily_wages`, owed only while `TransportStatus.InTransit`) for every day the trip takes. Candidates are ranked by *daily return* (profit per day of capital tied up) against `min_daily_return_pct`, not raw profit — this is what lets a Captain fairly compare a short cheap route against a long expensive one.

- **Refueling**: if a `Transport` tracks fuel (`current_fuel` is not `None`) and doesn't have enough on board for a leg (`Transport.needs_refuel`), the route planner looks for a single intermediate stop that makes both legs fit, and prices the trip as two legs. A `Transport` with `current_fuel = None` (the default) never needs refueling regardless of trip length.
- **Inactive transports**: if a Faction can't afford a transport's crew wages on a given day while it's `InTransit`, the transport's `status` flips to `TransportStatus.Inactive` (no fuel burn, no travel progress) and is automatically excluded from `direct_fleet()` coordination (`Captain.is_idle_in_port` only returns `True` for `AtLocation`).
- **Repositioning**: if nothing at the current location clears the return bar, a Captain will scan the whole network and sail empty toward a distant opportunity, but only if the return clears a stiffer bar (`min_daily_return_pct * reposition_return_multiplier`), since it's a speculative bet on an opportunity that might not survive the extra transit time.

### Mutable module-level world state

`world_data.LOCATIONS`/`LOCATION_COORDINATES`/`COMMODITIES`/`BASE_PRICES` and `routes.ROUTES` are reassigned wholesale when `main()` builds a world from CSVs, or when tests monkeypatch coordinates for a fixture world. Any code that needs to observe such a reassignment must read the attribute off the *owning* submodule (`sim.world_data.LOCATIONS`, `sim.routes.ROUTES`) — not a copy re-exported on `sim` itself or captured via `from .world_data import LOCATIONS` at another module's import time — since every function that reads this state (`distance_between`, `get_route`, ...) looks it up via its own defining module's globals at call time.

### Tests

`tests/conftest.py` loads `tests/fixtures/*.csv` into real `Location`/`Route`/`Company` objects (not mocks) via a `fixture_world` fixture, and a `fixture_pirate_crew` fixture for `PirateBrigade`-specific tests. `fixture_world` monkeypatches `sim.world_data.LOCATION_COORDINATES` (not `sim.LOCATION_COORDINATES`) so `Route.__post_init__`'s distance calculation sees the fixture coordinates.
