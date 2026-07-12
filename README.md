# market-sim

An agent-based simulation of commodity markets spread across many
locations, connected by a typed route network, and traded by
profit-seeking `Captain` agents crewing `Transport`s owned by `Faction`s
(merchant companies and solo traders; pirate/police raiding exists in the
engine but isn't part of the default world).

Each day, factions direct their fleets, captains weigh candidate trade
routes by daily return (not raw profit), buy and sell into per-location
markets, and the world rolls random events (price shocks, per-transport
mishaps, whole-port closures) before snapshotting everyone's portfolio.
The world can be generated procedurally from fixed seeds, or authored
visually in the editor and loaded from a single JSON document.

It's a TypeScript project built with [Vite](https://vitejs.dev); it needs
[Node.js](https://nodejs.org) with `npm`. There is no Python
(`pyproject.toml` is a leftover from an earlier port).

## Getting started

Install dependencies from the repo root (where `package.json` lives):

```
npm install
```

Then:

```
npm run dev       # start the Vite dev server (simulation viewer) with hot reload
npm run build     # type-check (tsc -b) and build for production
npm run preview   # preview a production build locally
npm test          # run the vitest engine suite
npm run lint      # oxlint
npm run sweep     # seed-averaging tuning harness (see doc/Simulation.md)
```

`npm run dev` serves the React viewer (`src/App.tsx`): it builds the
default procedurally generated 30-location world with a synthesized fleet
and gives you play/pause/step controls, a network map, per-location and
per-fleet panels, an event log, and price/net-worth history charts.

## Repository layout

Two separate apps live in one repo (they are **separate builds and cannot
share imports**):

- **Root (`src/`)** — the simulation **engine** (`src/sim/`) plus the React
  **viewer** (`src/App.tsx`, `src/components/`, `src/state/useSimStore.ts`).
- **`editor/`** — a standalone Vite + React **World editor** for authoring a
  world visually and exporting it as JSON. Run it with its own
  `npm run dev` / `npm run build` from inside `editor/`.

The editor exports a World as a single JSON document; the engine's
`buildWorldFromJson` (`src/sim/buildWorldFromJson.ts`) loads that JSON into
a live, runnable `World` — and synthesizes a full fleet up to the required
ship count so a lightly-authored world still runs a complete economy.

## The World editor

`editor/` is a visual authoring tool. Place Locations on a canvas, connect
them with typed Routes (including bulk "auto-connect Sea routes"), define
Commodities, PoliticalEntities (each with a **nationality** that seeds
generated ship/captain names), and Companies (generated per nationality),
then export/copy the World as JSON to feed the simulation. It also supports
a **flat vs. globe distance mode** with an editable sphere radius, so
distances can be measured as a plane or on a sphere. See
`doc/Architecture.md` for how the exported JSON maps onto the engine.

## Architecture

`src/sim/` is organized one module per concern; `src/sim/index.ts`
re-exports the public API. The dependency chain runs roughly:

```
worldData (Location, geography) + distance -> routes (Route/RouteType) -> markets (Market)
  -> transport (Transport/Ship/WagonTrain/Plane) -> crew (Crew/Sailor) -> captain (Captain)
  -> faction (Faction/Company/SoloTrader/PirateBrigade/PoliceFleet) -> world (World)
```

| Module | Responsibility |
| --- | --- |
| `location.ts` | `Location`, `TerminalType` — produce/consume/stockpile model; `ContractIssuer` |
| `politicalEntity.ts` | `PoliticalEntity` — groups Locations, shares one cash balance, carries a `nationality` |
| `commodity.ts` | `Commodity` — per-commodity pricing params and event templates; `buildCommodities()` |
| `distance.ts` | Flat (Euclidean) vs. globe (great-circle) distance model and its `DistanceConfig` |
| `nationality.ts` | `Nationality` and the map from each to its person/ship/company name pools |
| `worldData.ts` | Commodity roster + procedural geography; `distanceBetween`, `setGeography`, `setDistanceConfig`, `assignPoliticalEntities` |
| `routes.ts` | `Route`/`RouteType`; the network `ROUTES: Map<string, Route[]>` (multiple types per pair), `getRoutes`, `getRoute`, `addRouteToNetwork` |
| `pathfinding.ts` | Dijkstra shortest-path over the route network, restricted per-Transport |
| `events.ts` | `MarketEvent`/`TransportEvent`/`CompanyEvent`/`LocationClosure` |
| `markets.ts` | `Market` — stockpile-deviation pricing |
| `transport.ts` | `Transport`/`Ship`/`WagonTrain`/`Plane`, `SHIP_CLASSES` |
| `crew.ts` | `Crew` (base) and `Sailor` (generic waged crew) |
| `captain.ts` | `Captain` — the trading agent |
| `names.ts` / `shipNames.ts` / `companyNames.ts` | per-nationality name pools + generators |
| `faction.ts` | `Faction`/`Company`/`SoloTrader`/`PirateBrigade`/`PoliceFleet`; `ContractFulfiller` |
| `contracts.ts` | `Contract`, `BulletinBoard` — Location-funded one-shot supply orders |
| `world.ts` | `World` — orchestrates everything, runs the daily loop |
| `buildWorld.ts` | Builds the default procedurally generated world + fleet |
| `buildWorldFromJson.ts` | Builds a `World` from an editor-exported JSON, synthesizing the fleet |
| `analysis.ts` / `analysis.harness.ts` | Seed-averaged tuning-sweep helpers and the `npm run sweep` entry point |
| `rng.ts` / `simRandom.ts` | `Rng` seeded PRNG and the simulation's shared reseedable stream |

See **`doc/Architecture.md`** for the full design (economics, events,
factions, contracts, distance modes, JSON loading and fleet synthesis),
**`doc/World.md`** for a task→file map, and **`doc/Simulation.md`** for the
empirical tuning record behind the calibrated defaults.

## Tests

`src/sim/__tests__/*.test.ts` (vitest) exercise the engine directly — the
default procedural world, hand-built worlds via `buildWorldFromJson`, and
per-concern unit tests (distance modes, multiple routes, fleet synthesis,
contracts, faction cash pooling, PoliticalEntity affiliation, spaceship
routing, …). The editor has no automated suite; verify it in a browser.
