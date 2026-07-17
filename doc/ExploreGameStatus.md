# Exploration game: status

Snapshot of where the exploration mode stands: what's built and working, what's been
designed (see [ExploreGameIntegration.md](./ExploreGameIntegration.md)) but not yet
implemented, and what hasn't been designed at all yet (see
[ExploreGame.md](./ExploreGame.md) for the setting doc this all hangs off of). Ticket
tracking for the implemented work lives in
[ExploreGameTickets.json](./ExploreGameTickets.json).

## a) Implemented

All 9 tickets in `ExploreGameTickets.json` (EXP-1 through EXP-9) are done. Verified
via full test suite (267 tests, 33 files), `tsc -b`, lint, production build, and a
manual end-to-end pass through the running app. Concretely, this is a working
skeleton:

- **Prerequisite refactor** (EXP-1): cargo state moved off `Captain` onto `Transport`
  (`CargoState` + `cargo` field), via a proxy getter/setter so existing trade code
  didn't need a rewrite.
- **Shared types** (EXP-2): `Market` (`TerminalType`), `Trail` (`RouteType`),
  `PorterParty` (`TransportType`), `Tribe` (`PoliticalEntityType`), plus every
  exhaustive record that needed updating alongside them.
- **`PorterParty`** (EXP-3): foot/porter `Transport` subclass, `Trail`-only, no fuel,
  weight-based `cargoCapacity` scaling with `porterCount`/`animalCount`. `Transport`
  gained a second `inventory: Record<string, number> | null` field (a unified
  stockpile, distinct from `CargoState`) that only `PorterParty` populates.
  `Commodity.weightPerUnit` added (default 1.0, backward-compatible).
- **`Location.settlementType`/`ruler`, `Chieftain`** (EXP-4): settlement scale
  (Native village/Settlement/Town/Outpost, defaults to Town), an optional personal
  ruler whose authority takes precedence over the owning `PoliticalEntity`. Editable
  in the standalone World editor's Location inspector (a "Settlement type" dropdown).
- **`Explorer`** (EXP-5): `Person` subtype, boards its `PorterParty` immediately,
  player-picked single-leg movement (`departFor`/`tick`, no autonomous route
  planning), `buy`/`sell` against a `Market` (new, simple methods — no price-impact/
  fuel/contract machinery).
- **Decision infrastructure** (EXP-6): generic `Choice`/`PendingDecision` shape,
  `buildPassageTaxDecision` (ruler present → Pay/Offer gift/Haggle/Refuse with real
  probability rolls and persistent `Chieftain.trust`; `PoliticalEntity`-only fallback →
  fixed-rate Pay/Refuse), `buildLegChoiceDecision`.
