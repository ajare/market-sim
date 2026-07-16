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
- **UI** (EXP-8): `ExplorerPanel` (list + buy/sell form + "Choose next leg"),
  `DecisionModal` (the app's first blocking modal), store wiring, `Market` hut icon
  and `Trail` styling on the map.
- **JSON authoring + demo fixture** (EXP-9): `buildWorldFromJson.ts` extended
  (backward-compatibly) with `settlementType`/`ruler`/`explorers`; a hand-authored
  demo world (`src/sim/__fixtures__/exploreDemoWorld.ts`) pasteable via "Import
  World" for manual testing.

**Explicitly out of scope for this skeleton** (deferred on purpose, not oversights):
the advisor panel, fog-of-war, the pre-arrival village-encounter event, illness/
disease events, and any editor UI for authoring villages/explorers (JSON-only for
now).

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
- **Editor UI for authoring villages/explorers**: deliberately deferred (JSON-only
  path exists via EXP-9), but no design discussion has happened for what an
  editor-side authoring flow would even look like.
- **Advisor template content**: the tag/trust-tier line-bank *mechanism* is designed,
  but no actual advice text has been authored — this is a content gap, not a
  mechanics gap, once the advisor panel itself is built.
