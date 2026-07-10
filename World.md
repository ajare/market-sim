# World.md

A task-oriented map: "I want to change X — which file(s) do I actually
touch?" for the four things most people extend first (locations,
commodities, companies, events). It complements `Architecture.md` (the
full design writeup, cross-referenced by section below) and `Simulation.md`
(the empirical tuning history behind the calibrated defaults) — this doc is
deliberately shorter and more mechanical.

Everything below is the TypeScript implementation under `src/sim/`.

## Locations

| I want to... | Touch this |
| --- | --- |
| Add/remove a location from the default 30-hub roster | `worldData.ts`'s `LOCATION_NAMES` array |
| Add/remove a fuel depot | `worldData.ts`'s `FUEL_DEPOT_NAMES` array |
| Change how many commodities each location produces/consumes | `worldData.ts`'s `generateLocations()` -- the `minPerRole`/`maxPerRole` params (default `[2, 4]`), bounded by `MIN_COMMODITIES_PER_LOCATION`/`MAX_COMMODITIES_PER_LOCATION` (`[2, 6]`, also in `worldData.ts`) |
| Change starting stockpile sizes / production-consumption rates | `worldData.ts`'s `generateLocations()` -- the `U(3, 15)` rate roll, `minStockpileDays`/`consumedStockpileFactor` params |
| Change a location's produce/consume model, buy/sell rules, or its `cash` pool | `location.ts`'s `Location` class (`LocationInit`, `canBuy`/`canSell`/`dailyUpdate`) |
| Change how many locations the world requires overall | `world.ts`'s `MIN_LOCATIONS`/`MAX_LOCATIONS` (`[20, 50]`, throws outside this) |
| Change the network layout / how far apart locations sit | `worldData.ts`'s `generateCoordinates()` (`minDistance`, `WORLD_GEN_SEED`) |
| Change how Locations are grouped into Countries, or how many per Country | `worldData.ts`'s `assignCountries()` (proximity-based grouping, `DEFAULT_LOCATIONS_PER_COUNTRY = 5`) and `buildWorld.ts`'s `BuildWorldOptions.locationsPerCountry` |
| Change what a Country does (it currently only pools its members' cash) | `country.ts`'s `Country` class |
| Build a hand-authored world instead of the procedural one | Construct `Location` objects directly (see `contracts.test.ts`'s `makeLocation` helper) and pass them into `new World({ locations: [...] })` yourself, bypassing `buildWorld()` entirely -- there's no CSV/file-driven loader in this implementation |

Architecture.md §3.1 (Location model), §3.5 (procedural generation), §3.6
(`Country`), §10 (World's location-count validation).

## Commodities

| I want to... | Touch this |
| --- | --- |
| Add a brand-new commodity | `worldData.ts`'s `buildCommodities([...], {...})` call -- add its name and base price. Works with no further changes (it falls back to `DEFAULT_PRICE_SENSITIVITY`/`DEFAULT_DEFICIT_PRICE_BOOST`/a generic four-event pack) |
| Give a commodity bespoke price behavior | `commodity.ts`'s `PRICE_SENSITIVITY` / `DEFICIT_PRICE_BOOST` / `EXCESS_PRICE_BOOST` tables (keyed by name) |
| Give a commodity bespoke random events | `commodity.ts`'s `BESPOKE_EVENT_TEMPLATES` (fully custom, like Crude Oil/Copper/Wheat/Gold) or `GENERATED_EVENT_DRIVERS` (four driver phrases fed into the standard boom/disruption/glut/slump template shape) |
| Change the total commodity roster's allowed size | `commodity.ts`'s `MIN_COMMODITIES`/`MAX_COMMODITIES` (`[5, 25]`, throws outside this in `buildCommodities`) |
| Change the core stockpile-deviation pricing formula itself | `markets.ts`'s `Market.stockpilePrice()` -- rarely needed; almost everything commodity-specific is a per-commodity *table entry*, not a formula change |

Architecture.md §3.2 (stockpile-deviation pricing, deficit/excess boosts),
§7.1 (`MarketEvent` templates), §16.1 (tuning reference).

## Companies

| I want to... | Touch this |
| --- | --- |
| Change how many Companies/SoloTraders exist, or their fleet sizes | `buildWorld.ts`'s `BuildWorldOptions` -- `targetShipsPerLocation` (total fleet size), `shipsPerCompany`, `arbitrageShipFraction`, `companyFraction` (Company count as a fraction of `locations.length`, `[0.2, 0.5]`; `SoloTrader` count/size is a separate, untouched 50/50-style split -- see the fleet-sizing comment in `buildWorld()`) |
| Change starting cash per ship/Company | `buildWorld.ts`'s `cashPerShip` constant |
| Change which ship classes crew a Company's fleet | `transport.ts`'s `SHIP_CLASSES` (presets) -- `buildWorld.ts` rotates through `Object.keys(SHIP_CLASSES)` when assembling the fleet |
| Change a Captain's trading behavior (risk threshold, price impact, event exposure) | `captain.ts`'s `Captain` class -- `minDailyReturnPct`, `priceImpact`, `agentEventProbability`, `repositionReturnMultiplier`; per-ship values are set where `buildWorld.ts` constructs each `Captain` |
| Change how a Company coordinates its fleet's arbitrage routing | `faction.ts`'s `Company.directFleet` (route scoring/assignment, `remainingDemand`-capped route sharing) |
| Change how a Company decides between Contracts and arbitrage | `faction.ts`'s `Company.contractStrategy` (`"compare"` default vs. `"prioritise"`) and the `serviceContractsByProfit`/`claimOpenContracts`/`serviceContracts` methods it dispatches to |
| Change which Contract types a fulfiller can accept | `faction.ts`'s `ContractFulfiller.contractTypes` -- `Company`'s default is `["Commodity"]`; `SoloTrader` overrides it to `[]` (never accepts anything) |
| Add a genuinely new kind of Company (a third fleet-behavior variant) | Subclass `Faction`/`Company`/`ContractFulfiller` in `faction.ts`, override `directFleet`, then construct it in `buildWorld.ts` (or wherever else builds a `World`) |

Architecture.md §5.1 (Transport/`SHIP_CLASSES`), §6 (Captain), §8.1
(`Company`/`SoloTrader`), §9 (Contracts, `ContractFulfiller`), §11
(`buildWorld.ts`'s fleet-sizing math), §16.4/§16.6 (tuning reference).

## Events

| I want to... | Touch this |
| --- | --- |
| Change how *often* a given event kind fires | `world.ts`'s six probability fields (`globalEventProbability`, `localEventProbability`, `locationEventProbability`, `worldwideEventProbability`, `locationClosureProbability`, `companyEventProbability`) -- the actual shipped values are set where `buildWorld.ts` constructs `World` |
| Change how *big*/long a demand-supply shock is, per commodity | `commodity.ts`'s `BESPOKE_EVENT_TEMPLATES`/`GENERATED_EVENT_DRIVERS` (feeds Local + Global `MarketEvent`) |
| Change how big/long a location-wide or worldwide shock is | `events.ts`'s `LOCATION_EVENT_TEMPLATES` / `WORLD_EVENT_TEMPLATES` |
| Change per-ship mishaps (delays, cargo loss, cash swings, discounts) | `events.ts`'s `AGENT_EVENT_TEMPLATES`, and `captain.ts`'s `Captain.agentEventProbability` (per-Captain roll rate) / `maybeTriggerAgentEvent`/`applyAgentEvent` (effects) |
| Change whole-Company cash windfalls/setbacks | `events.ts`'s `COMPANY_EVENT_TEMPLATES` |
| Change port-closure reasons/durations | `events.ts`'s `LOCATION_CLOSURE_TEMPLATES` |
| Change *when in the day* an event kind is rolled, or add a new roll site | `world.ts`'s `runDay()` (the six `maybeTrigger*` calls) or `markets.ts`'s `Market.simulateDay` (the per-Market Local roll) |
| Add a genuinely new *kind* of event (not just retune an existing one) | Subclass `Event` in `events.ts`, decide where `subject`/`scope` get stamped, wire a trigger into `world.ts`'s `runDay` (or `Market.simulateDay` for finer-grained-than-daily) |

Architecture.md §7 (the whole event system, §7.1-§7.4 per kind), §10.1
(`runDay`'s trigger ordering), §16.3 (tuning reference -- all six
probabilities and every template list in one table).
