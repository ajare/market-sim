# Architecture

This document describes the design of the market-sim codebase in depth: the
economic model the simulation implements, and how each piece of that model
is actually built in code. It complements `README.md` (quick start),
`CLAUDE.md` (terse guidance for coding agents), and `Simulation.md` (the
empirical tuning record behind the fleet/economy calibration) with a full
walkthrough suitable for someone extending or auditing the system. It
covers the TypeScript implementation under `src/` -- the simulation engine,
its build/tuning surface, and the React web UI that drives it.

## 1. What this simulates

market-sim is an agent-based simulation of commodity trading across a
network of locations. Each **Location** is an economic actor in its own
right: it **produces** some commodities and **consumes** others, keeps a
physical **stockpile** of each, and its willingness to trade -- and the
price it trades at -- is driven by how full or empty that stockpile is
relative to a reference level. Independent, profit-seeking **Captain**
agents (each running a physical **Transport** -- a ship, train, or plane)
discover arbitrage opportunities between locations, buy where a commodity
is in surplus, haul it across a routed geography paying fuel and time
costs, and sell where it's scarce. Some Captains act alone; others belong
to a **Company** that pools capital and actively coordinates its fleet.
Locations also proactively tender one-shot supply **Contracts** when
running low, which a `Company` can claim and service alongside (or instead
of) ordinary arbitrage. A `PirateBrigade`/`PoliceFleet` raiding/patrol
system exists in the engine but isn't part of the world the app actually
builds today (see §8.2-8.3). A random **event** system layers demand/supply
shocks, per-transport mishaps, per-company windfalls/setbacks, and
whole-port closures on top of the baseline economy. **World** owns and
drives the whole thing one simulated day at a time, and everything is
reproducible from a small number of independent random seeds.

The system can be driven three ways:

- `npm run dev` -- a Vite dev server hosting the live React UI (`src/App.tsx`
  and its panels), backed by a Zustand store (`src/state/useSimStore.ts`)
  that wraps a `World` with play/pause/step controls.
- `npm test` (vitest) -- `src/sim/__tests__/*.test.ts` exercises the engine
  directly: the default procedurally generated world, hand-built fixture
  worlds, and unit tests for individual modules (contracts, faction cash
  pooling, location validation, ...).
- `npm run sweep` -- a separate vitest config (`vitest.sweep.config.ts`)
  runs `src/sim/analysis.harness.ts`, a seed-averaging tuning harness for
  the fleet-size/stockpile-ratio calibration described in `Simulation.md`.

## 2. Module map and dependency chain

`src/sim/` holds the simulation engine; `src/sim/index.ts` re-exports its
public API as one barrel. The dependency chain runs roughly:

```
worldData (Location, geography) -> routes (Route/RouteType) -> markets (Market)
  -> transport (Transport/Ship/WagonTrain/Plane) -> crew (Crew/Sailor) -> captain (Captain)
  -> faction (Faction/Company/SoloTrader/PirateBrigade/PoliceFleet) -> world (World)
```

`contracts.ts` sits beside `faction.ts`/`captain.ts` (both depend on it, and
`World` orchestrates it) rather than earlier in the chain. `buildWorld.ts`
and the `src/state/` + `src/components/` UI layer sit on top of everything.

| Module | Responsibility |
| --- | --- |
| `location.ts` | `Location`, `TerminalType` -- a trading hub's produce/consume/stockpile model, plus its `cash` pool and Contract-tendering threshold; `ContractIssuer`, the base class `Location` posts Contracts through |
| `politicalEntity.ts` | `PoliticalEntity` -- groups Locations, shares one cash balance among them (§3.6), and carries a `nationality` (§8.4) |
| `commodity.ts` | `Commodity` -- per-commodity base price/sensitivity/deficit-and-excess-boost/event-templates, and `buildCommodities()` |
| `distance.ts` | The flat (Euclidean) vs. globe (great-circle) distance model and its `DistanceConfig` (§4.2) |
| `nationality.ts` | `Nationality` and `NATIONALITY_POOLS` -- the map from each nationality to its person/ship/company name pools (§8.4) |
| `worldData.ts` | The commodity roster (`COMMODITIES`), procedurally generated geography (`LOCATIONS`, `LOCATION_COORDINATES`, `getLocation`, `distanceBetween`, `travelDaysBetween`, `generateLocations`, `generateCoordinates`, `assignPoliticalEntities`), and the active `DISTANCE_CONFIG` (`setDistanceConfig`, §4.2) |
| `routes.ts` | `Route`/`RouteType`, the route network `ROUTES: Map<string, Route[]>` (multiple routes of different types per pair, §4.1), `generateRoutes`, `getRoutes`, `getRoute`, `addRouteToNetwork` |
| `pathfinding.ts` | Dijkstra shortest-path routing over the Route network, restricted per-Transport |
| `events.ts` | `Event` base class and its four kinds: `MarketEvent`, `TransportEvent`, `CompanyEvent`, `LocationClosure`, plus every template list |
| `markets.ts` | `Market` -- stockpile-deviation pricing and the day-to-day price update |
| `transport.ts` | `Transport`/`Ship`/`WagonTrain`/`Plane`, `SHIP_CLASSES` presets |
| `crew.ts` | `Crew` (bare identity, base class for anyone operating a Transport) and `Sailor` (generic waged crew) |
| `captain.ts` | `Captain` -- the trading agent, a `Crew` subclass |
| `names.ts` | `randomName()` + per-language first/last name pools for naming Captains |
| `faction.ts` | `Faction`/`Company`/`SoloTrader`/`PirateBrigade`/`PoliceFleet`, `ContractStrategy`; `ContractFulfiller`, the base class `Company` accepts Contracts through |
| `contracts.ts` | `Contract`, `ContractType`, `BulletinBoard`, `contractKey` -- Location-funded one-shot supply orders |
| `world.ts` | `World` -- orchestrates everything, runs the daily loop |
| `buildWorld.ts` | Builds the default procedurally generated world + fleet |
| `analysis.ts` / `analysis.harness.ts` | Seed-averaged tuning-sweep helpers (`stockpileRatio`, `averageStockpileRatio`) and the `npm run sweep` entry point |
| `eventOverlay.ts` | Maps `World.eventLog` entries onto a `(location, commodity)` market, for chart overlay markers |
| `rng.ts` / `simRandom.ts` | `Rng`, a seeded PRNG, and the simulation's own shared reseedable stream |

There are two world-building entry points on top of the engine:

