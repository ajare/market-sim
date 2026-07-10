# Simulation tuning: fleet size vs. the stockpile target

This document records the empirical findings behind the TypeScript port's
default fleet-sizing calibration (`src/sim/buildWorld.ts`,
`src/sim/contracts.ts`) and the location-count and commodity-roster bounds
enforced by `World` (`src/sim/world.ts`), `commodity.ts`, and `worldData.ts`.
It complements `Architecture.md` (design) and `CLAUDE.md` (terse agent
guidance) with the *why* behind specific tuning constants that would
otherwise look like arbitrary magic numbers.

## The metric: stockpile ratio

The headline health metric for the whole economy is **stockpile ratio**:
mean `stockpile / minStockpile` across every consumed `(location,
commodity)` pair, averaged over a trailing window of days
(`stockpileRatio()` in `src/sim/analysis.ts`). A ratio of `1.0` means stock
sits right at its minimum target on average; `< 1` means locations are
chronically running below where they want to be (arbitrage and Contracts
together aren't keeping up with consumption); `> 1` means there's slack
capacity.

**This metric is high-variance and seed-sensitive.** A single run's number
carries roughly `±0.05` SD of pure Monte-Carlo noise -- changing the World's
dynamics seed alone (holding the fleet fixed) swings it by about as much as
changing the fleet size does, because fleet size reschedules the single
shared RNG stream (event rolls, the daily act-order shuffle) and shifts
every downstream draw for the rest of the run. **Never tune off a lone
run.** Average 8+ seeds per candidate value to see the real trend --
`averageStockpileRatio()` (`analysis.ts`) does this, and `npm run sweep`
(`src/sim/analysis.harness.ts`) is the CLI entry point for sweeping
candidate values:

```
SWEEP_SEEDS=16 SWEEP_SHIPS_PER_LOCATION="7,8,9,10" npm run sweep
```

## Finding 1: the location-funded contract redesign changed the calibration

The original fleet ratio (480 ships / 33 locations ≈ 14.5 ships/location, 96
companies) was calibrated *before* the Contract system was reworked to be
Location-funded with proactive tendering, urgency pricing, and one-shot
delivery (see the contracts-related sections of `Architecture.md` /
`CLAUDE.md` for that design). Once Contracts were fixed to actually clear
deficits reliably instead of deadlocking, that old ratio was massively
over-provisioned. A seed-averaged sweep at the *default* Contract tunables
found the crossover to `mean ratio ≈ 1.0` at:

| ships/location | mean | sd | n seeds |
| --- | --- | --- | --- |
| 7.5 | 0.950 | 0.038 | 16 |
| 8.5 | 0.982 | 0.042 | 16 |
| **9.0** | **1.004** | 0.060 | 16 |
| 9.25 | 1.015 | 0.042 | 16 |

i.e. **~295 ships / ~59 companies** -- already a ~38% reduction from the
480/96 default, just from the contract fixes.

## Finding 2: tweaking `quantityMultiplier` pushes the minimum much lower

`CONTRACT_QUANTITY_MULTIPLIER` (`src/sim/contracts.ts`) scales how much a
tendered Contract orders (`minStockpile * quantityMultiplier`). Raising it
from `1.0` to `1.5` means each delivery restocks 50% more per trip, closing
deficits faster with fewer ships:

| ships/location | quantityMultiplier | mean | sd |
| --- | --- | --- | --- |
| 7 | 1.0 (old default) | 0.947 | 0.052 |
| 7 | 1.5 | **1.129** | 0.040 |
| 7 | 2.0 | 1.215 | 0.064 |
| 7 | 2.5 | 1.292 | 0.062 |

Re-sweeping fleet size with `quantityMultiplier: 1.5` fixed found a new,
much lower crossover:

| ships/location | quantityMultiplier | mean | sd | n seeds |
| --- | --- | --- | --- | --- |
| 4.5 | 1.5 | 0.990 | 0.060 | 16 |
| 4.75 | 1.5 | 0.972 | 0.048 | 16 |
| **5.0** | **1.5** | **1.019** | 0.058 | 16 |
| 5.25 | 1.5 | 1.040 | 0.037 | 16 |

**These are now the shipped defaults**: `DEFAULT_TARGET_SHIPS_PER_LOCATION =
5` (`buildWorld.ts`) and `CONTRACT_QUANTITY_MULTIPLIER = 1.5`
(`contracts.ts`) -- **165 ships / 33 companies** for the default
33-location world, a ~65% reduction from the original 480/96, with the
stockpile target still comfortably held.

## Finding 3: the ratio does NOT generalize to a differently-sized world

"5 ships/location" is a calibration for *this specific* ~30-33-location
world, not a universal constant. Using `buildWorld`'s `locationNames`
option (which lets `generateLocations`/`generateRoutes` build a
differently-sized world) to sweep hub count while holding "5 ships/location
+ 1.5x quantity" fixed:

| hubs | total locations | mean ratio |
| --- | --- | --- |
| 10 | 13 | **0.607** |
| 15 | 18 | 0.866 |
| 20 | 23 | 0.905 |
| 25 | 28 | 0.988 |
| 30 (default) | 33 | 1.009 |
| 40 | 43 | 1.021 |
| 60 | 63 | 1.068 |

**Larger worlds are safe or even over-provisioned** -- the ratio holds and
drifts upward as the world grows (more producer/consumer pairs and route
diversity per ship). **Smaller worlds fall well short.**

Digging into the 10-hub case specifically: it's not simply "needs more
ships." Sweeping `targetShipsPerLocation` at a fixed 10-hub (13-location)
world plateaus well under target even at 3x the calibrated ratio:

| ships/location | mean ratio (10-hub world) |
| --- | --- |
| 5 | 0.607 |
| 7 | 0.716 |
| 9 | 0.812 |
| 11 | 0.844 |
| 13 | 0.886 |
| 15 | 0.882 |

This flattens around **~0.88**, never reaching `1.0` regardless of fleet
size. Below some location count, the bottleneck is structural, not
fleet-size: route/network diversity, producer-consumer pair scarcity per
commodity, the per-Company contract-claim cap (`contracts.length <
captains.length`, tied to headcount), and fixed per-shipment costs eating a
larger share of smaller trip volumes all compound at small scale in a way
more ships can't buy back.

## Finding 4: commodity roster size and per-location spread aren't invariant either

The same question was asked of the two commodity-related dimensions: does
changing the *total* commodity roster size, or how many commodities each
Location produces/consumes, move the ratio away from target? Both do,
confirmed via `buildWorld`'s new `commodities` and `commodityCountRange`
options (see below), holding the fleet at its calibrated defaults (5
ships/location, `quantityMultiplier: 1.5`).

**Total commodity count** (10 real commodities, extended with synthetic
ones for counts above 10) -- **non-monotonic**, a "sweet spot" the default
10-commodity roster sits comfortably inside:

| commodity count | mean ratio |
| --- | --- |
| 4 | **0.678** |
| 6 | 1.013 |
| 8 | 1.080 |
| 10 (default) | 1.065 |
| 15 | 1.034 |
| 20 | **0.924** |
| 25 | 0.934 |

Too few commodities (4) causes severe production/consumption collision
effects across locations (many locations converging on the same handful of
commodities); too many (20+) dilutes the fixed fleet's coverage per
commodity, since there are now far more distinct markets to service with
the same ship count.

**Per-location commodity spread** (how many commodities each Location
produces/consumes, commodity count held at the default 10) -- cleanly
**monotonic**, unlike total count:

| commodityCountRange | mean ratio |
| --- | --- |
| [1, 2] | **1.308** |
| [2, 3] | 1.066 |
| [2, 4] (default) | 1.065 |
| [3, 5] | 1.047 |
| [4, 6] | **0.989** |
| [5, 8] | **0.804** |

The wider the spread, the more distinct `(location, commodity)` pairs the
same fixed fleet has to cover, and the ratio degrades steadily as spread
widens -- there's no "too narrow" failure mode the way total count has one.

## Finding 5: the calibration holds over a full year, within the enforced bounds

Findings 1-4 were all measured over 90-day runs. To check whether that's
long enough to trust -- rather than an artifact of a short window before
some slower dynamic kicks in -- all three dimensions (commodity count,
per-location commodity spread, location count) were re-swept over **365
days** (still `windowDays: 30`, 8 seeds), restricted to the ranges the
validation guards above now actually allow (sweeping outside them just
throws, which is itself a useful confirmation the guards fire correctly).

**Total commodity count**, `[5, 25]`:

| commodity count | mean ratio (365d) | mean ratio (90d) |
| --- | --- | --- |
| 5 | 0.852 | -- |
| 6 | 0.922 | 1.013 |
| 8 | 0.998 | 1.080 |
| 10 (default) | 1.044 | 1.065 |
| 15 | **1.098** | 1.034 |
| 20 | 1.076 | 0.924 |
| 25 | **0.847** | 0.934 |

**Per-location commodity spread**, `[2, 6]`:

| commodityCountRange | mean ratio (365d) | mean ratio (90d) |
| --- | --- | --- |
| [2, 3] | 1.104 | 1.066 |
| [2, 4] (default) | 1.044 | 1.065 |
| [3, 5] | 1.047 | 1.047 |
| [4, 6] | 1.101 | 0.989 |
| [5, 6] | **0.943** | -- |

**Location count**, `[20, 50]`:

| hubs | total locations | mean ratio (365d) |
| --- | --- | --- |
| 17 | 20 | 1.015 |
| 20 | 23 | 0.980 |
| 25 | 28 | 1.075 |
| 30 (default) | 33 | 1.044 |
| 35 | 38 | 1.064 |
| 40 | 43 | 1.031 |
| 47 | 50 | 1.080 |

**Takeaway**: within the enforced bounds, the ratio stays close to `1.0`
(roughly 0.94-1.10 across all three dimensions) even over a full simulated
year -- there's no long-run drift toward collapse or runaway surplus that a
90-day window would have missed. The *exact* shape from Findings 1-4 shifts
a little with duration (e.g. the commodity-count sweet spot skews slightly
higher, toward 15-20 rather than 8-10, at 365 days than at 90), but the
qualitative story is unchanged: total commodity count is non-monotonic (a
sweet spot, with the *edges* of the allowed `[5, 25]` range -- 5 and 25 --
both back down near/below `1.0`), while spread and location count stay
comfortably inside target across their whole allowed ranges. This is a
mild caution that the *exact* optimum for any given dimension is somewhat
duration-dependent, but the ranges enforced by the validation guards remain
the right ones -- nothing here suggests widening or narrowing them.

## Finding 6: `minStockpileDays` has a U-shaped, non-monotonic effect

`minStockpileDays` (`src/sim/worldData.ts`) sets how many days of
consumption a commodity's `minStockpile` target represents
(`minStockpile = dailyRate * minStockpileDays`); at the time of this sweep
the default was `7.5` (`DEFAULT_MIN_STOCKPILE_DAYS`, the midpoint of the
random `U(5,10)` range this replaced -- see Finding 7 for why the default
later changed to `14`). Swept from `2` to `14` (12 seeds, 90 days,
fleet/commodity settings otherwise at their calibrated defaults):

| minStockpileDays | mean ratio | sd |
| --- | --- | --- |
| 2 | **1.555** | 0.128 |
| 3 | 1.369 | 0.085 |
| 4 | 1.151 | 0.080 |
| 5 | 1.163 | 0.081 |
| 6 | 1.173 | 0.045 |
| 7 (near default) | 1.155 | 0.058 |
| 8 | 1.178 | 0.032 |
| 9 | 1.163 | 0.045 |
| 10 | 1.193 | 0.043 |
| 12 | 1.214 | 0.029 |
| 14 | **1.249** | 0.047 |

The shape is **U-shaped, not monotonic in either direction**: very high (and
noisy -- SD 0.128 at `2` vs. 0.03-0.08 elsewhere) at small values, since a
tiny target is trivially easy to sit above; it drops sharply through 3-4,
bottoms out in a broad, low-noise plateau across roughly **4-9** (~1.15-1.19),
then climbs again from 10 upward as a bigger buffer gives the fleet more
slack time per restock cycle before a location actually runs low. `7.5`
(the then-default) sits inside that flat plateau -- in hindsight the most
stable, representative region to have calibrated the fleet ratio against,
rather than an arbitrary point on a slope. Every value tested across the
full `[2, 14]` range stayed comfortably above the `1.0` target, so *on this
metric alone* this looked like a mild optimization surface, not a fragility
point the way Findings 3-4's lower bounds are -- but see Finding 7, which
measured a much more decisive effect on a different, more granular metric.

## Finding 7: `minStockpileDays` has a much bigger effect on zero-stockouts specifically

The mean stockpile ratio in Finding 6 is an aggregate -- it averages over
every day, including all the ones a pair sits comfortably above target, so
it's built to answer "is the network roughly balanced," not "how often does
any single commodity actually run completely dry." To answer that second
question directly, every consumed `(location, commodity)` pair's daily
stockpile history was scanned for runs of exactly `0` (10 seeds, 365 days,
fleet/commodity settings at their calibrated defaults), across the same
`minStockpileDays` range as Finding 6:

| minStockpileDays | zero-day rate | episodes | mean episode length | max episode length | pairs that ever hit 0 |
| --- | --- | --- | --- | --- | --- |
| 2 | **43.6%** | 26,546 | 5.40d | 38d | 90/90 |
| 4 | 24.4% | 18,987 | 4.23d | 36d | 90/90 |
| 7.5 (then-default) | 8.2% | 6,940 | 3.89d | 42d | 90/90 |
| 10 | 4.3% | 3,623 | 3.90d | 28d | 90/90 |
| 14 | **2.1%** | 1,589 | 4.39d | 22d | 77/90 |

Unlike Finding 6's mild U-shape, this is **clean, monotonic, and dramatic**:
going from `2` to `14` cuts the zero-stockout rate by **>20x** (43.6% ->
2.1%), and at `14`, 13 of the 90 pairs *never once* hit zero across a full
simulated year (vs. every single one at every lower value tested). Notably,
the *frequency* drops sharply but the *length* of each individual episode
barely changes (~4-5 days throughout, no clear trend) -- a bigger buffer
means stockouts happen far less often, but once one starts, recovery still
takes roughly the same time, since that's governed by delivery-cycle
logistics (producer selection, fleet idle-capacity, transit time -- see the
producer-selection fix earlier in this project's history), not by how big
the buffer was that got drained.

**Consequence**: `DEFAULT_MIN_STOCKPILE_DAYS` (`src/sim/worldData.ts`) was
raised from `7.5` to **`14`** on the strength of this finding -- the
zero-stockout reduction is a far larger, more decisive effect than Finding
6's mild ratio movement, and `14` was the top of the range actually swept
(not extrapolated further). This does mean the aggregate ratio now runs
higher on average (~1.25 per Finding 6, up from ~1.16-1.18) -- more slack
than strictly needed to hit `1.0` -- but that's an accepted, deliberate
trade: fewer/rarer real stockouts in exchange for somewhat more standing
inventory. The fleet ratio itself was not re-tuned down to compensate; that
would be a reasonable follow-up sweep if the extra slack turns out to be
undesirable.

## Consequence: `commodity.ts` and `worldData.ts` enforce hard bounds too

Mirroring the location-count guard, `buildCommodities` (`src/sim/commodity.ts`)
throws if the total roster falls outside `[MIN_COMMODITIES,
MAX_COMMODITIES] = [5, 25]`, and `generateLocations` (`src/sim/worldData.ts`)
throws if `[minPerRole, maxPerRole]` falls outside `[MIN_COMMODITIES_PER_LOCATION,
MAX_COMMODITIES_PER_LOCATION] = [2, 6]`. Both ranges are drawn directly from
Finding 4 above: `25` and `6` are the widest values actually swept (not
extrapolated further), and `5`/`2` reflect where each metric was already
visibly degrading in the tables above.

## Consequence: `World` enforces a `[20, 50]` location-count range

Given the above, `World`'s constructor (`src/sim/world.ts`) throws if
`locations.length` falls outside `[MIN_LOCATIONS, MAX_LOCATIONS] = [20,
50]`. `20` is the empirically-supported floor (below it the target becomes
structurally unreachable regardless of fleet size); `50` is a conservative
ceiling reflecting that the sweeps only validated up to 60 hubs (63 total
locations) -- comfortably above 50, but 50 was picked as a known-good bound
rather than extrapolating further untested territory.

If the location roster ever changes (e.g. a future CSV-driven world), a
world outside `[20, 50]` needs its own re-calibration sweep (fleet ratio,
`quantityMultiplier`, and this range itself) rather than assuming the
current defaults hold -- see Finding 3.

## Finding 8: `contractStrategy` -- comparing contracts against arbitrage by profit doesn't hurt the ratio

Every finding above assumed the original dispatch rule: a `Company`
(`src/sim/faction.ts`) claims and services its due Contracts first, then
arbitrages with whatever ships are left over (`Company.directFleet`,
`contractStrategy = "prioritise"`). That's a reasonable default when
Contracts are assumed to matter more than any single arbitrage trade, but it
means a ship can be pulled off a strongly profitable arbitrage route to
service a barely-profitable contract just because the contract is due.

`contractStrategy = "compare"` (now the default) instead has each idle ship
weigh its best available Contract against its own best arbitrage route --
both expressed as expected profit per ship-day (`Captain.
estimateContractProfitPerDay` vs. `Captain.findBestLocalRoute`'s
`expectedProfit / travelDays`) -- and takes whichever pays more. A
still-open Contract is only actually claimed at the moment some ship commits
to it, rather than being claimed eagerly and held; a Contract no Company
ever finds worth taking just stays open for another Company, or expires and
re-tenders per the normal Contract lifecycle (`contracts.ts`).

Since this changes *which* ships end up servicing Contracts (and how many),
it was checked against the same stockpile-ratio metric the rest of this
document tunes against -- averaged over 8 seeds, 90 days, the calibrated
defaults otherwise unchanged (5 ships/location, `quantityMultiplier: 1.5`,
`minStockpileDays: 14`):

| contractStrategy | mean ratio | sd | min | max |
| --- | --- | --- | --- | --- |
| prioritise (old default) | 1.312 | 0.023 | 1.288 | 1.369 |
| **compare (new default)** | **1.416** | 0.032 | 1.359 | 1.467 |

`compare` is not a regression against the calibrated target -- if anything
it runs a bit higher and every seed clears `1.0` with room to spare. The
intuition: `compare` never diverts a ship onto a *marginal* contract when a
clearly better arbitrage trade is sitting right there, but it still services
every contract that's actually worth a ship's time (and, since dispatch is
now driven by whichever ship the trade is *most* profitable for rather than
whichever ship happened to be idle-in-port first, individual deliveries
tend to be better-targeted) -- so aggregate stock coverage comes out at
least as healthy, not worse.

This does not reopen the fleet-sizing calibration in Findings 1-2: the
165-ship baseline was never *tight* against `1.0` (see the tables above),
and `compare`'s effect is well inside that existing slack. If
`contractStrategy` or the fleet ratio are retuned further in the future,
re-sweep both together rather than assuming they're independent.

## How to re-run or extend these experiments

All the tunables used above are `buildWorld` options
(`src/sim/buildWorld.ts` / `src/sim/contracts.ts`):

```ts
buildWorld(3000, {
  targetShipsPerLocation: 5,                     // fleet size, ships per location
  contractOptions: { quantityMultiplier: 1.5 },  // and other TenderContractsOptions
  locationNames: [...],                          // world size / roster override
  commodities: buildCommodities([...], {...}),   // total commodity roster override
  commodityCountRange: [2, 4],                   // per-location produced/consumed spread
  minStockpileDays: 14,                          // days-of-consumption buffer minStockpile represents
  consumedStockpileFactor: 2.0,                  // starting stockpile, as a multiple of minStockpile
});
```

`averageStockpileRatio()` (`src/sim/analysis.ts`) accepts the same `build`
options plus a `seeds` array, `days`, and `windowDays`, and returns
`{ ratios, stats }` (mean/sd/min/max) -- the noise-aware way to read the
metric. Prefer it (or a throwaway harness built on it, gated behind its own
`vitest.config.ts` `include` so it doesn't run under `npm test`) over
reading a single `world.run()`'s stockpile numbers directly.
