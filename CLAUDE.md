# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

This is a TypeScript project built with Vite; use npm from the repo root:

```
npm test                         # run the full vitest suite (src/sim/__tests__)
npm test -- distance             # run tests whose file/name matches "distance"
npm run dev                      # start the Vite dev server for the simulation viewer
npm run build                    # type-check (tsc -b) and build for production
npm run lint                     # oxlint
npm run sweep                    # seed-averaging tuning harness (vitest.sweep.config.ts -> src/sim/analysis.harness.ts)
```

There is no Python in this codebase (the original Python port was deleted; `pyproject.toml` is a leftover). `npm test` auto-discovers `*.test.ts` under `src/`.

### Two separate apps in one repo

- **Root (`src/`)** — package `web`: the simulation **engine** (`src/sim/`) plus a React + TypeScript **viewer** (`src/App.tsx`, `src/components/`, `src/state/useSimStore.ts`) that wraps a `World` with play/pause/step controls. Build root is the repo root.
- **`editor/`** — package `editor`: a standalone Vite + React **World editor** for authoring a world visually (place Locations, draw Routes, define Commodities/Companies/PoliticalEntities) and exporting it as a single JSON document. Run with `npm run dev`/`npm run build` **inside `editor/`**.

**The two builds cannot share imports.** Any sim-side logic the editor needs is kept as a standalone copy under `editor/src/` (e.g. `editor/src/nameGenerators.ts` mirrors `src/sim/names.ts`/`shipNames.ts`/`companyNames.ts`; `editor/src/distance.ts` mirrors `src/sim/distance.ts`). When you change one side's copy, keep the other in step — the editor's exported JSON is consumed by the sim's `buildWorldFromJson`.

### Building a world

- **`buildWorld()`** (`src/sim/buildWorld.ts`) — the default procedurally generated 30-location world plus a hand-sized fleet, from fixed seeds. Called once by the viewer's `useSimStore.reset()`. Every knob is a plain function option (`BuildWorldOptions`); there is no CSV/file path.
- **`buildWorldFromJson()`** (`src/sim/buildWorldFromJson.ts`) — builds a live `World` from the JSON the editor exports. It also **synthesizes a fleet** up to the required ship count (see below), so an authored world with a few companies still runs a full economy.

## Architecture

An agent-based simulation of commodity markets across many `Location`s, connected by a typed `Route` network, traded by profit-seeking `Captain` agents crewing `Transport`s owned by `Faction`s. `src/sim/` is organized one module per concern — `src/sim/index.ts` re-exports the public API and `doc/Architecture.md` is the full design writeup (`doc/World.md` is a task→file map, `doc/Simulation.md` the tuning record). The dependency chain runs roughly:

```
worldData (Location, geography) + distance -> routes (Route/RouteType) -> markets (Market)
  -> transport (Transport/Ship/WagonTrain/Plane) -> person (Person) -> sailor (Sailor) -> captain (Captain)
  -> faction (Faction/Company/SoloTrader/PirateBrigade/PoliceFleet) -> world (World)
```

`contracts.ts` sits beside `faction.ts`/`captain.ts`; `buildWorld.ts`/`buildWorldFromJson.ts` and the `src/state/` + `src/components/` viewer sit on top.

### Key relationships