- **World integration** (EXP-7): `World.explorers`/`pendingDecision`, ticked
  independently in `runDay`; a pending decision pauses the *entire* simulation
  (fixed a real bug along the way — `World.step()` was still advancing the day
  counter/calendar even when `runDay` no-op'd).
- **`ExpeditionParty`** (not an EXP ticket): `faction.ts`'s `FleetOwner` (Company/
  SoloTrader/PirateBrigade/PoliceFleet's Captain-and-Ship-specific machinery — cash
  pooling via `ownCash`, cargo/contracts, condition decay/sinking) was split from a
  new, generic `Faction<TMember>` core (constructor-time Transport-placement/
  crew-boarding, display-name deduping) via a minimal `FactionMember` structural
  interface, with `FleetOwner extends Faction<Captain>` — a zero-behavior-change
  refactor for every existing FleetOwner subclass. `ExpeditionParty extends
  Faction<Explorer>` is the new sibling: the exploration mode's SoloTrader
  analog, managing exactly one `Explorer` (in the "captain" role) commanding
  exactly one `PorterParty` (its Transport), `poolsCash = false` like SoloTrader. A
  pure wrapper today — an `Explorer` already boards its `PorterParty` and manages
  its own `cash` at construction (EXP-5), so `ExpeditionParty` doesn't move money or
  re-place anything; it's a Faction-shaped handle (`name`/`captains`/
  `politicalEntity`/`startingCash`) and the intended home for future porter-hiring
  machinery (not yet implemented — `PorterParty.porterCount`/`animalCount` are
  still fixed at construction, per EXP-3's own deferred scope). `World.explorers`
  is now a read-only derived getter over the authoritative `World.expeditionParties:
  ExpeditionParty[]`; `buildWorldFromJson.ts` wraps each JSON-authored Explorer in
  one.
- **Multi-commodity `CargoState`** (not an EXP ticket -- "Round A" of the
  Explorer/Captain unification decided in this same conversation): `CargoState`
  changed from single-commodity to `{ items: CargoItem[], origin, destination,
  distance, routeType, travelDays, fuel*, totalCost, departureDay }` (each `CargoItem`
  carrying its own `commodity`/`quantity`/`unitCost`/`contract`) -- applied to EVERY
  Transport (Ship included), not just PorterParty. `Captain.findBestLocalRoute`
  is now a destination-first greedy knapsack (rank every profitable commodity at a
  candidate destination by per-unit margin, fill `cargoCapacity`/cash margin-first)
  instead of picking one commodity at a time -- a Ship can now carry a genuine mix
  of goods in one voyage. `sellCargoIfPossible`/`fenceCargoIfPossible`/
  `maybeSmuggle`/`fulfillContract`, `FleetOwner.netWorth`/`loseCargoAndCash`/
  `PirateBrigade.attack`, and `Company.direct`'s per-route demand capping were
  all generalized to loop per item. `Transport.inventory` (PorterParty's old
  separate multi-commodity stockpile) was removed from the base `Transport` class;
  `PorterParty` keeps a private, PorterParty-only `inventory` field used only by
  `Explorer.buy`/`sell` and `buildPassageTaxDecision`'s gift-giving -- a deliberate,
  temporary gap (not yet migrated onto the new item-based `cargo`) left for Round B.
- **Round B** (done, same conversation): closed that gap. Rather than a shared base
  class (Captain's `company: FleetOwner` typing, its private `arrive()`, and Sailor's
  wage/rank/piracy fields all make literal inheritance a bad fit for Explorer) or a
  mixin (unprecedented in this codebase), Captain's route-scoring/execution math was
  extracted into a new `src/sim/tradingAgent.ts` -- free functions
  (`findBestBundle`/`routeEconomicsFromPath`/`reverifyBundle`/`applyPurchases`/
  `sellCargoShared`/`buySingleCommodity`/`sellSingleCommodity`) parameterized over an
  explicit `TripCostParams` instead of methods reading `this`. Captain's own
  `routeEconomics`/`findBestLocalRoute`/`executeLocalRoute`/`sellCargoIfPossible`
  became thin wrappers over these (zero behavior change -- full suite passed
  unmodified before touching Explorer at all). `Explorer` now trades under the exact
  same rules (real price impact, capacity/cash limits, a `tradeLog`) via `cargo.items`
  -- `PorterParty.inventory` is gone entirely. `ExpeditionParty` gained
  `direct`/`aiControlled` (`faction.ts`) -- much simpler than `Company`'s (exactly
  one Explorer, so no idle-partitioning/fleet-wide demand capping), restricted to
  direct Trail-neighbor hops only (no multi-hop continuation -- matches Explorer's
  existing single-leg movement model). Also fixed a real, pre-existing bug along the
  way: `World.pendingDecision` is a single global slot, so two Explorers arriving at
  villages the same day would have had the second's passage-tax decision silently
  dropped forever (the guard blocks it, and `arrive()` never re-fires). Now only a
  player-controlled party's arrival ever touches that field; an `aiControlled` one
  resolves its own decision immediately (`decisions.autoResolveDecision` -- picks the
  first eligible choice, i.e. "pay if affordable, else fall through") and never
  contends for it. `JsonExplorer.aiControlled` (optional, default false) makes this
  reachable via hand-authored World JSON; the standalone `editor/` UI doesn't
  author it yet (flagged as a follow-up, same as the rest of exploration-mode editor
  authoring).