- `buildWorld()` (`buildWorld.ts`, called once by `useSimStore`'s `reset()`)
  assembles the default `World` procedurally; every knob is a plain function
  option (`BuildWorldOptions`, see §11).
- `buildWorldFromJson()` (`buildWorldFromJson.ts`) builds a `World` from the
  single JSON document the **World editor** (`editor/`, a separate Vite app)
  exports, and synthesizes a fleet up to the required ship count so a
  lightly-authored world still runs a full economy (§11.2).

There is no CSV-driven world-building path; a world is either the procedural
default or an editor-authored JSON.

### Mutable module-level world state

`worldData.ts`'s `LOCATIONS`/`LOCATION_COORDINATES`/`COMMODITIES` and
`routes.ts`'s `ROUTES` are exported `let` bindings, reassigned wholesale by
`setGeography`/`setCommodities`/`setRoutes` -- called once by `buildWorld()`,
or directly by a test that wants a small hand-built world (see `contracts.test.ts`'s
`setGeography` calls). Every function that reads this state
(`distanceBetween`, `getRoute`, `findShortestPath`, ...) reads it off its own
defining module's live binding at call time -- ES module named imports are
live references (a reassignment via `setGeography` is visible to every
importer immediately, no re-import needed), so a wholesale swap propagates
everywhere automatically. `pathfinding.ts`'s adjacency cache is a `WeakMap`
keyed by the `ROUTES` Map object itself, so a `setRoutes` reassignment (a
new Map instance) naturally gets a fresh cache entry with no manual
invalidation.

## 3. Economic design: production, consumption, and stockpile-driven pricing

This is the heart of the simulation's economics, implemented across
`location.ts`, `commodity.ts`, and `markets.ts`.

### 3.1 A Location is a produce/consume/stockpile machine

`Location extends ContractIssuer` (§9) -- the only thing that base class
adds is a protected `postContract(board, contract)` method, so this section
covers `Location`'s own produce/consume/stockpile model in full; its
Contract-posting behavior (`tenderContracts`) is described in §9.

Every commodity a `Location` deals in has exactly one of two roles, and the
role determines everything about how that commodity's price and
tradeability behave:

- **Produced** (`producedCommodities: Record<string, number>`, commodity
  name -> units produced per day): added to the local stockpile every day.
  A Location always tries to sell off any positive stockpile of something
  it produces -- it never "needs" what it makes, so all of it is surplus. A
  Captain **buys** a produced commodity from the Location.
- **Consumed** (`consumedCommodities: Record<string, number>`, commodity
  name -> units consumed per day): drawn down from the local stockpile
  every day. A Location maintains a **minimum stockpile** (`minStockpiles`)
  of anything it consumes, and only wants to buy more of it once its
  stockpile drops below that minimum. A Captain **sells** a consumed
  commodity to the Location.

A commodity can never be both produced and consumed at the same Location --
the constructor throws if the two records share a key. This mutual
exclusivity is what lets `World` build exactly one `Market` per
`(location, commodity)` pair (see §3.3).

Fields (`LocationInit`):

```ts
name: string;
producedCommodities: Record<string, number>;  // commodity -> production rate/day, added to stockpile
consumedCommodities: Record<string, number>;  // commodity -> consumption rate/day, drawn from stockpile
stockpiles: Record<string, number>;           // commodity -> current stockpile (covers both roles)
minStockpiles: Record<string, number>;        // commodity -> minimum target (consumed commodities only)
basePrices: Record<string, number>;           // commodity -> reference price (both roles)
fuelPrice: number;                            // flat, never-fluctuating Fuel price here
terminalTypes: ReadonlySet<TerminalType>;     // Port/Wagon yard/Airport/Platform
fenceFraction?: number;                       // default 0.5 -- black-market discount when pirates fence cargo here
cash?: number;                                // default 10 billion -- funds this Location's trades AND Contract deliveries
contractThresholdFraction?: number;           // default 1.5 -- see needsContractRestock
```

Key methods:

- `canBuy(commodity)` -- true if a Captain can buy here: the commodity is
  produced here **and** the stockpile is > 0.
- `canSell(commodity)` -- true if a Captain can sell here: the commodity is
  consumed here **and** the stockpile is below its minimum.
- `needsContractRestock(commodity)` -- true if a fresh supply Contract
  should be tendered: stockpile at or below `contractThresholdFraction`
  times the minimum target -- a proactive trigger (default 1.5x), not just
  an actual deficit like `canSell`'s 1x. See §9.
- `referenceStockpile(commodity)` -- the baseline a commodity's price is
  measured against (see §3.2): `minStockpiles[commodity]` for something
  consumed here, or the **frozen starting** stockpile for something
  produced here (captured once at construction, since the live
  `stockpiles` value moves every day).
- `dailyUpdate()` -- called once per Location per simulated day by `World`:
  adds each produced commodity's rate to its stockpile, subtracts each
  consumed commodity's rate (floored at 0).

Why a *frozen* reference for produced commodities but a *live* one
(`minStockpiles`) for consumed commodities? A consumed commodity's
"comfortable" level doesn't change over the run -- the Location always
wants at least `minStockpiles[c]` on hand. A produced commodity has no such
fixed target (it never runs out on its own); the Location's *starting*
stockpile is used purely as the "normal" baseline production levels were
tuned around.

`cash` is a genuinely finite pool (default 10 billion, not literally
unlimited): it funds both sides of every trade this Location makes and
every Contract it issues, and a Location that runs out (`cash <= 0`) stops
tendering new Contracts (`tenderContracts`, §9) until it recovers. `cash`
is a getter/setter, not a plain field: if this Location belongs to a
`PoliticalEntity` (§3.6), reads/writes redirect to that PoliticalEntity's
shared balance -- this Location's own starting cash no longer matters once
that happens -- exactly mirroring `Captain.cash`'s pooling-vs-own-balance
split against a `Faction` (§8). A standalone Location with no
PoliticalEntity (e.g. in a hand-built test world) just uses its own
balance.

### 3.2 Stockpile-deviation pricing (`Market.stockpilePrice`)

Every `Market` (see §3.3) computes its own day's price from how far the
Location's current stockpile sits from its reference level -- not from any
order-book or synthetic buyer/seller curve:

```ts
private stockpilePrice(): number {
  const reference = this.location.referenceStockpile(this.commodityName);
  if (reference <= 0) return this.basePrice;
  const current = this.location.stockpiles[this.commodityName] ?? 0.0;
  const deviation = Math.max(-2.0, Math.min(2.0, (reference - current) / reference));
  let sensitivity = COMMODITIES[this.commodityName]?.priceSensitivity ?? DEFAULT_PRICE_SENSITIVITY;

  // Consumer deficit boost (sell markets): ramps in early, once stock falls
  // below 1.3x reference, not just once it's a true deficit (below 1x).
  const deficitThreshold = 1.3 * reference;
  if (current < deficitThreshold && this.side === "sell") {
    const boostProgress = Math.max(0, Math.min(1, (deficitThreshold - current) / deficitThreshold));
    const boost = COMMODITIES[this.commodityName]?.deficitPriceBoost ?? DEFAULT_DEFICIT_PRICE_BOOST;
    sensitivity *= Math.pow(boost, boostProgress);
  }

  // Producer excess boost (buy markets): the mirror image -- ramps in as
  // stock climbs ABOVE reference, up to 3x reference (where deviation itself
  // saturates at -2).
  const excessCeiling = 3 * reference;
  if (current > reference && this.side === "buy") {
    const excessProgress = Math.min(1, (current - reference) / (excessCeiling - reference));
    const boost = COMMODITIES[this.commodityName]?.excessPriceBoost ?? DEFAULT_EXCESS_PRICE_BOOST;
    sensitivity *= Math.pow(boost, excessProgress);
  }

  return Math.max(0.5, this.basePrice * (1 + sensitivity * deviation));
}
```

Reading this as a story: `deviation` is positive when the stockpile sits
**below** its reference (a produced commodity sold down, or a consumed one
drawn toward/past its minimum) and negative when it sits **above** the
reference. Price moves in the same direction as deviation, scaled by a
per-commodity `sensitivity` (e.g. Crude Oil reacts harder than Gold) --
clamped to a [-2, 2] deviation range and a $0.50 floor. The `COMMODITIES[name]`
lookup falls back to `DEFAULT_PRICE_SENSITIVITY`/`DEFAULT_DEFICIT_PRICE_BOOST`/
`DEFAULT_EXCESS_PRICE_BOOST` for a commodity with no registered `Commodity`
at all, so an unusual world configuration degrades gracefully.

**Deficit and excess boosts are both exponential ramps, not flat
multipliers**, and both are symmetric in shape (mirror images of each
other) even though they apply to opposite sides of a Location's trade:

- On the **sell** side (a Captain selling *into* a Location that consumes
  the commodity), `sensitivity` gets boosted starting once stock falls
  below **1.3x** its reference, ramping via `boost ^ boostProgress` up to
  the full `deficitPriceBoost` right at zero stock -- pulling more Captains
  toward relieving a shortage before it becomes a true deficit.
- On the **buy** side (a Captain buying *from* a Location that produces the
  commodity), the mirror boost kicks in once stock climbs *above* its
  reference, ramping up to the full `excessPriceBoost` by **3x** reference
  -- pulling more Captains toward buying up a growing surplus.

`excessPriceBoost` defaults to each commodity's own `deficitPriceBoost`
(`commodity.ts`'s `EXCESS_PRICE_BOOST` table is empty by design), so by
default every commodity is exactly as price-elastic to surplus as it is to
shortage; override an entry in `EXCESS_PRICE_BOOST` to tune the two sides
independently for a specific commodity.

**`Commodity` (`commodity.ts`)** carries `priceSensitivity`/
`deficitPriceBoost`/`excessPriceBoost` (and `eventTemplates`, see §7.1) per
commodity. `COMMODITIES: Record<string, Commodity>` (`worldData.ts`) is the
single roster every one of those pieces of data lives on, built by
`buildCommodities(names, basePrices)` -- which fills in the ten default
commodities' hand-tuned values (`PRICE_SENSITIVITY`/`DEFICIT_PRICE_BOOST`/
`BESPOKE_EVENT_TEMPLATES`/`GENERATED_EVENT_DRIVERS`), or the `DEFAULT_*`
constants and a generic four-event pack for anything else. `buildCommodities`
throws if the roster falls outside `[MIN_COMMODITIES, MAX_COMMODITIES] =
[5, 25]` (calibrated via the sweeps in `Simulation.md`). Fuel is
deliberately **not** a `Commodity` -- see §3.4.

That raw stockpile price is then combined with the active `MarketEvent`
multipliers for the day (`price *= demandMult / supplyMult` -- see §7.1)
and a small Gaussian noise term, then floored at $0.50 again, in
`Market.simulateDay` (§3.3).

### 3.3 `Market`: one per (location, commodity, side)

`World`'s constructor builds exactly one `Market` per commodity a Location
produces (stored in `World.buyMarkets`, keyed by `marketKey(location,
commodity)` -- `side: "buy"`, since that's where a Captain buys) and one per
commodity it consumes (`World.sellMarkets`, `side: "sell"`). Every Location
additionally and unconditionally gets a `Fuel` entry in `buyMarkets` (§3.4)
-- Fuel never appears in `producedCommodities`/`consumedCommodities` at all.

A `Market` holds a **reference to its owning `Location`** (not just its
name) so it can read/write the live stockpile directly:

```ts
class Market {
  constructor(commodityName, locationName, location: Location,
              startingPrice, basePrice, side, eventProbability = 0.01, fixedPrice = false) {
    this.location = location;       // live link for pricing/availability/trades
    this.side = side;               // "buy" or "sell"
    this.price = startingPrice;     // evolves day to day
    this.basePrice = basePrice;     // fixed reference the stockpile formula measures against
    this.fixedPrice = fixedPrice;   // true only for Fuel -- never clears, never moves
    this.activeEvents = [];
  }
}
```

Three properties/methods let `Captain` interact with a Market without
reaching into `Location` directly:

- **`isAvailable`** -- whether a Captain can trade here *today*: always
  `true` for the flat, unlimited Fuel market; otherwise `location.canBuy(commodity)`
  (buy side) or `location.canSell(commodity)` (sell side).
- **`availableQuantity`** -- how much can actually be bought here today. On
  the buy side, a **hard physical cap**: the Location's current stockpile.
  On the sell side, `Infinity` -- a Location always accepts a Captain's
  *full* cargo while in deficit, avoiding partial-fill bookkeeping. Fuel is
  never capped either way.
- **`applyTrade(quantity)`** -- the point where a Captain's trade
  **physically moves the Location's stockpile**: buying draws the produced
  commodity's stockpile down (floored at 0); selling adds to the consumed
  commodity's stockpile. A no-op for a fixed-price (Fuel) market. Also
  accumulates a volume-traded-today counter, reported in the daily record
  and reset each day.

`Market.simulateDay(day, isOpen)` is called once per Market per day by
`World.runDay` (§10), after every Captain has already acted for the day (so
agents always trade at the *previous* day's closing price). Three branches:

1. **Fixed-price** (Fuel): no clearing, no events, price never moves -- just
   a flat daily record so its history has the same shape as every other
   Market's.
2. **Closed port** (`isOpen = false`): price frozen, no *new* local event
   rolls, but existing active events keep ticking down in the background.
3. **Normal**: maybe roll a new Local `MarketEvent` for this Market (§7.1),
   compute `newPrice = stockpilePrice() * demandMult / supplyMult`, apply
   Gaussian noise (`randGauss(0, 0.01)`), floor at 0.5, and record.

The per-day `MarketRecord` includes `day`, `location`, `commodity`, `side`,
`price`, `stockpile`, `referenceStockpile`, `volumeTraded`,
`demandMultiplier`, `supplyMultiplier`, `activeEvents`, `newEvent`, and
`closed` -- pushed into `World.combinedHistory` and consumed directly by
the chart panels (`StockHistoryPanel`, `PriceHistoryPanel`; see §13).

### 3.4 Fuel is deliberately outside this system

Fuel is priced per-location (`Location.fuelPrice`, seeded from
`FUEL_BASE_PRICE = 1.25`) but **never fluctuates** and is **never** part of
the produce/consume/stockpile model at all -- it isn't tracked as a
stockpile, doesn't appear in `producedCommodities`/`consumedCommodities`,
is **not** a `Commodity`, and its `Market` is always constructed with
`fixedPrice = true`. Every Location, including the three pure "fuel depot"
locations (which trade nothing else), always has a buyable Fuel market.

### 3.5 Procedural generation (`generateLocations`, `worldData.ts`)

The default world is built once, procedurally, from a fixed seed
(`WORLD_GEN_SEED = 2024`) using a dedicated `Rng` stream -- independent of
the simulation's own trading/event randomness, so the network layout is
reproducible regardless of what agents do. Generation runs in three passes:

1. **Draft produce/consume rates.** For each non-depot location, sample
   `[minPerRole, maxPerRole]` commodities (default `[2, 4]`, bounded by
   `[MIN_COMMODITIES_PER_LOCATION, MAX_COMMODITIES_PER_LOCATION] = [2, 6]`)
   into `producedCommodities`, then sample the same range from what's left
   into `consumedCommodities` (guaranteeing no overlap), each at rate
   `U(3, 15)`/day.
2. **Balance world-wide supply and demand per commodity.** Left alone,
   independently-rolled produce/consume rates create a structural,
   permanent glut or shortage no amount of trading can fix. For each
   commodity, total production and total consumption across every location
   are rescaled toward their average, preserving each location's relative
   share of world supply/demand.
3. **Derive stockpiles/minStockpiles/basePrices from the balanced rates.**
   For a consumed commodity: `minStockpiles[c] = rate * minStockpileDays`
   (parameter, default `DEFAULT_MIN_STOCKPILE_DAYS = 14`) and
   `stockpiles[c] = minStockpiles[c] * consumedStockpileFactor` (parameter,
   default `DEFAULT_CONSUMED_STOCKPILE_FACTOR = 2.0`). For a produced
   commodity: `stockpiles[c] = rate * U(10, 25)` (10-25 days of accumulated
   output, doubling as the frozen price reference). Both roles get
   `basePrices[c] = COMMODITIES[c].basePrice * U(0.85, 1.15)`.

`minStockpileDays` was raised from an initial `7.5` to `14` on the strength
of a seed-averaged sweep showing it cuts real stockout frequency by >20x
with only a mild effect on the aggregate stockpile-ratio metric -- see
`Simulation.md`'s Findings 6-7 for the full sweep.

Terminal types: always includes `Port`, plus 0-2 random others, except
`Platform`, which is exclusive (a location drawing it gets *only*
`Platform`, enforced in the `Location` constructor). Fuel depot locations
get empty produce/consume/stockpile records and only the flat `fuelPrice`.

Geography (`generateCoordinates`) scatters every location across a
synthetic 3000x3000 plane using a *different* independent `Rng` stream
(`seed + 1`), rejecting candidates within 200 units of an already-placed
point (up to 1000 attempts) so no two locations collapse to the same spot.
`distanceBetween` measures distance over these coordinates under the active
distance mode (§4.2) -- Euclidean by default (the procedural world is always
flat), great-circle in a globe-mode authored world; `travelDaysBetween`
converts that to whole days at a given speed (`ceil(distance / speed)`,
minimum 1 day even for the same location).

### 3.6 `PoliticalEntity`: proximity-grouped Locations sharing one cash balance

`politicalEntity.ts`'s `PoliticalEntity` groups a set of Locations and gives
them a single shared cash balance -- the Location-level analog of `Faction`
pooling a fleet's Captains' cash (§8). `PoliticalEntity.cash` defaults to
`DEFAULT_POLITICAL_ENTITY_CASH = 10,000,000,000` regardless of how many
Locations join (not derived from summing them); the constructor just sets
`location.politicalEntity = this` on each member, no cash movement
involved. From then on, every member Location's `cash` getter/setter
(§3.1) transparently redirects to `PoliticalEntity.cash` -- its own
starting balance stops mattering the moment it joins. Existing code that
reads/writes `location.cash` (trade execution in `captain.ts`,
`needsContractRestock`'s broke check, ...) needed no changes at all.

A `PoliticalEntity` also carries a **`nationality`** (one of English/French/
Spanish/Dutch/Portuguese, default English) -- purely a naming input: it seeds
the ship/captain names generated for its affiliated Companies when a fleet is
synthesized on JSON load (§8.4, §11.2). The procedural world's entities keep the
default; an editor-authored world sets it per entity.

`worldData.ts`'s
`assignPoliticalEntities(locations, seed, targetLocationsPerPoliticalEntity)`
builds the default world's PoliticalEntities by proximity: it shuffles the
location list (its own seed stream, `WORLD_GEN_SEED + 3`, independent of
location/coordinate/route generation and the fleet), then repeatedly takes
the next unassigned location and greedily pulls in its
`targetLocationsPerPoliticalEntity - 1` nearest still-unassigned neighbors
(via `distanceBetween`, so this must run *after* `setGeography` has set
coordinates) to form one `PoliticalEntity`, until every location is
assigned -- the last group may end up smaller if the total doesn't divide
evenly. `buildWorld.ts` calls this right after `setRoutes`, targeting
`DEFAULT_LOCATIONS_PER_POLITICAL_ENTITY = 5` Locations per PoliticalEntity
by default (`BuildWorldOptions.locationsPerPoliticalEntity`), and returns
the resulting `PoliticalEntity[]` as `BuiltWorld.politicalEntities`.

## 4. Geography and routing

### 4.1 Routes (`routes.ts`)

A `Route` is an undirected, typed connection between two locations
(`RouteType`: `Sea` / `Land` / `Air` / `Space` / `Road` / `Railroad`), with
`distance` measured once at construction under the active distance mode
(§4.2) as the arc length along its (possibly Bezier-curved) path -- it never
invents a second source of geographic truth. `ROUTE_TERMINAL_COMPATIBILITY`
maps each `RouteType` to the `TerminalType`(s) both endpoints must share at
least one of (`Sea` needs `Port` or `Platform`; `Land` needs `Wagon yard`;
`Air` needs `Airport`; `Space` a `Spaceport`; `Road` a `TransitDepot`;
`Railroad` a `Station`).

**A location pair can hold more than one Route, of different types.** The
network is a `Map<string, Route[]>` keyed by `routeKey(a, b)` -- a canonical,
order-independent string (`[a, b].sort().join("||")`) -- whose value is the
list of routes connecting that pair, at most one per `RouteType`.
`addRouteToNetwork` groups a Route by its pair and drops a duplicate type.
`getRoutes(a, b)` returns every route between the pair (in either argument
order); `getRoute(a, b)` returns the single shortest one, for display. So a
Sea route and an Air route between the same two ports coexist, and
pathfinding (§4.3) treats each as its own edge -- weighing them per whichever
Transport is planning. `generateRoutes` still builds just one Route per pair
(randomly picking among compatible types, a third independent `Rng` stream,
`seed + 2`), optionally trimming pairs farther apart than `maxDistance *
ROUTE_TYPE_DISTANCE_SCALE[routeType]` (Air gets the full cap, Sea 80%,
Land 50%); multiple routes per pair arise from editor-authored worlds.

### 4.2 Distance modes: flat plane vs. globe (`distance.ts`)

Every distance in the simulation -- `distanceBetween`, each `Route.distance`,
and route-generation pruning -- is measured under a single module-level
`DistanceConfig` held in `worldData.ts` (`setDistanceConfig`/
`getDistanceConfig`). Two modes:

- **`flat`** (the default): the world is a plane and distance is the plain
  Euclidean (Cartesian) distance between world coordinates. With the default
  `worldScale = 1`, `distanceBetween` is exactly `Math.hypot` -- byte-for-byte
  the pre-existing behavior, so the procedural world is unchanged.
- **`globe`**: the world is the surface of a sphere. Each position's
  normalized `[0,1]` fraction of the map is read as a longitude/latitude
  (over a configurable `lonSpan`, the same degrees-per-fraction on both axes
  so a square world stays undistorted, clamped to valid lon/lat), and
  distance is the great-circle distance `radius × centralAngle` (haversine) --
  in the same world-size units as the flat distance, since `radius` is in
  world units. A curved Route's length sums the great-circle distance between
  its sampled curve points, the spherical analog of the flat arc length.

`buildWorld` resets the config to `flat` at the start (so a prior JSON build
can't leak globe mode into the procedural world); `buildWorldFromJson`
installs the mode/radius/lonSpan/worldScale the authored world specifies
(§11.2) before building any Routes, since a Route measures its length under
the active mode at construction. The editor mirrors this math in
`editor/src/distance.ts` so authored distances match what the sim runs.

### 4.3 Pathfinding (`pathfinding.ts`)

A hand-rolled Dijkstra (with its own binary min-heap, not a library),
weighted by `Route.distance`, restricted to whichever edges a `canUseRoute`
predicate (almost always `Transport.canUseRoute`) accepts -- so a
landlocked `WagonTrain` never gets offered a leg it would have to sail or fly.
The full (unfiltered) adjacency graph is expensive to build and identical
for every Transport, so it's built once and cached (`primeRouteGraphCache`,
called by `World`'s constructor) rather than rebuilt per lookup;
per-Transport restrictions are applied cheaply while walking the cached
graph.

`findShortestPath` accepts an `avoidNodes` set (intended to exclude
currently-closed locations as intermediate stops), but **no call site in
the codebase currently passes one** -- every caller (`Captain`, `Company`)
omits it, so closed locations are never actually excluded from pathfinding
today. This happens to still produce the intended behavior (a closed
location can be passed through, only actually docking/trading/refueling
there is gated -- by `closedLocations` checks in `Captain.act` and
`refuelAtStop`, and by candidate-filtering in `Company`/`PirateBrigade`/
`PoliceFleet`'s `directFleet`), just via a different mechanism than
`avoidNodes` would provide: pathfinding is simply never restricted by
closure at all, and every downstream consumer independently checks
`closedLocations` before actually using a location. `findShortestPath`
returns the ordered list of `Route` edges to traverse, or `null` if no path
exists at all for that Transport.

This is what lets a Captain plan a genuine multi-hop voyage through
intermediate locations when no direct Route exists.

## 5. Transport and Crew

### 5.1 `Transport` (`transport.ts`)

Pure hardware, decoupled from the trading agent that operates it: cargo
capacity, speed, fuel efficiency (loaded and reposition/ballast rates
tracked separately), a flat per-voyage fixed shipment cost, and a fuel tank
capacity. `TransportStatus` is `"AtLocation"` / `"InTransit"` / `"Inactive"`
(the last meaning its owning Faction couldn't afford its crew wages for the
day -- see §6.3 -- so it stops burning fuel or making progress until it can
pay again). The base `Transport` class is **unrestricted**
(`allowedRouteTypes()` returns `null`, meaning any `RouteType` is usable).
`Ship` overrides `allowedRouteTypes()` to `["Sea"]` only, `WagonTrain` to
`["Land"]`, `Plane` to `["Air"]` -- so `Captain.canUseRoute` (really
`Transport.canUseRoute`) naturally excludes any leg a Transport can't
physically travel, from every route-planning method, the same way a closed
port is excluded.

`currentFuel: number | null` is the live fuel gauge; `null` (the default
for `SailingVessel`) means this Transport doesn't track fuel at all and
never needs refueling regardless of trip length. `needsRefuel(required)`,
`consumeFuel(amount)`, `refuel(amount)` are the gauge's whole interface.

`SHIP_CLASSES` offers five off-the-shelf presets spanning the
capacity/speed/efficiency trade-off space:

| Class | Cargo | Speed/day | Fuel/dist (loaded) | Fixed cost | Fuel capacity |
| --- | --- | --- | --- | --- | --- |
| Speedster | 80 | 800 | 0.003 | $8 | 60 |
| Handysize | 120 | 600 | 0.0035 | $10 | 90 |
| Panamax | 200 | 500 | 0.004 | $15 | 140 |
| Capesize | 350 | 400 | 0.0045 | $25 | 220 |
| SailingVessel | 100 | 300 | 0.0 (never refuels) | $5 | 0 |

### 5.2 `Crew` (`crew.ts`)

`Crew` is a bare identity/assignment layer: a name, which `Transport` (if
any) it currently runs, and a `dailyWages` figure owed to its owning
Faction only while that Transport is actually `InTransit` (idle time in
port is free). `Sailor` is a generic waged deckhand (default $20/day) used
to pad a Transport's roster up to its `crewRequirement` beyond the Captain
(who is itself a `Crew` member and costs nothing extra by default).
`Faction`'s constructor (§8) is what actually assembles a Transport's
`crew` list.

## 6. Captain: the trading agent

`Captain` (`captain.ts`) subclasses `Crew` and adds all trading-agent
behavior on top: cash, risk threshold, price impact, route planning, and
event exposure. It occupies exactly one location at a time and runs a
single `Transport` -- there's no teleportation and no parallel shipments;
while `InTransit` it's committed to its destination and can't act again
until it arrives.

### 6.1 Daily action loop (`Captain.act`)

Called once per day by `World.runDay` for every Captain, in an order
decided by `agentOrderFn` (default `randomAgentOrder`: a fresh shuffle each
day, so first-mover advantage on a shared Market price doesn't structurally
favor whichever agent happens to sit first in a list):

1. Roll for a `TransportEvent` today (§7.2) and tick down any already
   active.
2. If `InTransit`: pay today's crew wages (or go `Inactive` if the Faction
   can't afford them), burn fuel, tick down `daysRemaining`. On arrival day,
   `arrive()` either advances to an intermediate stop on a multi-hop path
   (refueling there if needed and not closed) and stays `InTransit`, or
   genuinely docks at the final destination.
3. Once in port (already was, or just arrived): if the current port is
   closed, do nothing further this turn. Otherwise sell any cargo it's
   carrying if the destination Market is `isAvailable` (§3.3) -- or, if the
   cargo is contract-bound, deliver it against the Contract instead (§9);
   if it's grounded (from a "delay" `TransportEvent`) or this is the very
   day it just arrived, stop here -- a Transport always spends at least one
   night in port before departing again.
4. If empty-handed and not otherwise blocked: either follow a
   `Directive` a `Faction` supplied (§8) -- a trade route, a bare
   `REPOSITION`, or a `CONTRACT_DELIVER` -- or plan its own arbitrage route
   autonomously (`planAndDepart`).

### 6.2 Route scoring and the daily-return threshold

`routeEconomics` computes the full cost/time picture for shipping
`quantity` units from an origin to a destination along the single shortest
path Dijkstra returns for that Transport: cargo cost at the current buy
price, fuel cost leg by leg (each priced at *that* leg's origin's live Fuel
price, since a path may be multi-hop), the Transport's flat
`fixedShipmentCost`, and crew wages for every day the voyage takes
(`Crew.dailyWages`, owed only while `InTransit`). A route is infeasible
(`dailyReturnPct = -1`) if no path exists at all, or if **any single leg**
of the (one) path found needs more fuel than the Transport's tank could
ever hold -- refueling actually happens automatically at each intermediate
stop the chosen path passes through (`arrive()`'s `refuelAtStop`), but
`routeEconomics` doesn't search for an *alternate* path just to make an
over-long leg fit; it only validates leg-by-leg feasibility of the one path
Dijkstra already returned.

It returns, among other things, `dailyReturnPct = expectedProfit / totalCost
/ totalDays` -- **profit per day of capital tied up**, not raw profit. This
is what lets a Captain fairly compare a short cheap route against a long
expensive one: it passes up a wide-but-slow-and-costly route in favor of a
narrower-but-fast-and-cheap one, and stays in port entirely if fuel and
fixed costs eat the whole spread.

`findBestLocalRoute` only considers commodities **buyable right where the
Captain is standing now** (produced with positive stockpile) and only
candidate destinations that are `isAvailable` on the sell side. Trial
quantity is capped by cargo capacity, cash, **and** `availableQuantity`
(the physical stockpile cap on the buy side). Only routes clearing
`minDailyReturnPct` (a per-Captain configurable threshold) are candidates;
the single best by daily return is chosen. It's public (not private) since
`Company.directFleet` calls it directly on an idle captain to score its
best route, and (in `"compare"` contract-strategy mode) to weigh it against
a Contract on a common basis -- see §8.1.

`executeLocalRoute` re-derives quantity/price/profitability from *live*
market state at execution time (which may have moved since the route was
scored, especially under Company-coordinated dispatch) and skips the trade
entirely if it no longer clears the bar. On success it pays upfront (cargo
+ first-leg fuel + fixed fee), calls `originMarket.applyTrade(quantity)`
(physically depleting the Location's stockpile), nudges the origin
Market's price via `applyPriceImpact` (below), and stores the remaining
multi-hop path so the Transport keeps following it leg by leg.

**Repositioning.** If nothing at the current location clears the bar,
`considerRepositioning` scans the *entire* network for the single best
`(commodity, origin, destination)` opportunity anywhere else. If sailing
there empty (burning reposition-rate fuel, no cargo) and then executing
that trade would still clear a bar -- with the extra travel time and fuel
folded in -- the agent departs empty toward that origin. Since this is a
speculative bet on an opportunity that might not survive the extra transit
time, the bar for repositioning is stiffer: `minDailyReturnPct *
repositionReturnMultiplier`.

**Price impact.** A Captain is mostly a price-taker but its own trades also
nudge the Market price a little: `applyPriceImpact` moves `market.price` by
`priceImpact * units / (units + 50)`, up when buying, down when selling --
a no-op for the fixed-price Fuel market. This composes with, but is
entirely separate from, the stockpile-deviation formula that sets the
*baseline* price each day (§3.2).

### 6.3 Crew wages and `Inactive` transports

`dailyCrewCost` sums `dailyWages` across everyone crewing the Transport
(the Captain included). It's charged every day the Transport is
`InTransit`, on top of fuel/fixed fees, and is factored into
`routeEconomics`'s profitability math. If a Faction can't afford a given
day's wages while a Transport is underway, the crew simply stops working:
`status` flips to `"Inactive"` (no fuel burn, no travel progress) and it's
automatically excluded from `Company`/`PirateBrigade` fleet coordination
(`isIdleInPort` only returns `true` for `"AtLocation"`) until it can afford
to pay again.

### 6.4 Portfolio tracking

`recordPortfolioSnapshot` (called once per Captain per day by `World`)
marks its net worth to market: cash on hand plus cargo value, valued at
either the current location (if in port) or the destination's current
price (if mid-voyage), falling back to cost if no sell Market exists to
mark against. **Contract-bound cargo is excluded from this valuation
entirely** -- it was paid for by the issuing Location, not this Captain's
Company (see §9), so it's never this Captain's asset. `Faction.netWorth`
applies the same exclusion at the fleet level.

## 7. The event system

`events.ts` defines a shared abstract `Event` base class and four concrete
kinds, all logged into `World.eventLog` (a flat, chronological list of
every real `Event` ever generated, of any kind) so a single caller (a chart
panel, the events table) gets one unified feed instead of stitching several
formats together.

Every `Event` carries:

| Field | Meaning |
| --- | --- |
| `type` | Category: `"Local"`/`"Global"`/`"Location"`/`"Worldwide"` (MarketEvent flavors), `"Agent"` (TransportEvent), `"Company"` (CompanyEvent), `"Closure"` (LocationClosure) |
| `scope` | How broadly it applies: a Location's name for anything tied to one location (Local, Location-wide, or a Closure); `"Global"` for anything with no single-location focus; `"Transport"` for a TransportEvent; `"Company"` for a CompanyEvent |
| `subject` | The specific thing it's about: a commodity name for a MarketEvent (blank for Location-wide/Worldwide), a Captain's name for a TransportEvent, a Company's name for a CompanyEvent, or a Location's name for a LocationClosure |
| `day` / `duration` / `daysRemaining` | When it started, how long it lasts, and how much is left -- `tick()` advances one day and returns whether it's still active |
| `message` | Human-readable description (the template's `name`) |

### 7.1 `MarketEvent` -- demand/supply shocks

Temporarily multiplies a commodity's `demandMultiplier`/`supplyMultiplier`
for `durationDays`. If `location` is set, it's **Local** (one Market at one
location); if `null`, it's either **Global** (one commodity, every location
that trades it) or **Worldwide** (every market everywhere) -- `World`
disambiguates and stamps the real `type` after construction.

Four independently-probabilistic scopes, forming a scope-x-specificity
matrix:

|  | one commodity | every commodity |
| --- | --- | --- |
| **one location** | `Commodity.eventTemplates` (Local, rolled per-`Market` via `eventProbability`) | `LOCATION_EVENT_TEMPLATES` (Location-wide, `locationEventProbability`) |
| **every location** | `Commodity.eventTemplates` (Global, `globalEventProbability`) | `WORLD_EVENT_TEMPLATES` (Worldwide, `worldwideEventProbability`) |

`Commodity.eventTemplates` (`commodity.ts`) is commodity-specific: Crude
Oil, Copper, Wheat, and Gold have fully bespoke template lists
(`BESPOKE_EVENT_TEMPLATES`); Silver, Natural Gas, Coffee, Cotton, Iron Ore,
and Aluminum use `makeCommodityEvents` with hand-picked driver phrases
(`GENERATED_EVENT_DRIVERS`) to generate a standard boom/disruption/
glut/slump four-pack; anything else gets the same four-pack generated from
fully generic driver phrases (`GENERIC_EVENT_DRIVERS`). Both `Market.maybeTriggerLocalEvent`
and `World`'s global-event trigger look up `COMMODITIES[commodity]` and
skip the roll entirely (rather than throwing) if that commodity has no
registered `Commodity` or no `eventTemplates`.

A Global or Worldwide event applies a **separate `MarketEvent` copy** to
every affected Market (so each one ticks its own copy down independently),
plus a `trackingEvent` `World` keeps its own bookkeeping for
(`activeBroadEvents`, ticked daily and pruned on expiry; `broadEventLog`,
kept forever including finished ones).

### 7.2 `TransportEvent` -- per-agent shocks

Hits one specific Transport rather than any market; doesn't move prices,
changes what the Transport can do (`AGENT_EVENT_TEMPLATES`):

| Template | Kind | Magnitude | Duration |
| --- | --- | --- | --- |
| Engine trouble slows the transport | `delay` | 2 days | 1 |
| Customs hold at the dock | `delay` | 1 day | 1 |
| Cargo spoilage in transit | `cargo_loss` | 15% | 1 |
| Piracy incident | `cargo_loss` | 40% | 1 |
| Insurance payout received | `cash_gain` | $400 | 1 |
| Unexpected repair bill | `cash_loss` | $250 | 1 |
| Favorable tailwinds improve fuel efficiency | `fuel_discount` | 25% | 6 |
| Preferred customer rate at the port | `fixed_cost_discount` | 50% | 8 |

`"delay"` adds `magnitude` days to the current voyage (if in transit) or to
time stuck at the dock (if in port). `"cargo_loss"` loses `magnitude` (a
fraction) of cargo currently held -- only rolled if there's cargo to lose.
`"cash_gain"`/`"cash_loss"` are a one-off dollar amount. `"fuel_discount"`/
`"fixed_cost_discount"` cut fuel consumption or the flat per-voyage fee by
`magnitude` for `durationDays`; these two persist in `Captain.activeAgentEvents`
and tick down like a Market's active events, capped at 90% total discount
across stacked events of the same kind (`activeDiscount`).

### 7.3 `CompanyEvent` -- whole-Company cash shocks

A random windfall or setback that moves a whole `Company`'s shared cash
pool directly. `kind` is `"cash_gain"` (added) or `"cash_loss"` (subtracted,
floored at 0). Rolled by `World` independently, once per plain `Company`
per day, at `companyEventProbability` (default 0.005). This uses an
*exact*-type check (`Object.getPrototypeOf(faction) === Company.prototype`),
not `instanceof`, since `SoloTrader` is a `Company` subclass but doesn't
pool cash (there's no single shared balance for a CompanyEvent to move),
and `PirateBrigade`/`PoliceFleet` aren't `Company` at all.
`COMPANY_EVENT_TEMPLATES` supplies six one-off ($2,500-$6,000) events:
insurance settlements, favorable financing, and government subsidies for
gains; regulatory fines, tax audits, and embezzlement scandals for losses.

### 7.4 `LocationClosure` -- whole-port shutdowns

A binary shock distinct from every demand/supply-multiplier event above:
while active, a location's port is simply **closed** -- no buying, selling,
or refueling there at all, for anyone, until it reopens (`World.closedLocations`
tracks these directly; `Market.simulateDay`/`Captain.act` consult
`isLocationOpen`/`closedLocations` rather than this going through the
`MarketEvent` multiplier system). Ships already docked wait it out; ships
en route still arrive but can't unload until it reopens. `LOCATION_CLOSURE_TEMPLATES`
supplies five reasons (quarantine, war, blockade, strike, storm damage),
4-10 days each.

Production and consumption (`Location.dailyUpdate`) are **not** gated by
closure -- they keep happening regardless of whether the port can currently
load or unload anyone; only actual trading is blocked.

## 8. Faction hierarchy: ownership, pooling, and coordination

`Faction` (`faction.ts`) is the base ownership/bookkeeping layer: who
belongs to a fleet, how much money the group collectively holds (`cash`, a
single shared pool every member Transport's `cash` property reads/writes
through -- see `Captain.cash`), and combined net worth/profit. On its own it
does nothing active: its ships plan and execute trades entirely
autonomously, exactly as if unowned (`directFleet` returns an empty `Map`,
which `World.runDay` treats the same as "no directives at all").

`poolsCash` is a getter (not a plain field) controlling whether captains
share one balance or each keep their own private balance. It's `true` by
default (`Faction`, `Company`) and overridden `false` on `SoloTrader` and
`PirateBrigade`. (It's a getter rather than a class field specifically so a
subclass override is visible during the base constructor's own body --
`Faction`'s constructor reads `this.poolsCash` while running, and a plain
overridden field wouldn't be initialized on the subclass instance yet at
that point.)

`Faction`'s constructor takes `(Transport, Captain, homeLocation)` triples
-- callers build each Captain themselves (full control over strategy
parameters); `Faction` just wires `captain.transport`/`captain.location`
and pads out each Transport's `crew` roster with `Sailor`s up to its
`crewRequirement`.

### 8.1 `Company` -- active coordinated routing and Contract dispatch

`Company extends ContractFulfiller extends Faction` (§9): `ContractFulfiller`
is a thin layer inserted into the chain purely to give `Company` (and any
future fulfiller) the shared `contractTypes`/`contracts`/`availableContracts`/
`acceptContract`/`pruneFulfilled` machinery, without giving up anything
`Faction` already provides (`cash`, `captains`, `poolsCash`, ...). `Company`
adds coordinated routing and Contract dispatch on top:

**Coordinated arbitrage routing** (`directFleet`, called once per day by
`World.runDay`): every currently idle Transport not otherwise assigned
(`isIdleInPort`) has its best local route scored exactly as it would score
its own, and routes are assigned in descending order of daily return.
Multiple ships *can* share the same `(commodity, destination)` route --
capped by how much of the destination's still-open deficit
(`remainingDemand`) is uncovered, so fleet coordination scales shipping
with actual demand rather than piling everyone onto one route or capping
every route at exactly one ship; the first ship onto a route with no
measurable deficit (e.g. a fuel depot) is still let through. A second ship
that would claim an already-full route is offered its next-best *different*
option instead (`excludeRoutes`). Since every Transport's `cash` *is* the
shared pool, sizing a trade already naturally accounts for the fleet's
entire cash position -- no separate transfer step needed. Repositioning
(§6.2) stays autonomous per-Transport even for Company-owned ships, since
it's already a network-wide search.

**Contract dispatch** is controlled per-Company by `contractStrategy`
(`ContractStrategy`, default `"compare"`) -- a plain instance field, not
shared state, so different `Company`s could in principle run different
strategies at once (`buildWorld` currently starts every `Company` at the
same default; the UI's dropdown pushes one choice onto all of them at
once). Both branches read the `BulletinBoard` `World.runDay` passes into
`directFleet` via `ContractFulfiller.availableContracts(board)` -- postings
filtered to `this.contractTypes` (`Company`'s own `contractTypes =
["Commodity"]`), which by construction never includes anything already
accepted (§9):

- **`"compare"`** (default): `serviceContractsByProfit` weighs each
  candidate Contract (this Company's own unfulfilled `contracts`, plus
  whatever `availableContracts(board)` currently offers) against the ship's
  own best arbitrage route, both expressed as expected profit per ship-day
  (`Captain.estimateContractProfitPerDay` vs. `findBestLocalRoute`'s
  `expectedProfit / travelDays`), and takes whichever pays more. Only the
  costs the Company actually bears count toward a Contract's profit -- crew
  wages over the trip, plus reposition fuel if the ship must first sail
  empty to the producer -- since the goods and delivery-leg fuel are
  paid/reimbursed by the issuing Location (§9). A still-open posting is
  accepted (`acceptContract`, which removes it from the board) only at the
  moment some ship actually commits to it, so a Contract no Company ever
  finds worth taking stays on the board for another Company, or
  expires/re-tenders normally, rather than being hoarded unserviced.
- **`"prioritise"`**: `claimOpenContracts` + `serviceContracts` -- accept
  every available Contract first (capped at roughly one contract's worth of
  capacity per ship, `contracts.length < captains.length`, so one Company
  can't monopolize every posting), then arbitrage with whatever ships are
  left over, regardless of how each Contract's payoff compares to
  arbitrage. Prefers a captain already sitting at a valid producer
  (immediate `CONTRACT_DELIVER`); otherwise repositions the nearest
  available idle captain toward the nearest producer that could actually
  supply enough of the Contract's quantity (ranked by deliverable amount,
  then distance), to be handed the delivery once it arrives.

Both strategies were validated against the stockpile-vs-minimum ratio
metric before `"compare"` became the default -- see `Simulation.md`'s
Finding 8; it holds the ratio at least as well as `"prioritise"` while
avoiding diverting a ship onto a marginal Contract when clearly better
arbitrage is available.

`SoloTrader` is a `Company` subclass with `poolsCash = false`: same
coordinated dispatch, but each captain keeps their own private balance --
modeling a loose association of independent operators sharing dispatch
without sharing capital. It also overrides `contractTypes` to an empty
array -- `availableContracts` then always returns nothing, so a
`SoloTrader` never accepts a posting regardless of what's on the board
(§9).

### 8.2 `PirateBrigade` -- raiding

`directFleet` moves every idle pirate Transport toward wherever watched
Company Transports are currently most concentrated (re-scanned every
`laziness` days, not necessarily daily). If an idle pirate finds itself
sharing a location with a watched Company Transport, it attacks instead of
repositioning -- provided its own `carousing` (shore-leave distraction,
below) isn't over `maxCarousingToAttack` and no watched `PoliceFleet` has a
Ship at that same location.

`attack` steals `raidFraction` of the victim's *own* cash -- but only if
the victim's Company doesn't pool cash (a pooling Company's shared purse is
untouchable; only `SoloTrader` or similar non-pooling victims lose cash
directly). If the victim carries cargo, the pirate seizes and fences all of
it at the current location's live sell price times that Location's own
`fenceFraction` (a black-market discount). Logged in the pirate's own
`tradeLog` (`action: "ATTACK"`) and the victim's `agentEventLog`
(`kind: "cash_loss"`) -- not as a structured `Event`, so `EventsPanel`
deliberately doesn't show this activity.

**Carousing.** Every pirate Ship sitting `AtLocation` spends
`carousingCostPerCrew` per crew member on shore leave each day, if
affordable; `carousing` then rises by `carousingIncreaseByDay`. If that
pushes it over `maxCarousing`, the crew blacks out: `carousing` resets to 0
and the Captain is grounded for a day.

A `PirateBrigade` can only crew `Ship`s (the constructor throws, naming any
non-Ship Transport in its roster).

### 8.3 `PoliceFleet` -- passive law enforcement

Currently pure random-wandering patrol: every idle Ship moves to a
uniformly random, open, reachable location every `patrolIntervalDays`.
`targets` (the `PirateBrigade`s it watches) exists for a future smarter
`directFleet` -- today its only effect is deterring nearby pirate attacks.
Always pools cash into a literal `Infinity` pool (not caller-configurable).

`World`'s constructor auto-creates its own `PoliceFleet` ("Coast Guard")
watching every `PirateBrigade` in `factions`, sized by `numPoliceShips`
(default 3 if the `World` is built directly with no override).

**Neither `PirateBrigade` nor `PoliceFleet` is part of the world the app
actually ships**, though: `buildWorld()` only ever constructs `Company`/
`SoloTrader` factions and explicitly passes `numPoliceShips: 0` -- so the
shipped default world has no pirates and no police at all. Both classes
remain fully implemented and exercised directly by unit tests (see §12),
available for a future world-building path that wants raiding.

### 8.4 Nationalities and name generation (`nationality.ts`, `names.ts`, `shipNames.ts`, `companyNames.ts`)

Five nationalities -- English, French, Spanish, Dutch, Portuguese -- each
carry three name pools: captain names (`names.ts`, `randomName` drawing a male
first name `MALE_FIRST_NAME_FRACTION = 75%` of the time), ship names
(`shipNames.ts`), and chartered-company names (`companyNames.ts`, a
form-x-subject template like *"Real Compañía de Comercio de {subject}"*).
`nationality.ts`'s `NATIONALITY_POOLS: Record<Nationality, …>` maps each
nationality to its trio of pools, and `randomNationality(rng)` draws one at
random. A `PoliticalEntity` carries a `nationality` (§3.6); when a fleet is
synthesized for a loaded JSON world (§11.2), each generated ship/captain in a
Company draws from that Company's PoliticalEntity's nationality, and an
Independent faction from a seeded-random one. The procedural `buildWorld`
names its ships/captains from a single fixed pool and doesn't consult this
per-entity machinery.

## 9. Contracts: location-funded supply orders, the BulletinBoard, and issuer/fulfiller roles

`contracts.ts` implements a **Contract**: a one-shot supply order -- "deliver
`quantity` of `commodity`, once" -- of a given `type` (`ContractType`; only
`"Commodity"` exists today, the kind every `Location` issues). The issuing
Location pays for the goods directly (at the producer's live price,
straight out of its own `cash` pool) and reimburses the delivering
Company's fuel cost plus a fixed delivery fee on arrival -- the Company
never fronts the cost of the goods themselves, only fuel (§8.1's
`"compare"` mode leans on exactly this asymmetry to score a Contract's
profit).

**`BulletinBoard`** is a store for Contracts that haven't been accepted yet.
A `ContractIssuer` (§3.1's `Location`) posts to it via a protected
`postContract(board, contract)`; a `ContractFulfiller` (§8.1's `Company`)
reads it via `availableContracts(board)` (postings filtered to
`this.contractTypes`) and accepts one via `acceptContract(board, contract)`,
which **immediately removes it from the board** (`board.remove`), stamps
`contract.fulfiller = this`, and adds it to the fulfiller's own `contracts`
list. This is the load-bearing invariant the rest of the system leans on: a
posting is never simultaneously "on the board" and "accepted" -- so
`BulletinBoard.prune` (below) never has to consider a fulfilled or accepted
posting, and `availableContracts` never has to filter one out either.

`Location.tenderContracts(day, board, activeContractKeys, options)` is
called once per Location at the very start of each simulated day
(`World.runDay`, before any Faction acts), against whatever
`BulletinBoard.prune` left open. For every consumed commodity that
`needsContractRestock`, isn't already covered by an active contract
(`activeContractKeys`, a `Set` of `contractKey(location, commodity)`
strings `World` builds fresh each day -- see below), and while the
Location isn't broke (`cash <= 0`):

- **`quantity`** is `minStockpiles[commodity] * quantityMultiplier`
  (default `CONTRACT_QUANTITY_MULTIPLIER = 1.5`).
- **`deliveryFee`** is `quantity * basePrice * baseFeeRate` (default
  `CONTRACT_BASE_FEE_RATE = 0.05`), scaled up by an exponential urgency
  curve based on how far *below* the minimum the current stockpile actually
  is: flat `baseFeeRate` anywhere in the proactive 100%-150% zone, ramping
  toward `baseFeeRate * feeEscalationBase` (default `CONTRACT_FEE_ESCALATION_BASE
  = 10`) as stock approaches zero.
- **`expiryDay`** is `day + expiryDays` (default `DEFAULT_CONTRACT_EXPIRY_DAYS
  = 7`).

The contract is then posted via the inherited `postContract` (`type:
"Commodity"`, `fulfiller: null`).

**Why `activeContractKeys` exists.** Since the board only holds unaccepted
postings, a Location can't tell "is this pair already covered" from the
board alone -- an already-accepted-but-undelivered contract for that same
`(location, commodity)` pair has left the board entirely. `World.runDay`
builds this key set fresh each day, right after `bulletinBoard.prune(...)`
and before the tender loop, as the union of every current board posting's
key and every `ContractFulfiller`'s own **unfulfilled** `contracts`' keys
(`f.contracts.filter(c => !c.fulfilled)` -- a fulfiller only prunes its own
fulfilled contracts lazily inside its *next* `directFleet` call, which runs
*after* this same day's tender loop, so a just-fulfilled contract must be
explicitly excluded here or it would wrongly block re-tendering for one
extra day).

`BulletinBoard.prune(locations, day, severeDeficitFraction)` drops expired
postings and postings whose Location has fallen to `severeDeficitFraction`
(default `DEFAULT_SEVERE_DEFICIT_FRACTION = 0.5`) of its minimum stockpile
-- removed immediately rather than waiting on expiry, since the tender loop
(called right after, same pass) replaces it with a fresh, more
urgently-priced offer. Unlike the shape this pruning might take on an
unsplit collection, it never needs to check "is this fulfilled" or "is this
already accepted" -- neither state can exist on a posting still sitting on
the board, by the accept-removes-immediately invariant above.

`Captain.executeContractDelivery` buys at the producer and departs toward
the Contract's Location with the cargo marked `contract`-bound; there's no
profitability gate (unlike an ordinary arbitrage trade) in `"prioritise"`
mode, since an accepted Contract there is an obligation already committed
to -- `"compare"` mode instead gates the *choice* to accept the Contract in
the first place, at `Company.directFleet` time (§8.1). Quantity is bounded
by the issuing Location's own cash (the goods payer) and the Company's cash
covering fuel alone, not by the Company affording the goods themselves.
`Captain.fulfillContract` pays out on arrival: fuel cost already fronted is
reimbursed, plus the fixed `deliveryFee`, both paid by the issuing
Location -- unlike an ordinary `SELL`, the price has nothing to do with the
destination market's price, and delivering the stock still moves the
market (`applyTrade`) but not the price the way a priced trade's
`applyPriceImpact` would.

## 10. `World`: orchestration and the daily loop

`World`'s constructor validates `locations.length` against `[MIN_LOCATIONS,
MAX_LOCATIONS] = [20, 50]` (throws otherwise -- calibrated in
`Simulation.md`, since fewer locations make the stockpile-ratio target
structurally unreachable regardless of fleet size), builds one `Market` per
`(location, commodity, side)` combination plus the unconditional Fuel
market (§3.3-3.4), primes the pathfinding cache (§4.3), auto-creates the
`PoliceFleet` (§8.3) if `numPoliceShips > 0`, and flattens every Captain
(independent traders plus every Faction's fleet) into `captains`.

Six independent, per-day probabilistic event schedulers are configured at
construction (`World`'s own fallback defaults in parentheses; `buildWorld.ts`
passes these explicit values, which agree except where noted):

- `globalEventProbability` (0.006) -- Global MarketEvent
- `localEventProbability` (0.008) -- per-Market Local MarketEvent, passed
  through to each `Market`
- `locationEventProbability` (0.004) -- Location-wide MarketEvent
- `worldwideEventProbability` (0.002) -- Worldwide MarketEvent
- `locationClosureProbability` (`World`'s own default 0.001; `buildWorld.ts`
  passes **0.0015**) -- LocationClosure
- `companyEventProbability` (0.005) -- CompanyEvent, rolled independently
  per plain `Company`

### 10.1 `runDay(day, commoditiesPresent)` order of operations

1. **Prune and tender Contracts** -- `bulletinBoard.prune(...)` against
   yesterday's closing stockpile levels, then every Location's own
   `tenderContracts(...)` (against a freshly-built `activeContractKeys` set
   spanning the board and every fulfiller's unfulfilled contracts), before
   any Faction acts, so Factions see today's fresh postings and never a
   stale/expired one (§9).
2. **Tick location closures** -- reopen anything whose duration expired,
   before anyone acts today.
3. **Tick broad (Global/Location/Worldwide) MarketEvents** down a day.
4. **Maybe trigger a new location closure.**
5. **Maybe trigger CompanyEvents** -- independently per plain Company.
6. **Faction direction**: call `directFleet()` on every Faction, passing the
   shared `bulletinBoard` (a plain `Faction` just returns an empty `Map`,
   which falls through to autonomous behavior); merge every returned
   directive into `directedRoutes`.
7. **Agent action loop**: `agentOrderFn(captains, day)` decides today's
   acting order (default: fresh shuffle); each Captain's `act()` is called
   with `directedRoutes.get(trader)`. Every event a Captain logged today is
   pulled into `World.eventLog`.
8. **Maybe trigger a Global MarketEvent, a Location-wide one, then a
   Worldwide one** (each independently probabilistic).
9. **Apply one day of production/consumption** to every Location
   (`location.dailyUpdate()`) -- unconditionally, even for a closed
   location.
10. **Clear every Market** (`market.simulateDay`) -- this is where each
    `(location, commodity, side)`'s price for the day actually updates, and
    where the Local per-Market MarketEvent scope rolls.
11. **Record every Captain's portfolio snapshot**, then every Faction's net
    worth snapshot, for the day.

Step 7 (agents act) happens *before* steps 9/10 (stockpiles update, prices
clear) -- so every day, agents make their buy/sell decisions against
**yesterday's closing price**, and the market moves in response to both
today's production/consumption *and* whatever they just traded, ready for
tomorrow.

`World.run(numDays)` calls `runDay` in a loop; `World.step()` is the same
thing one day at a time, tracking its own internal day counter -- used by
the live UI (`useSimStore`'s `step`/`tick`) so it isn't committed to a fixed
`run(numDays)` up front.

There is no built-in report-building surface on `World` (no CSV/console/
JSON export methods) -- `combinedHistory`, `eventLog`, `activeNamedEvents()`,
and a computed `contracts` getter (every board posting plus every
`ContractFulfiller`'s accepted contracts, unioned fresh on each read -- see
§9) are the whole reporting API, and every React panel (§13) reads
structured data straight off `World`/`Captain`/`Location`/`Market`/
`Contract` objects rather than a pre-built report shape.

## 11. Building a world

A world is built one of two ways: the procedural default (§11.1) or an
editor-authored JSON document loaded and fleshed out at load time (§11.2).

### 11.1 Procedural default (`buildWorld.ts`)

`buildWorld(maxRouteDistance = 3000, options: BuildWorldOptions = {})`
assembles a full `World` plus its Factions, procedurally, without running
any days:

```ts
buildWorld(3000, {
  seed: 42,                                      // World's own stochastic stream (events, closures, noise, act-order)
  targetShipsPerLocation: 5,                     // total fleet ~ locations.length * this
  shipsPerCompany: 5,                            // ships grouped into each Company
  arbitrageShipFraction: 0.2,                    // extra ships per Company on top of shipsPerCompany
  companyFraction: 0.35,                         // Company count as a fraction of locations.length (§8.1)
  contractOptions: { quantityMultiplier: 1.5 },  // forwarded to World -> each Location's tenderContracts
  locationNames: [...],                          // location roster (default: 30 hubs + 3 fuel depots)
  commodities: buildCommodities([...], {...}),   // commodity roster (default: the 10 built-in commodities)
  commodityCountRange: [2, 4],                   // per-location produced/consumed spread
  minStockpileDays: 14,                          // days-of-consumption buffer minStockpile represents
  consumedStockpileFactor: 2.0,                  // starting stockpile, as a multiple of minStockpile
  locationsPerPoliticalEntity: 5,                 // target Locations grouped into each PoliticalEntity (§3.6)
});
```

Omitting `options` entirely reproduces the default world byte-for-byte.
Every knob above is the whole procedural customization surface; the only
non-procedural way to build a world is an editor-authored JSON (§11.2).

For the default world: 33 locations (30 hubs + 3 fuel depots) at 5
ships/location targets a 165-ship fleet; `shipsPerCompany` (5) plus the 20%
arbitrage buffer (`ceil(5 * 0.2) = 1` extra) makes each Company's actual
fleet 6 ships, so `numCompanies = round(165 / 5) = 33` and the real fleet
is `33 * 6 = 198` ships. Companies alternate `Company`/`SoloTrader` by
index parity (`Company 001`, `Solo 002`, `Company 003`, ...) -- 17
`Company`s and 16 `SoloTrader`s. Each starts with `10,000 * 6 = 60,000`
cash. Fleet composition (home ports, ship class, crew size, Captain names)
is drawn from a dedicated `Rng(99)` stream, independent of both the
geography seed (`WORLD_GEN_SEED`) and `World`'s own seed -- three
independent streams total. `numPoliceShips: 0` is passed explicitly, and no
`PirateBrigade` is ever constructed (§8.2-8.3).

`shipsPerCompany`/`arbitrageShipFraction`/the 5-ships/location ratio were
calibrated via seed-averaged sweeps against the stockpile-vs-minimum ratio
target -- see `Simulation.md` for the full tuning history, and never retune
off a single run (the metric carries meaningful Monte-Carlo noise; `npm run
sweep` exists specifically to average it out over many seeds).

### 11.2 From editor JSON (`buildWorldFromJson.ts`)

The **World editor** (`editor/`, a separate Vite + React app -- see §17)
lets you author a world visually and export it as a single JSON document:
world scale, distance mode/radius/lon-span, PoliticalEntities (each with a
`nationality`), Locations (world coordinates, terminals, produce/consume
maps), Commodities, Companies (name, starting funds, affiliation, and a fleet
of transport/captain pairs), and Routes (with control points). `parseWorldJson`
on the editor side and `buildWorldFromJson` on the sim side are the two ends
of that pipe. `buildWorldFromJson`:

1. Registers the authored commodity roster, builds the Locations and their
   coordinate map (`setGeography`), then installs the world's distance mode
   (`setDistanceConfig`, §4.2) **before** building Routes -- since each Route
   measures its length under the active mode at construction.
2. Builds the Route network with `addRouteToNetwork`, so a pair authored with
   several routes of different types keeps them all (§4.1).
3. Groups Locations into PoliticalEntities (carrying each entity's
   `nationality`), and builds the authored Companies/SoloTraders, wiring each
   faction's `politicalEntity` affiliation.
4. **Synthesizes a fleet** up to the required ship count (below).
5. Assembles the `World` (with `numPirateShips: 0`, `numPoliceShips: 0`).

**Fleet synthesis.** An authored world usually defines only a handful of
ships, far short of a healthy economy. So after building the authored
factions, the loader sizes the fleet up to `required = round(locations.length
* DEFAULT_TARGET_SHIPS_PER_LOCATION)` (the same calibrated 5-ships/location
minimum §11.1 targets). If the world already has at least `required` ships,
nothing is added. Otherwise, with `remainder = required - existingShips`:

- `newSolo = min(remainder, round(0.2 * required))` new **Independent
  SoloTraders** (1 ship each) are created -- so about 20% of the required
  fleet is SoloTraders.
- The rest (`remainder - newSolo`) is distributed **round-robin across the
  companies defined in the JSON** (bulking up even a 1-ship company into a
  multi-ship `Company`, topping up its cash by `$10,000` per ship). Only if
  the JSON defines *no* companies at all do those ships become SoloTraders
  too.

Generated ships and captains draw their names from the owning Company's
PoliticalEntity **nationality** (§8.4) -- or, for an Independent faction, a
seeded-random nationality drawn once per faction. All synthesis runs off a
fixed seed (`Rng(4242)`), so a given World JSON always yields the same
made-up fleet. Synthesized ships are sea `Ship`s (matching §11.1's merchant
default); in a non-sea authored world they can't use any route and simply
idle.

## 12. Tests

`src/sim/__tests__/engine.test.ts` and `contracts.test.ts` exercise the
engine directly, mostly against real objects rather than mocks:

- **`buildWorld`**: the default procedural world runs 60 days without
  throwing; two runs built from the same seeds produce byte-identical
  day-60 net worth and prices (determinism); `step()` matches `run(1)`'s
  effect on the day counter.
- **Validation guards**: `Location` throws on a produced/consumed overlap
  or an illegally-combined `Platform` terminal; `World` throws outside
  `[20, 50]` locations; `buildCommodities` throws outside `[5, 25]`
  commodities; `generateLocations` throws outside `[2, 6]` per-location
  commodity spread -- each checked at and just outside its boundary.
  (This is testing the invariants directly, not resweeping the metric that
  motivated them; see `Simulation.md`.)
- **Faction cash pooling**: `Company` pools cash across every captain
  (spending through one captain is visible on another's balance);
  `SoloTrader` keeps independent balances; `PirateBrigade` rejects a
  non-Ship Transport in its roster and accepts an all-Ship one.
- **`Location.tenderContracts`**: sizing (`quantityMultiplier`), the
  urgency fee curve, the proactive-threshold trigger (and a per-Location
  `contractThresholdFraction` override), broke-Location suppression, and
  dedup against `activeContractKeys` -- both for a pair already open on the
  board and for a pair whose existing contract has already been accepted
  elsewhere (so it isn't on any board at all).
- **`BulletinBoard.prune`**: expiry and severe-deficit removal of unclaimed
  postings (fulfilled/accepted postings are structurally impossible on a
  board, so there's nothing to test there -- see §9).
- **`ContractFulfiller.pruneFulfilled`**: exercised indirectly through
  `Company.directFleet`, since the method itself is protected -- a
  fulfilled contract sitting in a Company's own `contracts` is dropped on
  the next servicing pass.
- **`serviceContracts`/`serviceContractsByProfit` producer selection**:
  repositioning toward a farther-but-better-stocked producer over a
  nearer-but-thin one when only the farther one can fully supply the
  Contract; preferring the nearer producer when both can. Two dedicated
  tests pin `contractStrategy = "prioritise"` explicitly, since they
  exercise that mode's specific servicing/producer-ranking logic
  (`bestProducer`, `"compare"`'s equivalent, is exercised by its own tests).
- **Contract-strategy toggle**: `"prioritise"` services a due Contract even
  when arbitrage would pay more (and accepts it eagerly, with no market
  data at all, since the issuing Location -- not the Company -- pays for
  the goods); `"compare"` takes the better-paying arbitrage over a
  low-fee Contract (leaving it on the board for another Company), and still
  services a Contract that clearly out-earns arbitrage (accepting it only
  at the moment a ship commits, removing it from the board at that point).
- **`SoloTrader` never accepts a Contract**: an empty `contractTypes` means
  `availableContracts` always returns nothing, so a posting stays on the
  board and unaccepted no matter how lucrative.
- **Contract system integration**: over a 60-day run, no unclaimed Contract
  is ever seen past its own expiry day, and at least one Location's `cash`
  has moved from its untouched default -- proving trades are actually
  tracked against it.

`src/sim/analysis.harness.ts` is a separate, non-default seed-averaging
sweep harness (`npm run sweep`, its own `vitest.sweep.config.ts`) for
retuning the fleet-size/stockpile-ratio calibration -- not part of `npm
test`'s discovery.

## 13. The web UI (`src/`)

`src/main.tsx` mounts `App` (`src/App.tsx`), which renders a fixed panel
list:

```
ControlsPanel
NetworkView
EventsPanel
StockHistoryPanel
PriceHistoryPanel
NetWorthHistoryPanel
LocationsPanel  |  FleetPanel  |  ContractsPanel   (side by side)
```

**State (`src/state/`).** `useSimStore.ts` is a Zustand store wrapping a
live `World` + its Factions with play/pause/step/reset controls, plus a
`contractStrategy` field that's pushed onto every `Company` via
`applyContractStrategy` whenever it changes (and reapplied on `reset`).
`World`/`Captain`/`Location` mutate in place -- the engine keeps a
mutation-based model, not immutable updates -- so the store also tracks a
bare `version` counter bumped on every `step()`; components subscribe to
`version` to know when to re-render, then read live fields straight off
`world`/`captain` objects. `useSimLoop.ts` drives `useSimStore.tick(dt)` off
`requestAnimationFrame`, auto-stepping at `secondsPerDay` while `playing`.

**Panels (`src/components/`):**

- **`ControlsPanel`** -- play/pause/step/reset, a speed slider
  (`secondsPerDay`), the Contracts strategy dropdown (`"compare"` /
  `"prioritise"`, §8.1), and faction/trader/location counts.
- **`NetworkView`** -- a canvas-drawn map of the location/route network:
  routes colored by `RouteType` (Sea/Land/Air), locations as circles
  (diamonds for fuel depots), and Transport markers ringed around whichever
  location they currently occupy -- colored by transport kind (Ship/Train/
  Plane, matching the route-type palette) and underlined when actually
  docked (not in transit). Hovering a Transport marker shows a tooltip
  (name, kind, Company, status/destination, cargo, cash).
- **`EventsPanel`** -- every `Event` in `World.eventLog`, sorted
  newest-first, with Day/Type/Scope/Subject/Message/Duration columns; rows
  outside their own `[day, day + duration)` window are dimmed. Deliberately
  shows only structured `Event` objects -- trade activity (`BUY`/`SELL`/
  `REFUEL`/`ATTACK`/`REPOSITION`, from `Captain.tradeLog`) isn't a
  structured `Event` and isn't shown here.
- **`StockHistoryPanel`** -- pick a Location + one of its commodities, plot
  `stockpile` (and, for a consumed commodity, its dashed `referenceStockpile`
  / minimum-target line) over time, with an event-marker lane overlaying
  every relevant `Local`/`Location`/`Global`/`Worldwide`/`Closure` event for
  that exact `(location, commodity)` pair (`relevantEvents`, `eventOverlay.ts`).
- **`PriceHistoryPanel`** -- pick a commodity plus an independent buy
  location (where it's produced) and sell location (where it's consumed),
  and plot both markets' price history on one chart, with the same
  event-marker lane logic applied to each side.
- **`NetWorthHistoryPanel`** -- one line per `Company`/`SoloTrader` (not
  `PirateBrigade`/`PoliceFleet`, since neither exists in the shipped
  default world -- §8.2-8.3), colored by faction type (`Company` blue,
  `SoloTrader` orange -- a validated, colorblind-safe categorical pair) with
  a per-type visibility filter and a shared crosshair/tooltip that
  highlights whichever line is nearest the cursor.
- **`LocationsPanel`** -- one row per Location: cash (or "broke"), and its
  produced/consumed commodities with live stock, rate, and price.
- **`FleetPanel`** -- one row per Captain: ship, Faction (or
  "(independent)"), location, destination, days remaining of transit,
  status, cash, net worth.
- **`ContractsPanel`** -- one row per open/accepted Contract (`World.contracts`):
  location, commodity, type, quantity, delivery fee, accepting Company (or
  "unclaimed"), tendered/expiry days, the in-flight Captain (if any) and
  their transit window, and a derived status (`unclaimed` / `awaiting
  captain` / `in transit`).

None of these panels parse text or use regular expressions to derive what
to show -- every one reads structured data straight off `World`/`Captain`/
`Location`/`Market`/`Contract`/`Event` objects.

**Theming.** `src/index.css` defines the app's whole color system as CSS
custom properties, both a light default and a `prefers-color-scheme: dark`
override: chrome colors (`--text`, `--panel-bg`, `--border`, ...), a
role-based pair for stock/price charts (`--accent` for produced/buy,
`--consumed` for consumed/sell), a five-slot categorical palette for event
markers (`--event-local`/`--event-location`/`--event-global`/
`--event-worldwide`/`--event-closure`), and a two-slot categorical pair for
faction type (`--faction-company`/`--faction-solo`). The event and faction
palettes were chosen and validated for colorblind-safety against this
app's own panel surfaces.

## 14. Reproducibility and randomness

The simulation deliberately uses **multiple independent `Rng` streams**, so
that changing one part of the world never perturbs another:

- `generateLocations` -- `WORLD_GEN_SEED` (2024)
- `generateCoordinates` -- `WORLD_GEN_SEED + 1`
- `generateRoutes` -- `WORLD_GEN_SEED + 2`
- `buildWorld`'s fleet composition (home ports, ship class, crew size,
  Captain names) -- a fixed `Rng(99)`
- The simulation's own trading/event randomness -- `simRandom.ts`'s shared
  stream, reseeded via `seedSimRandom(seed)` in `World`'s constructor if a
  `seed` is given (`buildWorld`'s default is 42)

This is why the network (which locations exist, where they sit, which
routes connect them, what each produces/consumes) and the fleet's shape are
identical run to run regardless of the `World`'s own `seed`, while trading
behavior, event rolls, and agent outcomes vary with that seed.

## 15. Where to extend things

- **New commodity**: add its name/base price to `buildCommodities(...)`'s
  call in `worldData.ts`, and optionally a bespoke entry in
  `commodity.ts`'s `PRICE_SENSITIVITY`/`DEFICIT_PRICE_BOOST`/
  `EXCESS_PRICE_BOOST`/`BESPOKE_EVENT_TEMPLATES`/`GENERATED_EVENT_DRIVERS`
  -- or leave it out and let it fall back to the `DEFAULT_*` constants and
  a generic-driver event four-pack.
- **New pricing behavior for a specific commodity**: tune that commodity's
  entry in `commodity.ts`'s tables rather than touching `Market.stockpilePrice`
  itself.
- **New Transport type**: subclass `Transport`, override
  `allowedRouteTypes()` if it's physically restricted, add it to
  `SHIP_CLASSES` if it's ship-like.
- **New Faction behavior**: subclass `Faction` and override `directFleet`
  -- `World.runDay` already treats an empty returned `Map` as "let this
  fleet act autonomously," so any subclass that supplies real directives is
  picked up automatically.
- **New event kind**: subclass `Event`, give the constructor a fixed
  `type`/`scope`, decide where `subject` gets stamped (at construction if
  known, or externally once tied to a specific entity -- see
  `TransportEvent`/`CompanyEvent`'s pattern), and wire a trigger into
  `World.runDay` (or `Market.simulateDay` for something finer-grained than
  per-day).
- **New contract-dispatch strategy**: add a new `ContractStrategy` variant,
  a corresponding private method beside `serviceContracts`/
  `serviceContractsByProfit` in `faction.ts`, and a branch in
  `Company.directFleet`.
- **New Contract type, issuer, or fulfiller**: add a new `ContractType`
  literal (`contracts.ts`); a new `ContractIssuer` subclass posts to a
  `BulletinBoard` via its inherited `postContract`, and a new
  `ContractFulfiller` subclass declares which `ContractTypes` it accepts via
  `contractTypes` and reads/accepts via the inherited `availableContracts`/
  `acceptContract` -- no changes needed to `BulletinBoard` itself or to any
  other issuer/fulfiller, since filtering is per-fulfiller.
- **New chart/panel**: read structured data straight off `World`/`Captain`/
  `Location`/`Market`/`Contract`/`Event` in a new `src/components/*.tsx`
  file and add it to `App.tsx`'s panel list -- no report-builder layer to
  extend on the engine side (§10).

## 16. Tuning reference: which variables change economic behavior

This is a pure parameter-tuning reference -- no code restructuring needed,
just editing the constants/defaults below. Current defaults noted in
parentheses. For anything that feeds the stockpile-vs-minimum ratio metric,
retune via seed-averaged sweeps (`npm run sweep`), never a single run --
see `Simulation.md`.

### 16.1 How sharply prices react to scarcity/surplus

- **`commodity.ts`'s `PRICE_SENSITIVITY`** (per-commodity, e.g. Crude Oil
  `0.6`, Gold `0.25`) / **`DEFAULT_PRICE_SENSITIVITY`** (`0.45`, the
  fallback for anything not listed) -- the core lever in
  `Market.stockpilePrice` (§3.2): how sharply a commodity's price moves per
  unit of deviation from its reference stockpile.
- **`DEFICIT_PRICE_BOOST`** (per-commodity, e.g. Coffee `2.0`, Gold `1.2`) /
  **`DEFAULT_DEFICIT_PRICE_BOOST`** (`1.4`) -- the consumer-side shortage
  boost (§3.2); **`EXCESS_PRICE_BOOST`** (empty by default -- falls back to
  each commodity's own deficit boost) / **`DEFAULT_EXCESS_PRICE_BOOST`**
  (`1.4`) -- the mirror producer-side surplus boost. Set an entry to `1.0`
  to make that side fully non-boosted (a flat symmetric formula).
- **Deviation clamp and price floor** -- hardcoded in `stockpilePrice` as
  `Math.max(-2, Math.min(2, ...))` and `Math.max(0.5, ...)`.
- **Daily price noise** -- `randGauss(0, 0.01)` in `Market.simulateDay`.
  Raise the SD for noisier day-to-day prices on top of the deterministic
  stockpile formula; `0` for a fully deterministic price given the same
  stockpile state.
- **Captain's own price impact** -- `Captain.priceImpact` (default `0.01`),
  used in `applyPriceImpact` (`magnitude = priceImpact * units / (units +
  50)`). `0.0` makes a Captain a pure price-taker with no footprint.

### 16.2 How big a stockpile locations start with, and how tight the buy/sell trigger is

All of the below live in `generateLocations` (`worldData.ts`) and only
affect the procedurally generated world.

- **Production/consumption rate range** -- `U(3, 15)` units/day for both
  produced and consumed commodities, before the world-wide balancing pass
  (§3.5).
- **`consumedStockpileFactor`** (default `DEFAULT_CONSUMED_STOCKPILE_FACTOR
  = 2.0`) -- a consumed commodity's starting stockpile as a straight
  multiple of its minimum.
- **`minStockpileDays`** (default `DEFAULT_MIN_STOCKPILE_DAYS = 14`) --
  days-of-consumption buffer `minStockpiles[c] = rate * minStockpileDays`
  represents. Raised from an earlier `7.5` specifically because a bigger
  buffer cuts real stockout frequency far more than it moves the aggregate
  ratio (`Simulation.md` Findings 6-7).
- **Produced-commodity starting stockpile** (its price reference) --
  `U(10, 25)` days of accumulated output.
- **Base price randomization** -- `U(0.85, 1.15)` applied to each
  commodity's `basePrice` when seeding a Location's own `basePrices`.
- **`commodityCountRange`** (default `[2, 4]`, bounded by
  `[MIN_COMMODITIES_PER_LOCATION, MAX_COMMODITIES_PER_LOCATION] = [2, 6]`)
  -- how many commodities each location deals in per role.
- **The commodity roster passed to `buildCommodities`** (bounded by
  `[MIN_COMMODITIES, MAX_COMMODITIES] = [5, 25]`) -- the actual reference
  price per commodity world-wide.

### 16.3 How often random shocks happen, and how big they are

All six probabilities below are `World` constructor options (§10);
`buildWorld.ts` passes them explicitly.

| Probability | `World` default | `buildWorld.ts` | Governs |
| --- | --- | --- | --- |
| `localEventProbability` | 0.008 | 0.008 | Local MarketEvent, per Market per day |
| `globalEventProbability` | 0.006 | 0.006 | Global commodity-wide MarketEvent |
| `locationEventProbability` | 0.004 | 0.004 | Location-wide MarketEvent |
| `worldwideEventProbability` | 0.002 | 0.002 | Worldwide MarketEvent |
| `locationClosureProbability` | 0.001 | 0.0015 | Whole-port LocationClosure |
| `companyEventProbability` | 0.005 | 0.005 | CompanyEvent, per plain Company per day |

Raise any of these for a rowdier, shock-driven economy; lower them (or set
to `0`) to isolate the underlying stockpile-driven pricing with minimal
external noise -- useful when tuning §16.1/§16.2 in isolation.

The *magnitude* of each shock lives in its template list:

- **`Commodity.eventTemplates`** (`commodity.ts`, §3.2/§7.1) --
  `demandMultiplier`/`supplyMultiplier`/`durationDays` per named event,
  feeding both Local and Global MarketEvents. `makeCommodityEvents`
  generates a standard four-pack for any commodity without a fully bespoke
  list; add a bespoke entry to `BESPOKE_EVENT_TEMPLATES` for a specific
  commodity the way Crude Oil/Copper/Wheat/Gold already have.
- **`LOCATION_EVENT_TEMPLATES`** / **`WORLD_EVENT_TEMPLATES`** (`events.ts`)
  -- the commodity-agnostic Location-wide/Worldwide shock pool.
- **`AGENT_EVENT_TEMPLATES`** (`events.ts`) -- per-`TransportEvent`-kind
  magnitude/duration (§7.2). Also gated by **`Captain.agentEventProbability`**
  (default `0.005`, per-Captain constructor argument).
- **`COMPANY_EVENT_TEMPLATES`** (`events.ts`) -- dollar amounts per
  CompanyEvent; all one-off (`durationDays = 1`).
- **`LOCATION_CLOSURE_TEMPLATES`** (`events.ts`) -- `durationDays` per
  closure reason (4-10 days).

### 16.4 Route economics: travel cost, time, and profitability threshold

- **`Captain.minDailyReturnPct`** (default `0.02`, varied per-ship in
  `buildWorld.ts`'s default fleet via `0.012 + 0.002 * (i % 5)`) -- the
  profitability bar a route must clear (§6.2). The single biggest lever on
  how much trading volume the simulation generates overall.
- **`Captain.repositionReturnMultiplier`** (default `1.25`) -- how much
  stiffer the bar is for a speculative empty repositioning move vs. a trade
  already in hand.
- **Transport hardware** (`transport.ts`, per-instance or via
  `SHIP_CLASSES` presets, §5.1) -- `cargoCapacity`, `speedUnitsPerDay`,
  `fuelConsumptionPerUnitDistance`/`repositionFuelConsumptionPerDistance`,
  `fixedShipmentCost`, `fuelCapacity`.
- **Crew wages** -- `Crew.dailyWages` (default `0`) / `Sailor`'s default
  (`20`), owed only while `InTransit` (§6.3).

### 16.5 Contract economics

- **`CONTRACT_QUANTITY_MULTIPLIER`** (default `1.5`, `contracts.ts`) --
  scales how much a tendered Contract orders relative to `minStockpiles`.
  Calibrated jointly with the fleet-size ratio (`Simulation.md`).
- **`CONTRACT_BASE_FEE_RATE`** (default `0.05`) / **`CONTRACT_FEE_ESCALATION_BASE`**
  (default `10`) -- the delivery fee's base rate and how sharply it climbs
  as a Location's deficit deepens (§9).
- **`DEFAULT_CONTRACT_EXPIRY_DAYS`** (default `7`) / **`DEFAULT_SEVERE_DEFICIT_FRACTION`**
  (default `0.5`) -- how long an unclaimed Contract stays open, and how
  severe a deficit forces early replacement.
- **`Location.contractThresholdFraction`** (default `DEFAULT_CONTRACT_THRESHOLD_FRACTION
  = 1.5`, `location.ts`) -- the proactive-tendering trigger, as a multiple
  of `minStockpiles`.
- **`ContractFulfiller.contractTypes`** (`ContractType[]`, `faction.ts`) --
  which kinds of Contract a fulfiller accepts (`Company`'s default is
  `["Commodity"]`; `SoloTrader` overrides it to `[]`, disabling Contract
  participation entirely rather than via a separate boolean flag). Adding a
  second `ContractType` in the future (and a second kind of `ContractIssuer`
  besides `Location`) would let a fulfiller opt into some kinds and not
  others just by editing this list.
- **`Company.contractStrategy`** (default `"compare"`, §8.1) -- whether a
  Company prioritises Contracts over arbitrage, or weighs the two by
  expected profit per ship-day.

### 16.6 Faction- and fleet-level economics

- **`Company`/`SoloTrader`/`PirateBrigade` starting cash** -- how much
  capital a fleet has to work with; a low starting pool means early trades
  are capped by affordability rather than cargo capacity or route
  economics.
- **`PirateBrigade.raidFraction`** (default `0.10`) -- how much of a
  non-pooling victim's cash is stolen per attack (§8.2); `Location.fenceFraction`
  (default `0.5`, per-Location) -- how much of a seized cargo's market
  value a pirate actually recovers when fencing it.
- **`PirateBrigade.maxCarousingToAttack`** / `carousingCostPerCrew` /
  `carousingIncreaseByDay` / `maxCarousing` -- how often a pirate crew is
  too distracted by shore leave to raid a co-located victim.
- **`PirateBrigade.laziness`** (default `1`) -- how many days between
  re-scans of where target Companies' ships are concentrated.
- **`PoliceFleet.patrolIntervalDays`** (default `5`) / `numPoliceShips`
  (a `World` constructor option, default `3`; `buildWorld.ts` passes `0`)
  -- since neither class is part of the shipped world (§8.2-8.3), these
  only matter if a future world-building path constructs them directly.

### 16.7 Geography (indirect economic effects via travel time/fuel cost)

- **`WORLD_GEN_SEED`** (`2024`, `worldData.ts`) -- reseeds the *network's*
  independent `Rng` streams (locations, coordinates, routes -- §14); the
  network layout itself, not trading, changes with this. `World`'s own
  `seed` option (`buildWorld`'s default is `42`) separately reseeds the
  simulation's own trading/event randomness -- the one to change for a
  different *run* of the same world.
- **`generateCoordinates`'s `minDistance`** (default `200.0`) -- the
  minimum synthetic-map distance enforced between any two locations.
- **`ROUTE_TYPE_DISTANCE_SCALE`** (`routes.ts`: Air `1.0`, Sea `0.8`,
  Land `0.5`) and `maxRouteDistance` (passed to `generateRoutes` /
  `buildWorld`, default `1000`) -- how far apart two locations can be and
  still get a direct Route of a given type. A smaller cap (or a smaller
  Land scale) prunes the network to a denser web of shorter hops,
  forcing more multi-hop Dijkstra routing.

## 17. The World editor (`editor/`)

`editor/` is a standalone Vite + React + Zustand app (package `editor`,
build/run with its own `npm run dev` / `npm run build` from inside the
folder) for authoring a world visually rather than procedurally. It is a
**separate build from the simulation** and cannot import from `src/`, so any
sim-side logic it needs is kept as a standalone copy under `editor/src/`
(e.g. `nameGenerators.ts` mirrors `names.ts`/`shipNames.ts`/`companyNames.ts`;
`distance.ts` mirrors `src/sim/distance.ts`). Keep the two copies in step.

What it authors:

- **Locations**: click the canvas to place one (a popup picks its owning
  PoliticalEntity, or cancels), drag to move, edit name (with a nationality-
  themed random-name generator), coordinates, fuel price, terminal types, and
  produce/consume commodity maps.
- **Routes**: shift-drag pin-to-pin to connect two Locations; shift-drag on a
  route to add Bezier control points. A header **auto-connect Sea routes**
  action bulk-connects sea-capable ports within an editable max distance,
  skipping a pair whose direct line passes near a third port ("detour
  distance") -- and will add a Sea route even where a route of another type
  already exists (the sim keeps one route per type per pair, §4.1).
- **Commodities / Companies / PoliticalEntities**: define the roster; generate
  a Company (name, captains, ships) per nationality; set each PoliticalEntity's
  **nationality** (§8.4) and type.
- **World-level**: world scale, and a **flat / globe distance mode** with an
  editable sphere radius and longitude span (§4.2), whose numbers drive the
  route-length readouts and the auto-connect thresholds live.

**Export / import.** The whole world round-trips as one JSON document
(`editor/src/worldJson.ts`, `WORLD_JSON_VERSION`): editor coordinates are
normalized `[0,1]` and stored as world positions (`× worldScale`) on the way
out, divided back on the way in; older files load with sensible defaults for
newer fields (distance mode, entity nationality). That exported JSON is
exactly what the simulation's `buildWorldFromJson` (§11.2) consumes.