- **Location / Route**: `Location` produces some commodities (sold as surplus) and consumes others (bought below a minimum stockpile); price moves with stockpile deviation from a reference level. Each `Location` carries a set of `TerminalType`s (Port/Wagon yard/Airport/Platform/Spaceport/…). A `Route` connects two locations with a typed mode (`RouteType`: Sea/Land/Air/Space/Road/Railroad), valid only where both ends share a compatible terminal (`ROUTE_TERMINAL_COMPATIBILITY`).
- **Multiple routes per pair**: `routes.ROUTES` is a `Map<string, Route[]>` keyed by location pair (`routeKey(a,b)`) — a pair may be connected by several routes of **different types** (at most one per type). `getRoutes(a,b)` returns them all; `getRoute(a,b)` returns the shortest. Pathfinding treats every route as its own edge, so a Ship and a Plane between the same two ports are parallel edges chosen per the transport. `addRouteToNetwork` groups routes by pair and drops a duplicate type.
- **Distance modes** (`src/sim/distance.ts`): a world measures distance either **flat** (Euclidean, the default — `distanceBetween` is plain `Math.hypot` on world coordinates) or **globe** (great-circle: each position's normalized fraction of the map is read as a lon/lat, distance = `radius × centralAngle`). The active `DistanceConfig` is module-level in `worldData.ts` (`setDistanceConfig`), set from the JSON on load; `buildWorld` resets it to flat. `Route.distance` and pathfinding both honor it.
- **Transport / Person / Sailor / Captain**: `Transport` is pure hardware — cargo, speed, fuel burn, `crewRequirement`, `currentFuel`, and a `condition` ([0,1], decays while `InTransit`, see below). `Person` (`person.ts`) is the base identity/placement layer (`location` XOR `transport`, never both/neither once placed); `Sailor extends Person` is a generic waged crew member (`rank`, `journeysRemaining`, `piracy`); `Captain extends Sailor` adds all trading-agent behavior. A `Transport`'s `.crew` list is filled by `Faction`'s constructor/`fillExtraSeats`, drawing (for a `Ship`) from `sailorPool.ts`'s world-wide, per-Location pool of unhired Sailors.
- **Faction / Company / …**: `Faction` owns a fleet of `(Transport, Captain, homeLocation)` triples; behavioral differences between Company/SoloTrader/PirateBrigade/PoliceFleet are exposed as `Faction` getters (`poolsCash`, `canSmuggle`, `rotatesCrew`, `fencesCargo`, `decaysCondition`, `grantsShoreLeave`, `hirePiracyThreshold`) rather than `instanceof` checks in `captain.ts`/`world.ts` (which only import `Faction` as a type, to avoid a circular value import with `faction.ts`) — add a new getter here for new per-kind behavior. `Company.directFleet()` assigns idle ships to their best-scoring trade and dispatches location-funded `Contract`s; `SoloTrader` is a 1-ship `Company` with `poolsCash=false`; `PirateBrigade`/`PoliceFleet` are built by both `buildWorld` and `buildWorldFromJson`, at the same calibrated `DEFAULT_NUM_PIRATE_SHIPS`/`DEFAULT_NUM_POLICE_SHIPS` counts (`buildWorld.ts`), unless overridden down to 0.
- **Ship condition, repair, and sinking** (`transport.ts`/`captain.ts`/`faction.ts`, Architecture.md §8.5): every `decaysCondition` Faction's `Ship`s (Company/SoloTrader/PirateBrigade/PoliceFleet — every concrete Faction today) lose `CONDITION_DECAY_PER_TRANSIT_DAY` per day genuinely `InTransit`; a docked Ship below `CONDITION_REPAIR_THRESHOLD` gets a whole-day `REPAIR` Directive ahead of any trade/contract/patrol logic (`Faction.partitionForRepair`) and can't depart until repaired; condition hitting zero sinks the Ship — fatally at sea (`Faction.sinkAtSea`) or survivably in port (`sinkInPort`, benching the Captain into `inactiveCaptains`). Only `Ship` overrides `handlesZeroCondition()` — WagonTrain/Plane/Lorry/FreightTrain/Spaceship are exempt from all of this. Replacement after a sinking is asymmetric: `SoloTrader`/`PoliceFleet` auto-replace (`World`'s private `buySoloTraderReplacementIfPossible`/`buyPoliceReplacementImmediately`); a plain multi-ship `Company` and `PirateBrigade` have no automatic replacement at all.
- **PoliticalEntity**: groups Locations sharing one cash pool, and carries a **`nationality`** (English/French/Spanish/Dutch/Portuguese) used to name ships/captains synthesized for its affiliated Companies.
- **World**: the daily loop — resolves closures, asks each `Faction.directFleet()` for directives, calls `Captain.act()`, rolls market/transport/company/closure events, clears every `Market`, snapshots portfolios. The formal order of a day's events (`World.runDay`, then per-captain inside `Captain.act`) is: 1) contracts issued (`tenderContracts`) 2) crew hiring, for ships already in port (`World.runDay`'s own pass, calling `Captain.hireCrewIfPossible`) 3) fleets plan and accept contracts (`Faction.directFleet`, which issues each idle Ship's `REPAIR` Directive first if its condition is below threshold) 4) ships buy required commodities 5) ships leave port (4 and 5 are separate calls — see `Captain.leavePort` — so a future step can be inserted between them) 6) ships arrive at port and may be attacked by a co-located pirate (`PirateBrigade.maybeAttackOnArrival`, the only attack trigger — an already-docked ship has nothing left to raid, having already sold on arrival) 7) ships (and pirates fencing seized cargo) sell and finalize contracts 8) crew due to rotate off leaves, and replacements are hired immediately, same turn. Steps 4–8 run inside a single `Captain.act()` call per ship, one pass per captain in `agentOrderFn`'s daily order — there's no global phase barrier for these steps, only for 1–3. 9) As the literal last act of the day, `World.runDay` rolls Shore Leave: one coin flip per docked, non-repairing Ship whose Faction grants it (`Faction.grantsShoreLeave` — false only for `PoliceFleet`) calls `Sailor.shoreLeave()` on every non-Captain crew member — currently an empty placeholder.

### Fleet synthesis on JSON load (`buildWorldFromJson`)

After building the authored factions, the loader sizes the fleet up to `required = round(locations.length × 5)` (the calibrated minimum, `DEFAULT_TARGET_SHIPS_PER_LOCATION`). If the world already has ≥ `required` ships, nothing is added. Otherwise `round(0.2 × required)` **Independent SoloTraders** are created, and the remaining ships are distributed round-robin across **the companies defined in the JSON** (bulking up even 1-ship companies) — or, if the JSON defines no companies at all, added as further SoloTraders. Generated ships/captains draw names from the owning Company's PoliticalEntity nationality (a seeded-random nationality for Independent factions). All synthesis is from a fixed seed, so a given JSON always yields the same fleet.

### Economics a Captain weighs when picking a route (`captain.ts`)

`routeEconomics` bakes in, per candidate: cargo cost, fuel cost (each leg at its origin's live price), the transport's fixed shipment fee, and crew wages (owed only while `InTransit`) for every day the trip takes. Candidates are ranked by **daily return** (profit per day of capital tied up) against `minDailyReturnPct`, not raw profit — so a short cheap route is fairly compared against a long expensive one. Contracts are scored on the same per-ship-day basis (`"compare"` strategy).

- **Refueling**: a `Transport` that tracks fuel (`currentFuel` not `null`) refuels automatically at intermediate stops on a multi-hop path; a route is infeasible if any single leg exceeds tank capacity.
- **Inactive transports**: if a Faction can't afford a transport's crew wages while `InTransit`, its `status` flips to `Inactive` (no fuel/progress) and it's excluded from fleet coordination until it can pay.
- **Repositioning**: with nothing local clearing the bar, a Captain scans the whole network and sails empty toward a distant opportunity, but only past a stiffer bar (`minDailyReturnPct × repositionReturnMultiplier`).

### Mutable module-level world state

`worldData`'s `LOCATIONS`/`LOCATION_COORDINATES`/`COMMODITIES`, its `DISTANCE_CONFIG`, and `routes`'s `ROUTES` are exported `let` bindings reassigned wholesale (`setGeography`/`setCommodities`/`setDistanceConfig`/`setRoutes`) by `buildWorld`/`buildWorldFromJson`, or directly by a test building a small world. Every reader looks the state up off its own defining module's live binding at call time — ES module named imports are live references, so a wholesale swap propagates everywhere. `pathfinding.ts`'s adjacency cache is a `WeakMap` keyed by the `ROUTES` Map instance, so a `setRoutes` reassignment gets a fresh cache entry automatically.

### Tests

`src/sim/__tests__/*.test.ts` (vitest) exercise the engine directly: the default procedural world, hand-built worlds via `buildWorldFromJson`, and unit tests per concern (distance modes, multiple routes, fleet synthesis, contracts, faction cash pooling, PoliticalEntity affiliation, spaceship routing, …). Tests that build a small world call `setGeography`/`setRoutes` directly (see `contracts.test.ts`). The editor has no automated test suite — verify it by running its dev server and driving it in a browser.