- **UI** (EXP-8): `ExplorerPanel` (list + buy/sell form + "Choose next leg"),
  `DecisionModal` (the app's first blocking modal), store wiring, `Market` hut icon
  and `Trail` styling on the map.
- **JSON authoring + demo fixture** (EXP-9): `buildWorldFromJson.ts` extended
  (backward-compatibly) with `settlementType`/`ruler`/`explorers`; a hand-authored
  demo world (`src/sim/__fixtures__/exploreDemoWorld.ts`) pasteable via "Import
  World" for manual testing.

**Explicitly out of scope for this skeleton** (deferred on purpose, not oversights):
the advisor panel, fog-of-war, the pre-arrival village-encounter event, and illness/
disease events.

**Editor UI for authoring villages/explorers** (not an EXP ticket, built directly
against this doc's own gap list): `editor/`'s standalone World editor now authors
both natively, no JSON hand-editing required. `LocationInspector` gained a "Ruler
(exploration mode)" checkbox that installs/removes an `EditorChieftain` (name,
passage-tax %, trust, gift-category checkboxes drawn from the registered
commodities) on the selected Location. A new `ExplorersPanel` (mirrors
`CompaniesPanel`'s rollup-card list) authors `EditorExplorer`s -- name, home
Location, porter/animal counts, starting cash. Both round-trip through
`worldJson.ts`'s export/import (schema bumped to version 11) and are consumed by
`buildWorldFromJson.ts`'s existing `ruler`/`explorers` parsing (already in place
since EXP-9's demo fixture). Deleting a Location cascades to any Explorer whose
home it was (no fallback home Location, unlike a Company).

**`ExpeditionParty.direct`'s default AI switched from profit-seeking route search to
random wandering, trading opportunistically along the way** (not an EXP ticket): an
`aiControlled` party no longer picks its destination for profit -- once idle, it picks
a uniformly random direct Trail neighbor (excluding closed Locations), then decides
what (if anything) to carry there using the exact same mechanism Captain uses (price
impact, capacity/cash limits, margin-first allocation -- see new
`Explorer.planTradeTo`/tradingAgent.ts's `allocateBundleForDestination`, which scores
ONE given destination instead of searching for the best one). A `TradeDirective` if
anything has a positive margin, a bare `REPOSITION` Directive otherwise (still moves
there empty-handed). Stops for good the moment its `cash` reaches zero, or while still
sitting on unsold cargo from a previous trip (mirrors the pre-wander design).
`Explorer.findBestLocalRoute` (the destination-searching version) still exists and
still works (exercised directly in tests, and part of the `Leader` interface) -- it's
just not what this default AI calls anymore. New `Explorer.reachableNeighbors`/
`departToward` support the random pick and its execution.

## b) Designed, not yet implemented

Fully discussed and recorded in `ExploreGameIntegration.md`, with concrete mechanics
agreed — these are "next in line," not open questions:

- **Advisor panel**: 5 fixed slots, drawn from `PorterParty` crew or village hires
  (join-crew-then-promote), fixed shared expertise-tag taxonomy, visible-but-fallible
  trust rating, replaces the flat risk hint entirely on every decision. Advice text
  comes from per-(tag × trust-tier) template pools plus an independent
  "opinionatedness" trait governing personal-line vs. generic-pool selection.
  Village-hiring: randomly generated per-village candidate pool, quality-scaled
  pricing, exempt from passage tax, but a hostile enough chieftain/tribe can block it
  outright.
- **Fog of war**: routes exist as fixed data but are hidden — partially visible by
  default (existence known, destination unknown), fully revealed either for free by
  asking locals at a settlement, or via a *native* advisor's origin-tied local
  knowledge elsewhere. Villages are a separate discovery fact from their route
  (invisible until specifically confirmed by advisors/locals). Rendering: fading stub
  near the origin for partial routes; undiscovered villages render nothing at all
  (no placeholder marker).
- **Explorer's discovery log**: extends the existing `ShipLogEntry`/`recordShipLog`
  pattern (already relocated to `log.ts` in EXP-5) with day-by-day narrative entries
  for discoveries/decisions — narrative only, not the source of truth for map state
  (a separate discovered-IDs set drives rendering).
- **Village encounter event** (pre-arrival): a separate event from passage-tax
  negotiation — enter openly / send a scout (costs a day, personal risk to the scout,
  reveals true danger/trust) / bypass entirely (free, no risk, forfeits the village).
- **Illness/disease events**: `PersonEvent` on the Explorer only (crew illness doesn't
  pause the game); real death stakes; choices are rest / use quinine (inventory-gated)
  / push on / consult the medical advisor; wet season raises probability via the
  existing weather system.
- **`PersonEvent`/`TransportEvent` split**: the existing (currently dormant, per
  `world.ts`'s "events are disabled" comment) `TransportEvent`/`activeAgentEvents`
  system needs to genuinely split into person-scoped and transport-scoped kinds, and
  move off `Captain` onto `Transport`/`Person` respectively — the same kind of fix as
  the `CargoState` move, not yet done. Random rolling would be re-enabled only for
  the new exploration-specific kinds.

## c) Not yet designed

Real gaps — either flagged as open follow-ups during design, or areas of
`ExploreGame.md` never discussed at all:

- **Win condition / scoring**: the doc frames the core loop as discovery/mapping for
  institutes and governments, but no mechanic exists yet for *cataloguing*
  flora/fauna/geology/peoples, reporting findings, or any progress/scoring system.
  This is probably the single biggest remaining design gap — everything built so far
  is infrastructure (movement, trade, one decision), not the actual win condition.
- **Death/game-over conditions beyond illness**: conflict with hostile chieftains,
  wild animal encounters (`ExploreGame.md`'s Fauna section lists several dangerous
  species), disease other than the wet-season fever mechanic, general expedition
  failure states.
- **Shared "decision interface" for `Chieftain`/`PoliticalEntity`**: flagged as an
  explicit open follow-up in the `ruler` design — so calling code can treat
  `location.ruler ?? location.politicalEntity` uniformly instead of the current
  ad-hoc branching inside `buildPassageTaxDecision`. Also: the `PoliticalEntity`
  fallback has no `trust` field at all (a known, accepted gap from EXP-6) — refusing/
  haggling with a ruler-less village has no persistent consequence today.
- **`ExploreGame.md`'s empty sections**, never discussed in the integration
  conversation: Habitation, Daily life and social structure, Chieftain's
  responsibilities (beyond passage tax), Customs, Religion and beliefs, Bush
  societies, Politics & diplomacy, Education & literacy, and the broader "Gifts"
  customs (court obligations, medical attention requests, intelligence/warnings from
  chiefs) beyond the single passage-tax gift option already built.
- **Inter-tribal conflict and how it involves the player**: the doc describes
  tribes fighting each other, Westerners playing tribes off against each other
  (treaties, land claims, mercenary work) — none of this has been discussed as a
  player-facing mechanic.
- **Advisor template content**: the tag/trust-tier line-bank *mechanism* is designed,
  but no actual advice text has been authored — this is a content gap, not a
  mechanics gap, once the advisor panel itself is built.
